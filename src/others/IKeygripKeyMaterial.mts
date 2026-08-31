/**
 * One cookie-signing key, as it is stored inside the wrapped Redis record (ADR-034).
 *
 * The array of these is what `Keygrip` is built from, **newest first**: `cookies` signs with index 0 and
 * verifies against every entry, so the order is not cosmetic — it decides which key writes and which keys
 * merely still open what earlier ones wrote.
 *
 * ⚠️ **`material` is the secret itself**, base64 of 64 random bytes, and it exists in the clear only
 * inside a process that already holds `KEYGRIP_KEK`. It is never logged, never returned by a resolver and
 * never written to Redis unwrapped; `keygripStatus` answers with `id` and `createdAt` and the
 * record fingerprint, which is the whole reason this interface separates them.
 *
 * `id` is a short opaque label — `k1`, `k7` — and is what the fingerprint is computed over, so two
 * services holding the same keys agree on a fingerprint without either of them hashing key material.
 * `createdAt` is ISO-8601 and drives the retirement decision at rotation time: a key older than the
 * longest session this platform issues can no longer be verifying anything.
 */
export interface IKeygripKeyMaterial {
	id: string
	material: string
	createdAt: string
}
