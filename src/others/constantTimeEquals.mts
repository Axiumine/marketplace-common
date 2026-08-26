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
 * rather than being rejected up front, so a request carrying no header at all takes exactly the path a
 * request carrying a wrong one takes. The consequence is that two absent operands compare equal; every
 * call site passes a configured value as the second one, and `${process.env.INTROSPECTION_CODE}` is the
 * literal `'undefined'` rather than the empty string when the variable is unset.
 *
 * ⚠️ **What this does not fix.** The code is still accepted from anywhere the port is reachable (a
 * topology problem, E13-S09), and constant time on a JIT runtime is best-effort — this removes the
 * algorithmic leak, not every microarchitectural one. E13-S11's environment gate additionally stops the
 * comparison running in production at all; this stays regardless, because development machines are
 * reachable too and a gate whose failure mode is "the timing leak comes back" is not one to rely on
 * alone.
 */
export function constantTimeEquals(a: string | string[] | undefined, b: string | string[] | undefined) {
	return timingSafeEqual(digest(a), digest(b))
}
