import { createDecipheriv } from 'node:crypto'

import { KEYGRIP_IV_BYTES, KEYGRIP_TAG_BYTES } from '@encryption/wrapKeygripKeys.mjs'
import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'

/**
 * Unwraps the Redis record back into the key array, or throws (ADR-034).
 *
 * The two lengths come from `wrapKeygripKeys` rather than being restated here, on purpose: they are one
 * format, and a copy of `12` in the reader is a copy that can be changed without the writer noticing —
 * which reads at runtime as every service on the platform refusing to boot at once.
 *
 * ⚠️ **Every failure lands here as a throw, and every one of them means the same operational thing**: the
 * `KEYGRIP_KEK` this process holds is not the one the record was written under. A truncated blob, a tag
 * that does not verify, a version that does not match the AAD, base64 that decodes to nothing — GCM does
 * not distinguish "wrong key" from "tampered", and neither should the caller. `loadKeygrip` turns all of
 * them into one refusal to boot, which is the only safe answer: a service that cannot read the fleet's
 * signing keys and starts anyway would mint cookies nobody else can verify.
 *
 * ⚠️ **The parse is deliberately unvalidated.** Nothing checks that the JSON is an array of the declared
 * shape, because the tag already did: only a holder of the KEK can produce bytes that decrypt, so a
 * successful unwrap says the record was written by this platform's own seed or rotate path. Adding a
 * shape check here would add branches that no reachable input can take, and the one thing that *is*
 * checked — that the array is not empty — belongs to `loadKeygrip`, where the boot decision is made.
 */
export function unwrapKeygripKeys(wrapped: string, version: number, kek: Buffer): IKeygripKeyMaterial[] {
	const raw = Buffer.from(wrapped, 'base64')
	const iv = raw.subarray(0, KEYGRIP_IV_BYTES)
	const tag = raw.subarray(KEYGRIP_IV_BYTES, KEYGRIP_IV_BYTES + KEYGRIP_TAG_BYTES)
	const ciphertext = raw.subarray(KEYGRIP_IV_BYTES + KEYGRIP_TAG_BYTES)

	/*
	 * ⚠️ `authTagLength` is passed explicitly. Without it node accepts a *truncated* tag — GCM verifies
	 * against 8 bytes as readily as against 16, with nothing but a deprecation warning, at 2^64 instead of
	 * 2^128 to forge. The layout only yields a short tag on a blob shorter than 28 bytes, so what this buys
	 * is a rejection on the length rather than a confusing authentication failure four calls later.
	 */
	const decipher = createDecipheriv('aes-256-gcm', kek, iv, { authTagLength: KEYGRIP_TAG_BYTES })

	// utf8 by default on both, matching the writer — see the note there on why neither is named.
	decipher.setAAD(Buffer.from(String(version)))
	decipher.setAuthTag(tag)

	return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString())
}
