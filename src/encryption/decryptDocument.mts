import { decryptValue } from '@encryption/fieldEncryption.mjs'
import { isCiphertext } from '@encryption/isCiphertext.mjs'
import { isPlainObject } from '@encryption/isPlainObject.mjs'

/**
 * Replaces every piece of ciphertext in a result with its plaintext, in place.
 *
 * ⚠️ **This is deliberately map-free.** It decrypts whatever is a `binData` of subtype 6, wherever
 * it finds it, instead of walking the declared field list. That is the more robust half of the
 * arrangement and the reason the read side has no counterpart to the write side's "did you remember
 * to add the field" risk: a field that gets encrypted comes back decrypted whether or not anyone
 * wrote it down, and a projection that returns half a document decrypts the half it returned. The
 * write side cannot work this way — it has to be told what to encrypt, because plaintext looks like
 * every other value.
 *
 * Handles both shapes a query can return. `.lean()` gives plain objects, which is what almost every
 * call site on the platform asks for; a hydrated document keeps its values in `_doc`, one bag per
 * nested schema, and is walked through those bags for the reason above.
 *
 * Exported for the same reason `encryptDocument` is: the service integration suites read stored
 * documents with the raw driver so the assertion is about what MongoDB really holds, and once a
 * personal field is ciphertext the only honest form of that assertion is "this is subtype 6, and it
 * decrypts to the value the mutation was given". Nothing in the nine services calls it — they read
 * through the models, and `fieldEncryptionPlugin` calls it for them on every query hook.
 */
export async function decryptDocument(value: unknown): Promise<void> {
	if (Array.isArray(value)) {
		await Promise.all(value.map(async (entry) => await decryptDocument(entry)))
		return
	}

	if (typeof value !== 'object' || value === null) {
		return
	}

	if (!isPlainObject(value)) {
		// Anything with an identity of its own: a hydrated document, an ObjectId, a Date, a Buffer.
		// Only the value bag is walked, and only where there is one — reading and writing `_doc`
		// directly is what keeps decryption from marking every personal path modified, which a
		// `doc.login.email = '…'` assignment would, sending the plaintext back on the next `save()`.
		// Everything else has no `_doc`, so this resolves to `undefined` and the value is a leaf.
		await decryptDocument((value as { _doc?: unknown })._doc)
		return
	}

	await Promise.all(
		Object.entries(value).map(async ([key, entry]) => {
			if (isCiphertext(entry)) {
				value[key] = await decryptValue(entry)
				return
			}

			await decryptDocument(entry)
		})
	)
}
