import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Per-process HMAC key, generated once and never leaving this module: not read from an env var, not
 * exported, not logged, not written to Redis. A restart replaces it, which is harmless because it is
 * only ever compared against itself inside a single call.
 */
const KEY = randomBytes(32)

/** The 32-byte HMAC of one operand. A value that is not a string is folded to the empty string. */
const digest = (value: string | string[] | undefined) =>
	createHmac('sha256', KEY)
		.update(typeof value === 'string' ? value : '')
		.digest()

/**
 * Compares two secrets in constant time, and answers `true` only when they are the same string.
 *
 * ⚠️ **This is the double-HMAC construction, not a byte-wise comparison, and the difference is the
 * point.** `===` on two strings stops at the first differing character, so the time it takes is
 * proportional to how many leading characters the caller guessed right — a few thousand requests turn
 * that into the configured value, one character at a time. Hashing both operands under a key the caller
 * cannot know destroys that gradient: every candidate produces a digest unrelated to how close it was.
 *
 * ⚠️ **There is no size check and no early exit here, deliberately.** `timingSafeEqual` refuses operands
 * of unequal width, and the obvious way to satisfy it — comparing the two sizes first and answering
 * `false` when they differ — reinstates a one-bit leak of the configured value's size and a second timing
 * branch on top of it. Two HMAC digests are 32 bytes for every input that exists, so the requirement is
 * met *structurally*: the leak is removed rather than padded around. Padding is the weaker answer, since
 * a padding scheme has to be written correctly and can leak through its own boundary.
 *
 * ⚠️ **The key is HMAC, not a bare digest, for a reason worth keeping.** `sha256(candidate)` is a value
 * an attacker who can submit candidates computes offline and precomputes tables of; `hmac(K, candidate)`
 * with a `K` that exists only in this process is not.
 *
 * ⚠️ **`createHmac`, never `createHash`.** `sha256Hex` is the only `createHash` call in this package and
 * stays that way — it is the *pseudonymisation* primitive, this is the *comparison* one, and a test in
 * `others.test.mts` pins the count so the two cannot quietly merge.
 *
 * An absent operand and a repeated HTTP header (which arrives as an array) both fold to the empty string
 * rather than being rejected up front, so a caller sending nothing takes exactly the path a caller
 * sending a wrong value takes. The consequence a call site has to know is that **two absent operands
 * compare equal**: comparing a candidate against a secret that is unset, and so folds to the empty
 * string too, answers `true` for a caller who sent nothing at all. A call site that reads its secret
 * from configuration owes a check that the secret exists, and this function will not make it for it.
 *
 * ⚠️ **What this does not fix.** Constant time on a JIT runtime is best-effort — this removes the
 * algorithmic leak, not every microarchitectural one — and nothing here decides who may reach the
 * comparison in the first place. It is the comparison primitive, never an access control.
 */
export function constantTimeEquals(a: string | string[] | undefined, b: string | string[] | undefined) {
	return timingSafeEqual(digest(a), digest(b))
}
