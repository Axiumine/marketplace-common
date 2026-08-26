/**
 * `true` only for an object the walkers may descend into.
 *
 * ⚠️ The prototype check is what keeps this from wandering. A BSON `ObjectId`, a `Date`, a `Binary`,
 * a `Buffer` and a Mongoose `InternalCache` are all `typeof 'object'`, and three of them hold
 * references back up the tree — `doc.$__.parent` alone is enough to turn a document walk into an
 * infinite one. Restricting the walk to literal objects and `Object.create(null)` means every value
 * with an identity of its own is treated as a leaf, which is exactly what it is.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const prototype = Object.getPrototypeOf(value) as unknown
	return prototype === Object.prototype || prototype === null
}
