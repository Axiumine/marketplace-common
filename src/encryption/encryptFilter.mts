import { encryptAtNode } from '@encryption/encryptAtNode.mjs'
import { IEncryptedFieldNode, resolveEncryptedPath } from '@encryption/encryptedFieldTrie.mjs'
import { ALGORITHM_DETERMINISTIC } from '@encryption/EncryptionAlgorithm.mjs'
import { isPlainObject } from '@encryption/isPlainObject.mjs'

const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor'])

/**
 * Operators whose operand is a value of the field, and which deterministic ciphertext can answer.
 *
 * Equality is the entire list, in its two shapes. That is not a simplification — it is the property
 * deterministic encryption has and the only one it has.
 */
const VALUE_OPERATORS = new Set(['$eq', '$ne'])
const VALUE_LIST_OPERATORS = new Set(['$in', '$nin'])

/**
 * The one BSON type an encrypted field's ciphertext can ever be. `$exists` reads presence and needs
 * no value check at all; `$type` reads the BSON type, and the only value that can ever be true for an
 * encrypted field is this one — a caller who queries the field's original logical type (`'string'`,
 * `'date'`) gets an operand that matches nothing, silently, which is exactly the class of bug this
 * file otherwise throws to prevent.
 */
const ENCRYPTED_BSON_TYPE = 'binData'
const ENCRYPTED_BSON_TYPE_CODE = 5

function unsupported(key: string, detail: string): Error {
	return new Error(`Cannot query the encrypted field "${key}": ${detail} (ADR-029)`)
}

async function encryptOperand(key: string, operand: Record<string, unknown>, node: IEncryptedFieldNode, keyAltName: string) {
	for (const operator of Object.keys(operand)) {
		if (operator === '$exists') {
			continue
		}

		if (operator === '$type') {
			const type = operand[operator]
			if (type !== ENCRYPTED_BSON_TYPE && type !== ENCRYPTED_BSON_TYPE_CODE) {
				throw unsupported(key, `the stored BSON type is always "${ENCRYPTED_BSON_TYPE}", not "${String(type)}"`)
			}
			continue
		}

		if (node.algorithm !== ALGORITHM_DETERMINISTIC) {
			throw unsupported(key, `it is random-encrypted, so "${operator}" can never match`)
		}

		if (VALUE_OPERATORS.has(operator)) {
			operand[operator] = await encryptAtNode(operand[operator], node, keyAltName)
			continue
		}

		if (VALUE_LIST_OPERATORS.has(operator)) {
			const list = operand[operator]
			if (!Array.isArray(list)) {
				throw unsupported(key, `"${operator}" needs an array`)
			}

			operand[operator] = await Promise.all(list.map(async (entry) => await encryptAtNode(entry, node, keyAltName)))
			continue
		}

		throw unsupported(key, `deterministic ciphertext supports equality only, not "${operator}"`)
	}
}

/**
 * Rewrites a query filter so the values it compares against are ciphertext, in place.
 *
 * ⚠️ **This throws rather than degrading, and that is the design.** A filter that cannot be answered
 * against ciphertext — a `$regex` on a deterministic field, anything at all on a random one — does
 * not fail at the database: it runs, matches zero documents and returns an empty result, which reads
 * downstream as "no such account" or "this customer has no addresses". Every one of those is a
 * plausible answer, so the bug reaches production looking like data. Failing the call names the
 * field and the operator instead.
 *
 * A filter touching no encrypted field is left exactly as it was, which is almost every filter on
 * the platform — the six collections are queried by `_id`, by foreign key, by `deleted` and by
 * `published` far more often than by anything personal.
 */
export async function encryptFilter(filter: unknown, root: IEncryptedFieldNode, keyAltName: string): Promise<void> {
	if (!isPlainObject(filter)) {
		return
	}

	for (const [key, value] of Object.entries(filter)) {
		if (LOGICAL_OPERATORS.has(key)) {
			if (Array.isArray(value)) {
				await Promise.all(value.map(async (branch) => await encryptFilter(branch, root, keyAltName)))
			}
			continue
		}

		// `$expr`, `$text`, `$where` and friends need no case of their own. No declared path begins
		// with `$` and no node these walkers are ever handed carries an array element at its root, so
		// an operator key resolves to nothing and falls out here — which is also what keeps this walk
		// out of an aggregation expression, a tree it would misread. None of them can name an
		// encrypted field on this platform anyway: the two `$expr` validators compare `_id`s, and both
		// text indexes are on public company and item fields.
		const node = resolveEncryptedPath(root, key)
		if (node === undefined) {
			continue
		}

		if (node.algorithm === undefined) {
			// A query operator on a whole encrypted array or sub-document — `$elemMatch`, `$all`,
			// `$size`, an `$eq` wrapped around the object instead of the bare-object equality shape
			// below. `encryptAtNode` only ever rewrites values *named* by the field map's children, so
			// an operator key such as `$elemMatch` is invisible to it and the object it wraps — full of
			// plaintext — would otherwise reach `encryptAtNode` unrecognised and come back unchanged,
			// straight to the server. `$exists` is the one exception: it reads presence, not the value
			// inside, and is legal here exactly as it is on a leaf.
			if (isPlainObject(value)) {
				const operator = Object.keys(value).find((candidate) => candidate.startsWith('$') && candidate !== '$exists')
				if (operator !== undefined) {
					throw unsupported(
						key,
						`it is an encrypted array or sub-document, so "${operator}" cannot be evaluated against ciphertext`
					)
				}
			}

			// An interior node reached by an equality match on a whole sub-document, e.g.
			// `{ personalData: { firstName: …, lastName: … } }`. Encrypt what is inside it.
			filter[key] = await encryptAtNode(value, node, keyAltName)
			continue
		}

		if (isPlainObject(value) && Object.keys(value).some((operator) => operator.startsWith('$'))) {
			await encryptOperand(key, value, node, keyAltName)
			continue
		}

		if (node.algorithm !== ALGORITHM_DETERMINISTIC) {
			throw unsupported(key, 'it is random-encrypted, so an equality match can never succeed')
		}

		filter[key] = await encryptAtNode(value, node, keyAltName)
	}
}
