import { throwRefreshTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwRefreshTokenExpiredOrDeleted'
import { assertRefreshLineage } from '@others/assertRefreshLineage.mjs'
import { assertTier } from '@others/assertTier.mjs'
import { IRefreshData } from '@others/IRefreshData.mjs'
import { ITombstoneData } from '@others/ITombstoneData.mjs'
import { ISessionFamilyStore, revokeSessionFamily } from '@others/revokeSessionFamily.mjs'
import { graceHitsKey, readSessionHash, tombstoneKey } from '@others/sessionKeys.mjs'
import { GRACE_SECONDS, sessionCapDeadline } from '@others/sessionLifetime.mjs'
import { throwRefreshRaceRetry } from '@others/throwRefreshRaceRetry.mjs'
import { isTier, Tier } from '@others/Tier.mjs'
import { Types } from 'mongoose'

/**
 * The Redis commands this resolver's paths may issue — the whole set, not one of them.
 *
 * **On the path that resolves a session, `hGetAll` is still the only command**, run once against the
 * hashed session key. Everything else below belongs to a path that has already found something wrong:
 *
 * - a miss reads the reuse tombstone with a second `hGetAll`, and `incr`s the grace counter when the
 *   token turns out to have been consumed seconds ago;
 * - a replay past the grace window, and a session past its absolute age cap, both delegate to
 *   `revokeSessionFamily`, which costs `sMembers` plus one `del` per member plus one for the set —
 *   1 + N commands, on the request that discovered a theft rather than on the auth path —
 *   and, when the revocation can be attributed to an account, three more (`lPush`, `lTrim`, `expire`) to
 *   append the reuse event that explains it.
 *
 * ⚠️ **Keep this list and the interface below in step.** It once read "the single Redis command this
 * resolver issues", written when there was one and left alone when there stopped being one — which is
 * how a docstring becomes a claim a reader sizes the auth path by and is wrong. Anything that adds a
 * command here — the session index did — widens the interface, and the widening is the moment to rewrite
 * this paragraph rather than append to it.
 *
 * ⚠️ The client is a **parameter, not an import**, for the same reason `assertUnderRateLimit` takes
 * one: reaching for `redisClient` from `@axiumine/koa-utils/dataSources/Redis` here would pull the
 * `redis` types into this package, and `redis` is a dependency of the *services*, not of this
 * library — declaring it as a seventh peer dependency would put a Redis install behind every
 * consumer of a Mongoose model.
 *
 * ⚠️ It **extends** `ISessionFamilyStore` rather than taking a second store parameter. There is exactly
 * one implementation and it is the same `redisClient`, so a second parameter would mean passing that
 * object twice at all three call sites to buy a segregation nothing consumes. The segregation that was
 * worth having is the one `revokeSessionFamily` keeps: it is declared against the narrow interface and
 * is testable against a stub with no `hGetAll` on it at all.
 */
export interface ISessionReadStore extends ISessionFamilyStore {
	hGetAll(key: string): Promise<Record<string, string>>
	/** The grace counter, and nothing else — see `graceHitsKey`. */
	incr(key: string): Promise<unknown>
}

/**
 * Answers a refresh token that no live session backs, when a tombstone says it was consumed.
 *
 * Runs **only on a miss**, so the resolving path pays nothing for it. Three outcomes:
 *
 * - **no tombstone** — an ordinary expired or revoked session; this returns and the caller refuses the
 *   token with the 498 an expired session earns;
 * - **consumed within `GRACE_SECONDS`** — the loser of an ordinary multi-tab race. It is counted and told
 *   to retry, and **the family is not touched**: revoking here would log a legitimate user out of every
 *   session they have because two tabs loaded at the same moment;
 * - **consumed before that** — a replay. The whole lineage dies and the caller gets the same 498 an
 *   expired session gets, so a replayer learns nothing from the response about what tripped.
 *
 * ⚠️ **A malformed tombstone takes the replay exit, not the grace one.** `Number(undefined)` is `NaN` and
 * every comparison against `NaN` is false, so a tombstone missing `consumedAt` falls through to the
 * replay branch — the fail-closed direction. One missing `familyId` is all that is skipped there: there
 * is no lineage to name, so there is nothing to revoke, and the token is still refused.
 *
 * ⚠️ **The account is read off the tombstone, and a tombstone that carries none still revokes.**
 * By the time a replay is detected the session hash the token named is gone — the rotation that wrote this
 * marker deleted it — so `_id` and `tier` are recoverable from nowhere else. A marker written before those
 * fields existed, or one whose `tier` is not one of the three constants, therefore loses its reuse event
 * and keeps its revocation: the trail is the explanation, never the mechanism.
 */
async function assertNotReplayed(store: ISessionReadStore, refreshToken: string): Promise<void> {
	// Spread first: a nullish reply and a hash with no `Object.prototype` both have to be readable here,
	// for the reason `readSessionHash` spells out.
	const tombstone: Partial<ITombstoneData> = { ...(await store.hGetAll(tombstoneKey(refreshToken))) }

	// An absent tombstone is an ordinary expired or revoked session, and this early return is what says so.
	//
	// ⚠️ The `false` mutant of this condition is equivalent, which is why it is annotated rather than tested.
	// With no tombstone every field read below is `undefined`: `Number(undefined)` is `NaN`, so the grace
	// test is false, and `familyId` is `undefined`, so nothing is revoked — the fall-through lands on the
	// same `throwRefreshTokenExpiredOrDeleted` the caller throws when this returns, and the two paths differ
	// only in which frame throws it. The `true` mutant *is* live — it would skip the replay branch for a
	// tombstone that exists, and the replay case kills it — but Stryker names both variants with one
	// mutator, so the annotation cannot spare it.
	// Stryker disable next-line ConditionalExpression: an absent tombstone falls through to the same 498, so returning early is unobservable
	if (Object.keys(tombstone).length === 0) return

	if (Date.now() - Number(tombstone.consumedAt) <= GRACE_SECONDS * 1000) {
		await store.incr(graceHitsKey())

		throw throwRefreshRaceRetry()
	}

	if (tombstone.familyId !== undefined) {
		await revokeSessionFamily({
			store,
			familyId: tombstone.familyId,
			account:
				isTier(tombstone.tier) && tombstone._id !== undefined ? { tier: tombstone.tier, accountId: tombstone._id } : undefined,
			action: 'refreshTokenReplayed'
		})
	}

	throw throwRefreshTokenExpiredOrDeleted()
}

export interface IResolveAuthorizationSessionInput<TAccountData extends object> {
	store: ISessionReadStore
	/**
	 * The refresh token as `verifySignedRefreshToken` returned it — which carries the `refresh:` prefix
	 * already, and must, because that prefix is hashed *into* every key built from it.
	 */
	refreshToken: string
	/** The tier *this* service serves. A session minted for any other one is refused. */
	tier: Tier
	/** Re-reads the account and returns whatever this tier's access-token hash carries besides `_id` and `tier`. */
	readSessionData: (_id: Types.ObjectId) => Promise<TAccountData>
}

export type TAuthorizationSession<TAccountData extends object> = TAccountData & {
	_id: string
	tier: Tier
	refreshToken: string
} & Pick<IRefreshData, 'familyId' | 'originalLogin' | 'sessionCapDays' | 'accessKey'>

/**
 * Turns a verified refresh token into the session an authorization service puts on `ctx.state.user`.
 * There is no outcome in which it answers without one: a token no live session backs is refused.
 *
 * This is the body all three `*-authenticated-authorization` services carried a copy of. What is
 * shared is the *order* of the steps, and every one of them is load-bearing:
 *
 * - **The session is read through `readSessionHash`, never with a key built here.** The key is
 *   the digest of the prefixed refresh token, and it is the only shape a session has: the raw-key
 *   fallback that once sat behind this helper is gone, so a token that misses the digest
 *   is a token with no session.
 * - **The tier is asserted before the `_id` is looked up.** All nine services share one `REDIS_KEY`
 *   prefix — deliberately, because the single logout service finds a session by token content and
 *   cannot know which collection minted it — so a well-formed session found under this key may
 *   belong to another tier. The per-tier lookup that follows is *not* a substitute: it only fails by
 *   accident, when the foreign id happens not to exist in this tier's collection too. A session with
 *   no `tier` at all predates the discriminator and is refused as well; see `assertTier`.
 * - **`tier` is stamped here, from the service's own constant**, not copied out of the hash and not
 *   supplied by the reader. The value that goes into the new session is the one this service just
 *   asserted against, so a reader cannot mislabel a session even by mistake.
 * - **A miss consults the reuse tombstone before anything else.** A token that no live
 *   session backs is either expired, revoked, or *consumed seconds ago* — and only the tombstone can
 *   tell the third case from the first two. Inside the grace window it is a lost multi-tab race and the
 *   client is told to retry; outside it, it is a replay, and the whole lineage dies before the caller
 *   gets its 498. See `assertNotReplayed`.
 * - **The lineage is asserted, and a session without one is refused rather than defaulted.**
 *   A session minted before those fields existed cannot be filed into a family, and
 *   inventing one would file every such session into the *same* family — where a single reuse event
 *   revokes unrelated accounts. See `assertRefreshLineage`.
 * - **The absolute age cap is checked before the account is read**, and it is measured from
 *   `originalLogin`, which no rotation ever moves — that is what makes the cap absolute rather than a
 *   long idle timeout. A session past it takes its whole family down with it, because a session this
 *   old is the shape a quietly stolen refresh token has.
 * - **A miss is the end of the road.** Once the tombstone has been consulted there is nothing else a
 *   token with no live session behind it can be: it is refused with `throwRefreshTokenExpiredOrDeleted`,
 *   the same 498 an expired session earns, so a caller learns nothing from the response about which of
 *   the two it was holding.
 */
export async function resolveAuthorizationSession<TAccountData extends object>({
	store,
	refreshToken,
	tier,
	readSessionData
}: IResolveAuthorizationSessionInput<TAccountData>): Promise<TAuthorizationSession<TAccountData>> {
	const redSession = await readSessionHash(store, refreshToken)

	if (Object.keys(redSession).length === 0) {
		await assertNotReplayed(store, refreshToken)

		throw throwRefreshTokenExpiredOrDeleted()
	}

	// Redis returns an object with no Object.prototype in its prototype chain; spreading it gives an
	// ordinary one back before anything reads a property off it.
	const redData = { ...redSession }

	assertTier(redData.tier, tier)
	assertRefreshLineage(redData)

	const { familyId, originalLogin, sessionCapDays } = redData

	// The same deadline the index field's TTL is set to, from the same expression, so the row
	// that names a session cannot outlive the session or predecease it.
	if (Date.now() > sessionCapDeadline(originalLogin, sessionCapDays)) {
		// `tier` rather than `redData.tier`: the two were just asserted equal, and the one this service was
		// constructed with is the one no caller can influence — the same reason the returned session stamps it.
		await revokeSessionFamily({
			store,
			familyId,
			account: { tier, accountId: redData._id },
			action: 'sessionCapReached'
		})

		throw throwRefreshTokenExpiredOrDeleted()
	}

	const _id = redData._id
	const accountData = await readSessionData(new Types.ObjectId(_id))

	// ⚠️ **`accessKey` is carried, not asserted, and it is the one field here that may legitimately be
	// absent.** A session minted before it existed has none, and the rotation reads that as "nothing to
	// retire" — see `IRefreshData`. Nothing else may read it: it names the *current* access key, so a
	// resolver treating it as this request's own credential would be reasoning about a key it did not
	// present.
	return { ...accountData, _id, tier, refreshToken, familyId, originalLogin, sessionCapDays, accessKey: redData.accessKey }
}
