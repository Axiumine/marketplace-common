import { encryptAtNode } from '@encryption/encryptAtNode.mjs'
import { castPlaintext } from '@encryption/EncryptedField.mjs'
import { IEncryptedFieldNode, resolveEncryptedPath } from '@encryption/encryptedFieldTrie.mjs'
import { encryptFilter } from '@encryption/encryptFilter.mjs'
import { isPlainObject } from '@encryption/isPlainObject.mjs'

/**
 * Casts a value against `node`'s declared shape before it is encrypted — the same cast
 * `EncryptedField.cast()` applies on assignment through `save()`, restated here because the
 * plugin's `pre` hook runs before mongoose's own `_castUpdate` (see `castPlaintext`'s own comment).
 *
 * Mirrors `encryptAtNode`'s own walk — leaf, array, interior object — so a value is cast wherever it
 * arrives, not only when the dotted key that resolved to `node` names a leaf directly. That matters
 * because the platform's two `personalData` writers, `funUserPersonalDataUpdate` and
 * `funShopOwnerUpdate`, both `$set` the *whole* sub-document (`{ $set: { personalData } }`) rather
 * than one dotted leaf at a time — the key names an interior node, and a leaf-only cast would never
 * engage for either of them.
 */
function castAtNode(value: unknown, node: IEncryptedFieldNode, path: string): unknown {
	if (node.algorithm !== undefined) {
		return castPlaintext(value, node.plaintext, path)
	}

	if (Array.isArray(value)) {
		if (node.element === undefined) {
			return value
		}

		const element = node.element
		return value.map((entry, index) => castAtNode(entry, element, `${path}.${index}`))
	}

	if (isPlainObject(value) && node.children !== undefined) {
		for (const [key, child] of node.children) {
			if (Object.hasOwn(value, key)) {
				value[key] = castAtNode(value[key], child, `${path}.${key}`)
			}
		}
	}

	return value
}

/**
 * Operators whose operand is, field by field, the value to store. The two that matter here, and the
 * only two this platform writes with.
 */
const VALUE_OPERATORS = new Set(['$set', '$setOnInsert'])

/**
 * Operators that append to an array. The operand is either the element itself or a `$each` wrapper,
 * and either way it is an *element* — so it is encrypted against the array node's element child, one
 * level below where the key points.
 */
const ARRAY_APPEND_OPERATORS = new Set(['$push', '$addToSet'])

/**
 * Operators whose operand selects elements to remove, i.e. a filter rather than a value. Routed
 * through `encryptFilter` so the "random-encrypted fields cannot be matched" rule is stated once.
 */
const ARRAY_REMOVE_OPERATORS = new Set(['$pull'])

async function encryptValueMap(operand: unknown, root: IEncryptedFieldNode, keyAltName: string): Promise<void> {
	if (!isPlainObject(operand)) {
		return
	}

	for (const [key, value] of Object.entries(operand)) {
		const node = resolveEncryptedPath(root, key)
		if (node !== undefined) {
			operand[key] = await encryptAtNode(castAtNode(value, node, key), node, keyAltName)
		}
	}
}

async function encryptAppendMap(operand: unknown, root: IEncryptedFieldNode, keyAltName: string): Promise<void> {
	if (!isPlainObject(operand)) {
		return
	}

	for (const [key, value] of Object.entries(operand)) {
		const element = resolveEncryptedPath(root, key)?.element
		if (element === undefined) {
			continue
		}

		if (isPlainObject(value) && Array.isArray(value.$each)) {
			value.$each = await Promise.all(
				value.$each.map(
					async (entry, index) => await encryptAtNode(castAtNode(entry, element, `${key}.$each.${index}`), element, keyAltName)
				)
			)
			continue
		}

		operand[key] = await encryptAtNode(castAtNode(value, element, key), element, keyAltName)
	}
}

async function encryptRemoveMap(operand: unknown, root: IEncryptedFieldNode, keyAltName: string): Promise<void> {
	if (!isPlainObject(operand)) {
		return
	}

	for (const [key, value] of Object.entries(operand)) {
		const element = resolveEncryptedPath(root, key)?.element
		if (element !== undefined) {
			await encryptFilter(value, element, keyAltName)
		}
	}
}

/**
 * Rewrites an update so every personal value in it is ciphertext before it reaches the server, in
 * place.
 *
 * ⚠️ **An aggregation-pipeline update is left untouched, and that is a real limitation rather than
 * an oversight.** `updateOne(filter, [{ $set: … }])` is server-side computation over values the
 * client never sees, so there is nothing here to encrypt and no way to encrypt it — a `$filter` or a
 * `$concat` reading a `binData` reads a blob. The one such update on the platform,
 * `funUserAddressDel`, computes over `addresses[]._id` only, which is deliberately in the clear.
 * A pipeline update that touched a personal field would silently write a wrong value; if one is ever
 * needed, it has to be rewritten as a read, an encrypt and a plain `$set`.
 *
 * `$unset`, `$inc`, `$currentDate` and `$rename` are skipped because their operands are not field
 * values — `{ $unset: { notes: '' } }` names a field and discards the `''`. Encrypting them would
 * turn a valid update into a rejected one.
 */
export async function encryptUpdate(update: unknown, root: IEncryptedFieldNode, keyAltName: string): Promise<void> {
	if (Array.isArray(update) || !isPlainObject(update)) {
		return
	}

	for (const [key, operand] of Object.entries(update)) {
		if (VALUE_OPERATORS.has(key)) {
			await encryptValueMap(operand, root, keyAltName)
			continue
		}

		if (ARRAY_APPEND_OPERATORS.has(key)) {
			await encryptAppendMap(operand, root, keyAltName)
			continue
		}

		if (ARRAY_REMOVE_OPERATORS.has(key)) {
			await encryptRemoveMap(operand, root, keyAltName)
			continue
		}

		// A bare key: either a replacement document from `replaceOne`, or the shorthand Mongoose
		// expands to `$set`. Both are value maps, and both arrive here one field at a time.
		//
		// The operators handled nowhere above need no case of their own: no declared path begins with
		// `$`, so `$unset`, `$inc`, `$currentDate` and `$rename` resolve to nothing and fall out here
		// untouched — which is the required outcome, since their operands are field *names* rather
		// than values.
		const node = resolveEncryptedPath(root, key)
		if (node !== undefined) {
			update[key] = await encryptAtNode(castAtNode(operand, node, key), node, keyAltName)
		}
	}
}
