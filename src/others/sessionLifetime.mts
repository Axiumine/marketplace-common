/**
 * How long a session may live, and how wide the concurrent-refresh race is. Three numbers, all decided
 * 2026-08-10, all read by code that branches on them — which is what keeps every one of them killable
 * by mutation rather than needing a suppression.
 *
 * ⚠️ **None of these is a `Tier`-keyed map, and one must not be introduced.** A map whose three entries
 * hold the same number cannot be tested: a mutant that reads the wrong tier's entry returns the same
 * value, no test that could exist kills it, and mutation score 100 becomes reachable only through a
 * `Stryker disable` this workspace does not allow. The distinction this platform actually makes is
 * `rememberMe`, not tier. If the tiers ever diverge, the map arrives with the story that makes them
 * diverge.
 */

/**
 * The absolute age cap, in days, of a session whose login left "remember me" unchecked.
 *
 * An unchecked login is a shared-device login and dies overnight. This is the cap that applies when the
 * argument is absent or is not a boolean as well — see `resolveSessionCapDays`.
 */
export const SESSION_CAP_DAYS_DEFAULT = 1

/**
 * The absolute age cap, in days, of a session whose login ticked "remember me".
 *
 * Not an estimate: it is the promise all three login forms have been making since they were written,
 * enforced server-side for the first time. It is also the widest exposure left open here — a remembered
 * session survives thirty days of pure inactivity, which is thirty days of useful life for a refresh token
 * whose theft is never noticed. That is what the reuse tombstone and the family revocation are carrying.
 *
 * ⚠️ **30 < 90 deliberately.** `REFRESH_TOKEN_EXPIRY` in `@axiumine/koa-utils` stays the physical Redis
 * TTL and remains the safety net under both caps, never the binding limit. Raising this past 90 would
 * invert that.
 */
export const SESSION_CAP_DAYS_REMEMBERED = 30

/**
 * How long after a refresh token is consumed a second presentation of it is treated as a lost race
 * rather than as theft, in seconds.
 *
 * The race is bounded by one request round trip, not by how long a tab sits idle: the refresh token is a
 * root-scoped `HttpOnly` cookie, so every tab shares one cookie jar and a tab waking an hour later sends
 * whatever cookie is current. The only way to present a consumed token is to have dispatched before the
 * winner's `Set-Cookie` was written — milliseconds on a desktop, low single digits on a poor mobile
 * link. Ten covers that several times over.
 *
 * ⚠️ **The two directions are not symmetric, which is why this is not 1 or 2.** Too narrow and ordinary
 * multi-tab use revokes the whole family — a legitimate user logged out of every session they have. Too
 * wide and an attacker replaying a stolen token inside the window is told to retry instead of tripping
 * the revocation; they gain no tokens either way, because the grace branch mints nothing. A wide window
 * costs *detection*, a narrow one costs *the user*.
 *
 * ⚠️ **The grace-hit counter may justify lowering this; raising it needs a written reason.** Past roughly
 * a minute the tombstone stops functioning as reuse detection at all.
 */
export const GRACE_SECONDS = 10

/**
 * One day in milliseconds — the unit `sessionCapDays` is counted in, converted where the cap is compared.
 *
 * A unit conversion rather than a policy number: the two caps above are decisions, this one is arithmetic
 * and is here only so the comparison does not carry a bare `86_400_000`.
 */
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The cap a login resolves for the session it is about to mint, from the `rememberMe` argument the four
 * login mutations already carry.
 *
 * ⚠️ **Only `true` buys the long cap.** Absent, `undefined`, `null`, `'true'`, `1` — anything that is
 * not the boolean — takes the short one, so an omitted or malformed argument fails towards the shorter
 * session rather than the longer. The GraphQL layer declares it `Boolean!` and all three forms bind a
 * real checkbox to it; this is the second lock, for the callers that are not those forms.
 */
export const resolveSessionCapDays = (rememberMe: unknown): number =>
	rememberMe === true ? SESSION_CAP_DAYS_REMEMBERED : SESSION_CAP_DAYS_DEFAULT

/**
 * The instant a session stops being usable, in epoch milliseconds: the login it descends from plus its
 * cap. Both arguments are the strings Redis stores them as.
 *
 * ⚠️ **One expression, two readers, and that is the point.** `resolveAuthorizationSession`
 * refuses a session past this instant; `indexSession` gives its index field a TTL that ends at it. Two
 * copies of the arithmetic could drift by a rounding, and the failure would be silent in the worse
 * direction — an index row outliving the session it names is a listing an admin cannot act on, and an
 * index row dying first is a live session listed nowhere.
 *
 * ⚠️ **`originalLogin`, never the current token's mint.** Rotation carries it forward untouched, which is
 * what makes the cap absolute rather than a sliding window a refreshing client can extend for ever.
 */
export const sessionCapDeadline = (originalLogin: string, sessionCapDays: string) =>
	Number(originalLogin) + Number(sessionCapDays) * MILLISECONDS_PER_DAY

/**
 * How much of a session's absolute cap is left, in whole seconds, floored at one.
 *
 * ⚠️ **Rounded up, never down.** A field that expires half a second early is a live session listed
 * nowhere — the exact orphan the index key's TTL exists to prevent — while one that expires half a second
 * late is a row naming a session that has just stopped working. The first is a revocation that misses;
 * the second is a stale line on a screen.
 *
 * ⚠️ **Never zero and never negative.** Redis reads a non-positive hash-field TTL as "delete the field
 * now", which is the right answer for a session already past its cap but the wrong shape for a caller to
 * depend on: one second is the shortest TTL the command takes, and it self-heals within that second.
 * Neither login nor rotation can reach that state — a login stamps `originalLogin` at the moment it
 * writes, and a rotation past the cap is refused before it mints anything — so this floor is what a
 * direct caller gets, not a branch the platform walks.
 */
export const sessionCapRemainingSeconds = (originalLogin: string, sessionCapDays: string) =>
	Math.max(1, Math.ceil((sessionCapDeadline(originalLogin, sessionCapDays) - Date.now()) / 1000))
