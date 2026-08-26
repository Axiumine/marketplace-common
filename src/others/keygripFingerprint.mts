import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'
import { sha256Hex } from '@others/sha256Hex.mjs'

/**
 * The public name of a key set: `sha256(ids joined by ':')`, first 12 hex characters (ADR-034).
 *
 * ⚠️ **Computed over the key *ids*, never over the key material.** A fingerprint is written into Redis in
 * the clear, returned by `keygripStatus` and read by an operator off a screen; a digest of the secrets
 * would be a digest of a value drawn from a 512-bit random space — unbreakable, but also one bad refactor
 * away from being a digest of something guessable, and there is no reason to take that shape at all. Two
 * services holding the same array agree on this string without either of them touching a key.
 *
 * It answers the question the whole ADR is about — *do the five services agree?* — in a form a human can
 * compare at a glance, which 64 hex characters is not. 12 characters is 48 bits; the values compared are
 * this platform's own sequential ids rather than attacker-chosen input, so collision resistance is not
 * what is being bought here, legibility is.
 *
 * ⚠️ **The seed script in `marketplace-db-setup` duplicates this line in CommonJS** and must keep
 * producing the same string — same separator, same slice. A drift there does not corrupt anything, but it
 * makes the holders table permanently disagree with the record it is reporting on.
 */
export const keygripFingerprint = (keys: readonly IKeygripKeyMaterial[]) =>
	sha256Hex(keys.map((key) => key.id).join(':')).slice(0, 12)
