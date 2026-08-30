import { createHash } from 'node:crypto'

/**
 * SHA-256 of `value`, lower-case hex. **The only hashing primitive in this package** — anything else
 * that needs a digest wraps this rather than reaching for `createHash` again, so there is one place to
 * change if the algorithm ever moves and one place a reviewer has to read.
 *
 * It exists so that a value which is only ever *compared* never has to be *stored*. The rate limiter is
 * the first caller: `assertUnderRateLimit` increments a counter and tests it against a ceiling, and
 * never reads the identity back, so the identity can be a digest for the same cost as one `sha256` per
 * call.
 *
 * ⚠️ **This is pseudonymisation, not anonymisation, and nothing here may be described as the latter.**
 * An email address, a username or a token id is drawn from a guessable space, so a bare digest of one is
 * recoverable by dictionary attack against whoever holds the dump. What it removes is *casual*
 * disclosure — the admin running `KEYS`, the append-only file read by anyone who can read the volume,
 * the support engineer looking at a slow log. The form that survives an attacker holding the dump is an
 * HMAC under a managed key, which needs key custody this platform does not have yet.
 *
 * ⚠️ **It does not normalise, trim or lower-case its input, deliberately** — `A@x.it` and `a@x.it` are
 * two different digests. Normalisation belongs to the caller that also decides what a value *means*: the
 * resolvers already lower-case and trim an email before both the account lookup and the limiter see it,
 * and folding that in here would let this function silently disagree with the query the account is
 * matched by.
 */
export function sha256Hex(value: string) {
	return createHash('sha256').update(value).digest('hex')
}
