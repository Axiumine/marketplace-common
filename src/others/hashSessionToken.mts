import { sha256Hex } from '@others/sha256Hex.mjs'

/**
 * The Redis key body for a session token: its lower-case SHA-256 hex digest.
 *
 * ⚠️ **A token used to be the key name itself.** A dump, an `AOF` file, a `MONITOR` transcript or a
 * slow-log entry was therefore a list of live credentials in plain text, readable by anyone who could
 * read the volume — no decryption, no lookup, present them and you are logged in. Hashing the namespace
 * costs one `sha256` per lookup and turns every one of those into a list of digests.
 *
 * ⚠️ **Hash the value that is actually used as a key, prefix included.** `verifySignedRefreshToken`
 * returns `` `refresh:${token}` ``, and the access token keeps its `access:` prefix from the moment it is
 * minted — so the input here is `access:…` or `refresh:…`, never the bare uuid. Hashing the unprefixed
 * value produces a key that never matches and a platform that never authenticates, which is the failure
 * this note exists to prevent.
 *
 * ⚠️ **A named wrapper over `sha256Hex`, deliberately not a second digest helper.** Two copies of a
 * hashing primitive is how the encodings end up disagreeing — one `hex`, one `base64url`, both correct
 * in isolation and neither able to read the other's keys. The name earns its own file because the
 * *reason* differs from the rate limiter's: there the digest exists so an identity need never be stored,
 * here it exists so a credential need never be a key name.
 *
 * ⚠️ **This is not encryption and does not make a token secret.** A token is a 128-bit random value, so
 * a digest of one is not recoverable by dictionary attack the way a digest of an email address is — but
 * anyone holding a *live* token can compute its key and read the session. What it removes is the reverse
 * direction: the store no longer hands out credentials to whoever reads it.
 */
export function hashSessionToken(value: string) {
	return sha256Hex(value)
}
