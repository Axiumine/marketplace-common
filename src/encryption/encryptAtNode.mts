import { IEncryptedFieldNode } from '@encryption/encryptedFieldTrie.mjs'
import { encryptValue } from '@encryption/fieldEncryption.mjs'
import { isCiphertext } from '@encryption/isCiphertext.mjs'
import { isPlainObject } from '@encryption/isPlainObject.mjs'

/**
 * Encrypts everything under `node` that the field map says is encrypted, and returns the value to
 * store in its place.
 *
 * The value handed in is whatever the caller was going to write — one scalar, one array element, a
 * whole `personalData` sub-document, the whole `addresses` array. The node says where in the map
 * that value sits, and the walk does the rest. That is what lets `$set: { personalData: {…} }` and
 * `$set: { 'personalData.contacts.email': '…' }` share one implementation: they are the same tree,
 * entered at different depths.
 *
 * ⚠️ `null` and `undefined` pass through unencrypted, deliberately. Every one of these fields is
 * optional somewhere — `notes` is absent on most shop owners, `landline` on most people — and
 * encrypting an absent value would turn "this person gave no landline" into a `binData` that decrypts
 * to nothing, at which point `$exists` stops meaning what it says.
 */
export async function encryptAtNode(value: unknown, node: IEncryptedFieldNode, keyAltName: string): Promise<unknown> {
	if (value === null || value === undefined) {
		return value
	}

	if (node.algorithm !== undefined) {
		// Already ciphertext: a value read out of the database and written straight back. Encrypting
		// it again would produce a `binData` that decrypts to a `binData`.
		return isCiphertext(value) ? value : await encryptValue(value, node.algorithm, keyAltName)
	}

	if (Array.isArray(value)) {
		if (node.element === undefined) {
			return value
		}

		const element = node.element
		return await Promise.all(value.map(async (entry) => await encryptAtNode(entry, element, keyAltName)))
	}

	if (isPlainObject(value) && node.children !== undefined) {
		for (const [key, child] of node.children) {
			if (Object.hasOwn(value, key)) {
				value[key] = await encryptAtNode(value[key], child, keyAltName)
			}
		}
	}

	return value
}
