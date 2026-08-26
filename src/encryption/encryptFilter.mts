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
 * Operators that ask about the field rather than its value, and so are legal on any encrypted field
 * under any algorithm. `$exists` reads presence; `$type` reads the BSON type, which for an encrypted
 * field is `binData` and nothing else.
 */
const VALUE_FREE_OPERATORS = new Set(['$exists', '$type'])

function unsupported(key: string, detail: string): Error {
	return new Error(`Cannot query the encrypted field "${key}": ${detail} (ADR-029)`)
}

async function encryptOperand(key: string, operand: Record<string, unknown>, node: IEncryptedFieldNode, keyAltName: string) {
	for (const operator of Object.keys(operand)) {
		if (VALUE_FREE_OPERATORS.has(operator)) {
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
