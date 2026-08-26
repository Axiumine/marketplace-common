import { throwTooManyRequestsError } from '@axiumine/koa-utils/graphQL/throw/throwTooManyRequestsError'
import { sha256Hex } from '@others/sha256Hex.mjs'

/**
 * The three commands this limiter issues, and nothing else.
 *
 * ⚠️ The client is a **parameter, not an import**. Reaching for `redisClient` from
 * `@axiumine/koa-utils/dataSources/Redis` here would pull the `redis` types into this package, and
 * `redis` is a dependency of the *services*, not of this library — declaring it as a seventh peer
 * dependency would put a Redis install behind every consumer of a Mongoose model. A structural type also
 * makes the limiter testable with three stubs instead of a live cluster.
 */
export interface IRateLimitStore {
	incr(key: string): Promise<number>
	ttl(key: string): Promise<number>
	expire(key: string, seconds: number): Promise<unknown>
}

/**
 * Fixed-window rate limiter, one Redis key per (bucket, identity, window).
 *
 * The platform had no rate limiting anywhere before this — every public auth path could be hammered at
 * line speed. Registration, login, password reset and verification-mail resend are the four that matter:
 * each one either mints a document, sends an email or tests a password, so an unbounded caller turns them into
 * a spam relay, an enumeration oracle and a bcrypt-powered CPU sink respectively.
 *
 * **Fixed window, not sliding.** A sliding window needs a sorted set per identity and a `ZREMRANGEBYSCORE`
 * on every call; a fixed window needs one integer. The cost is the classic boundary burst — a caller may
 * spend its whole allowance at the end of one window and again at the start of the next, so the real
 * worst case is `2 × limit` over a window's length. That is the right trade here: these limits exist to
 * make automation expensive, not to meter a paid API, and doubling a limit of 5 is still 10.
 *
 * **The key is single, deliberately.** Redis runs as a cluster in every deployed environment, so a
 * multi-key operation throws CROSSSLOT. `INCR` plus `EXPIRE` on one key is cluster-safe by construction.
 *
 * Callers pass the identity themselves rather than having it derived here: a mail resend limits by
 * email, a login by the same, and only the resolver knows which. **No caller passes an address** — the
 * per-address half of this is nginx's, keyed on `$binary_remote_addr` at the edge, because these
 * services never see a client address and `app.proxy` stays off so that they cannot.
 *
 * ⚠️ **`identity` is hashed into the key and `bucket` is not.** The limiter only ever tests equality —
 * it increments a counter and compares it to a ceiling, and never reads the identity back — so a digest
 * costs one `sha256` per call and changes no behaviour, while a `KEYS` scan, a slow log or the
 * append-only file stops being a list of the addresses that tried to register. The bucket stays readable
 * on purpose: `rl:loginUser:email:` remains a greppable prefix, so an operator can still count a bucket
 * without being able to name anybody in one. See `sha256Hex` for why this is pseudonymisation and not
 * anonymisation.
 *
 * ⚠️ **Never pass a raw password or token as `identity`.** The reason has changed and the ban has not:
 * it no longer lands in Redis in plaintext, but a bare digest of a low-entropy secret is precisely what
 * an offline attack wants, and one of a high-entropy one is a stable handle to a live credential.
 */
export async function assertUnderRateLimit(
	store: IRateLimitStore,
	bucket: string,
	identity: string,
	limit: number,
	windowSeconds: number
) {
	const key = `${process.env.REDIS_KEY}rl:${bucket}:${sha256Hex(identity)}`

	const count = await store.incr(key)

	// INCR on a missing key creates it with no TTL, so the window has to be armed by hand. Arming it on
	// every call would push the expiry forward on each request and never let the key die under sustained
	// traffic; arming it only when the counter reads 1 leaves the key immortal if the process dies between
	// the two commands, which locks that identity out for good. Checking the TTL covers both: it is
	// short-circuited away on the first call of a window, and on any later call it repairs a lost EXPIRE.
	if (count === 1 || (await store.ttl(key)) < 0) await store.expire(key, windowSeconds)

	if (count > limit) throw throwTooManyRequestsError()
}
