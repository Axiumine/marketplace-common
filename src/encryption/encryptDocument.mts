import { encryptAtNode } from '@encryption/encryptAtNode.mjs'
import { buildEncryptedFieldTrie } from '@encryption/encryptedFieldTrie.mjs'
import { IEncryptedFieldSpec } from '@encryption/IEncryptedFieldSpec.mjs'

/**
 * Encrypts a whole document against a declared field list, in place, and hands it back.
 *
 * The mirror of `decryptDocument`, and the one piece of the write side a caller outside a Mongoose
 * model can reach. Nothing in the nine services calls it: they write through the models, and
 * `fieldEncryptionPlugin` does this for them on `save` and `insertMany`.
 *
 * ⚠️ **It exists for the integration suites, and that is a security requirement rather than a
 * convenience.** Those suites seed with the raw driver on purpose — a document that goes through a
 * model is cast, defaulted and stripped by Mongoose before the server ever sees it, so a seed that
 * proves the collection's own `$jsonSchema` accepts a shape has to be written as bytes. Once the
 * personal fields are `binData`, a raw seed of plaintext is simply rejected, and the two ways out of
 * that are this function or seeding through the models — the second of which would also make the
 * suites unable to *detect* encryption at all, since the plugin decrypts on the way back and a
 * round-trip through it reads identically whether the field was stored as ciphertext or in the
 * clear. Raw in, raw out, and the assertion that what sits on disk is subtype 6, is the only
 * arrangement that tests the thing.
 *
 * The trie is rebuilt per call rather than cached. The lists are eleven entries at their longest and
 * the callers are test seeds, so the cost is nothing and a cache would be a branch to cover and a
 * mutant to kill for no gain.
 */
export async function encryptDocument<T>(document: T, fields: IEncryptedFieldSpec[], keyAltName: string): Promise<T> {
	return (await encryptAtNode(document, buildEncryptedFieldTrie(fields), keyAltName)) as T
}
