import { EncryptionAlgorithm } from '@encryption/EncryptionAlgorithm.mjs'
import { IEncryptedFieldSpec } from '@encryption/IEncryptedFieldSpec.mjs'

/**
 * The flat lists of `encryptedFields.mts`, indexed for walking.
 *
 * A node is one path segment. `algorithm` present means the segment is a leaf and its value is
 * encrypted; `children` are the named sub-fields; `element` is the single child every array element
 * shares. A node can have both an `algorithm` and children in principle — no field on this platform
 * does, and nothing here depends on it not happening.
 */
export interface IEncryptedFieldNode {
	algorithm?: EncryptionAlgorithm
	plaintext?: IEncryptedFieldSpec['plaintext']
	children?: Map<string, IEncryptedFieldNode>
	element?: IEncryptedFieldNode
}

const ARRAY_ELEMENT_SEGMENT = '[]'

/**
 * The four ways MongoDB spells "an element of this array" in a key.
 *
 * `addresses.0` in a filter, `addresses.$` in a positional update, `addresses.$[]` for all elements
 * and `addresses.$[named]` for a filtered set. All four mean the same thing to this trie, because
 * what is encrypted is the *field inside* the element and that does not depend on which element.
 */
function isArrayElementSegment(segment: string): boolean {
	// The closing bracket is unescaped on purpose: outside a character class it is already a literal,
	// and escaping it is what the redundant-escape inspection flags.
	return /^(\d+|\$(\[[^\]]*])?)$/.test(segment)
}

function childNode(node: IEncryptedFieldNode, segment: string): IEncryptedFieldNode {
	if (segment === ARRAY_ELEMENT_SEGMENT) {
		node.element = node.element ?? {}
		return node.element
	}

	node.children = node.children ?? new Map<string, IEncryptedFieldNode>()
	const existing = node.children.get(segment)
	if (existing !== undefined) {
		return existing
	}

	const created: IEncryptedFieldNode = {}
	node.children.set(segment, created)
	return created
}

/**
 * Turns the declared list into the tree the encrypt walkers descend.
 *
 * Built once per model at plugin time, never per query — the lists are module constants, so this is
 * pure setup cost paid at import.
 */
export function buildEncryptedFieldTrie(specs: IEncryptedFieldSpec[]): IEncryptedFieldNode {
	const root: IEncryptedFieldNode = {}

	for (const spec of specs) {
		let node = root
		for (const segment of spec.path.split('.')) {
			node = childNode(node, segment)
		}
		node.algorithm = spec.algorithm
		node.plaintext = spec.plaintext
	}

	return root
}

/**
 * Resolves a dotted key — from a filter, from a `$set`, from a projection — to its node, or
 * `undefined` when nothing along that path is encrypted.
 *
 * ⚠️ **A segment that is not an array subscript may still cross an array**, which is the one subtle
 * case here. MongoDB lets `{ 'addresses.city': x }` match any element's `city` with no subscript at
 * all, and `throwIfUserDontOwnAddress` relies on exactly that shape for `addresses._id`. So an
 * unmatched segment retries against the element node before giving up, rather than consuming it.
 */
export function resolveEncryptedPath(root: IEncryptedFieldNode, key: string): IEncryptedFieldNode | undefined {
	const segments = key.split('.')
	let node: IEncryptedFieldNode = root
	let index = 0

	while (index < segments.length) {
		const segment = segments[index] as string
		const named: IEncryptedFieldNode | undefined = node.children?.get(segment)

		if (named !== undefined) {
			node = named
			index += 1
			continue
		}

		const element: IEncryptedFieldNode | undefined = node.element

		if (element === undefined) {
			return undefined
		}

		// An explicit subscript consumes the segment; an implicit traversal does not, and is
		// re-tried against the element's own children on the next turn of the loop.
		node = element
		if (isArrayElementSegment(segment)) {
			index += 1
		}
	}

	return node
}
