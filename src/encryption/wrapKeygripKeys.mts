import { createCipheriv, randomBytes } from 'node:crypto'

import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'

/**
 * The IV length this format writes, in bytes. 12 is the GCM standard: at that length the counter block
 * is used directly, and any other length has to be hashed into one first, which is both slower and a
 * shape no other implementation would guess when it reads a blob back.
 */
export const KEYGRIP_IV_BYTES = 12

/** The GCM tag length this format writes, in bytes. 16 is the full tag; a truncated tag is weaker. */
export const KEYGRIP_TAG_BYTES = 16

/**
 * Wraps the whole keygrip key array into the single opaque string that Redis holds (ADR-034).
 *
 * Layout of the base64 payload, and the reason it is one field rather than three: `iv(12) ‖ tag(16) ‖
 * ciphertext`. A hash with separate `iv`, `tag` and `ciphertext` fields can be half-written and half-read
 * — Redis has no transaction across a partial `HSET` failure that a reader would notice — and the failure
 * mode of reading a new ciphertext against an old tag is an unwrap error at boot on a service that was
 * running fine a second ago. One field is written or it is not.
 *
 * ⚠️ **The version is the AAD, not a field.** Authenticating it means a wrapped blob from version 3
 * cannot be replayed into the record after the version has moved to 4: the reader passes the version it
 * read from the hash, and a swapped-in older `wrapped` fails its tag against the newer number. Without
 * that binding, an attacker who can write to Redis but cannot decrypt anything could still roll the fleet
 * back to a retired key set by copying two strings — which is exactly the rotation this ADR exists to
 * make possible, run backwards.
 *
 * ⚠️ **`kek` is a parameter, not a read of `process.env` here.** This function is also the definition of
 * the format for the one caller that cannot import it — `marketplace-db-setup`'s seed script is CommonJS
 * and duplicates these twenty lines against `node:crypto` — and a function that reached for its own key
 * would hide which key each call used at exactly the moment an admin is trying to work out why two
 * services disagree.
 *
 * The plaintext is `JSON.stringify` of the array as given: **order is preserved and load-bearing**, index
 * 0 being the key that signs.
 */
export function wrapKeygripKeys(keys: readonly IKeygripKeyMaterial[], version: number, kek: Buffer): string {
	const iv = randomBytes(KEYGRIP_IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', kek, iv)

	/*
	 * ⚠️ No explicit `'utf8'` on either call, and that is not an omission: node falls back to utf8 for an
	 * unrecognised encoding name rather than throwing, so an encoding argument here is a string no test can
	 * prove is being honoured — it reads as a guarantee and provides none. The default is utf8 and the
	 * reader takes the same default, which is the one place the two have to agree.
	 */
	cipher.setAAD(Buffer.from(String(version)))

	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(keys)), cipher.final()])

	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}
