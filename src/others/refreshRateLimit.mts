import { assertUnderRateLimit, IRateLimitStore } from '@others/assertUnderRateLimit.mjs'
import { hashSessionToken } from '@others/hashSessionToken.mjs'

/**
 * What one rotation attempt costs an attacker, in two buckets (E14-S08).
 *
 * `refresh` was the one authenticated endpoint with no limiter of any kind: every other public auth path
 * had carried one since the rate limiter landed, while the mutation that mints credentials could be
 * hammered at line speed. The two buckets here meter two different phenomena and neither replaces the
 * other — a token that resolves to no family at all never reaches the second one, and a family that
 * rotates in a loop is invisible to the first.
 *
 * ⚠️ **No control in this file may key on a client address**, and none does: the identities are a token
 * digest and a family id. The per-address half is the edge's — `limit_req` on all three rotation
 * endpoints — under the standing decision that these services never see a client address (`app.proxy`
 * stays off). The residual that leaves, a flood of *distinct* garbage tokens each getting its own bucket,
 * is named and accepted in E14-S08 as closable only at the edge.
 *
 * ⚠️ **That hand-off assumed a boundary nobody had written down; one is written now.** The `limit_req`
 * rules exist and are tested; the host nginx runs on, and whether anything but nginx can reach these ports,
 * was the production topology recorded as owed by **ADR-032** until **ADR-039** (2026-08-28) superseded it —
 * Cloudflare at the edge, one application host behind a default-deny cloud security group, and the
 * datastores on a separate host on a private segment the platform owner declares trusted.
 *
 * ⚠️ **Neither bucket below is resized by that, by the new ADR's own requirement.** ADR-039 §5 narrows
 * the old standing rule rather than lifting it — a network boundary may be cited as a second layer and
 * never as the whole argument — and it names E14-S08 while keeping this limiter exactly as written. Both
 * buckets stay sized to be worth having with the port open to anyone. Of the three findings once bounded
 * by that one unknown, only R46 closed with the ADR — the introspection bypass (E13-S11) and the plaintext
 * Redis leg (R45) did not.
 *
 * ⚠️ **Both buckets are named `refresh:<something>` rather than one of them being bare `refresh`.** A bare
 * bucket would make `rl:refresh:` a prefix of `rl:refresh:family:`, so an admin counting one bucket
 * would silently count both.
 */

/** The bucket the pre-lookup limiter counts in — one counter per presented refresh token. */
export const REFRESH_ATTEMPT_BUCKET = 'refresh:token'

/**
 * Rotation attempts allowed per token per window, and the window, in seconds.
 *
 * ⚠️ **The tighter of the two limits, deliberately.** For a live token both buckets increment and the
 * smaller binds, so this one has to be the one that binds; its unique job is metering tokens that resolve
 * to no family at all — garbage, expired, tombstoned — where the family bucket is never reached.
 *
 * ⚠️ **60 seconds, not the platform's usual 3600.** This is the only Redis structure an attacker creates
 * at will, one key per distinct token, and each key is `rl:refresh:token:` plus 64 hex characters. At a
 * thousand distinct tokens a second a 60-second window holds roughly 60k keys, around 10 MB steady state,
 * where 3600 would hold 3.6M — a factor of sixty on precisely the vector with no other bound.
 */
export const REFRESH_ATTEMPTS_PER_WINDOW = 20
export const REFRESH_ATTEMPT_WINDOW_SECONDS = 60

/** The bucket the post-lookup limiter counts in — one counter per lineage. */
export const REFRESH_FAMILY_BUCKET = 'refresh:family'

/**
 * Token pairs a single lineage may **mint** per window, and the window, in seconds.
 *
 * ⚠️ **Mints, not requests.** A request that mints nothing — grace-served, rejected, rate-limited — must
 * not count, or an eight-tab wake-from-sleep burst spends sixteen of the allowance in one second and the
 * limit has to be loosened until it means nothing.
 *
 * ⚠️ **An hour, not a minute.** A 60-second window resets sixty times an hour, so a steady five rotations
 * a minute never trips it — and the pattern only an hour-long window can see is exactly the one this
 * bucket exists for. Family keys are bounded by real sessions rather than by attacker input, so the long
 * window costs nothing in memory. The number matches the platform's `RATE_WINDOW_SECONDS`.
 *
 * ⚠️ **20 an hour is generous, and counting mints is what makes it so.** All tabs share one root-scoped
 * cookie, so one winner rotates for all of them however many are open; a legitimate lineage mints once or
 * twice an hour whatever the tab count. Ten times headroom, and still low enough to end a rotation loop.
 */
export const REFRESH_MINTS_PER_WINDOW = 20
export const REFRESH_FAMILY_WINDOW_SECONDS = 3600

/**
 * The **pre-lookup** limiter: called from each authorization service's middleware, before the session
 * read, with the refresh token the request presented.
 *
 * ⚠️ **The identity is `hashSessionToken(token)`, not the token.** The ban on passing a raw token to
 * `assertUnderRateLimit` is absolute — see its docstring — and the digest is E13-S01's helper rather than
 * a second hashing call site, so the two never disagree about the algorithm. The limiter hashes what it
 * is given a second time to build the key; that is one `sha256` and changes nothing.
 *
 * ⚠️ **It takes the store as a parameter and the services pass `redisClient`**, exactly as
 * `guardPublicLogin` does. It is not folded into `resolveAuthorizationSession`: that would put a write
 * command on `ISessionReadStore`, whose whole point is that reading a session cannot write anything.
 */
export const guardRefreshAttempt = (store: IRateLimitStore, refreshToken: string) =>
	assertUnderRateLimit(
		store,
		REFRESH_ATTEMPT_BUCKET,
		hashSessionToken(refreshToken),
		REFRESH_ATTEMPTS_PER_WINDOW,
		REFRESH_ATTEMPT_WINDOW_SECONDS
	)

/**
 * The **post-lookup** limiter: called by `refreshSessionTokens` on the path that actually mints a pair,
 * with the lineage the session being rotated belongs to.
 *
 * ⚠️ **What this bucket does not buy, so it is not over-trusted.** A replayed tombstoned token triggers
 * E14-S03's family revocation on the first hit, so this limiter never sees sustained replay — the
 * detection path gets there first. Its value is bounding write load and rotation churn, not stopping an
 * attacker who already holds a valid token. `guardRefreshAttempt` is the one carrying weight.
 */
export const guardFamilyMintRate = (store: IRateLimitStore, familyId: string) =>
	assertUnderRateLimit(store, REFRESH_FAMILY_BUCKET, familyId, REFRESH_MINTS_PER_WINDOW, REFRESH_FAMILY_WINDOW_SECONDS)
