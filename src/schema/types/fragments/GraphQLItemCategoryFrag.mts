import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The `itemCategory` fields every tier renders. The taxonomy is platform-wide, so all three tiers
 * show the same categories: the admin writes them, the shop owner picks one when filing an item,
 * and the public tier draws `/category/:slug`.
 *
 * ⚠️ `position` is a **sort ordinal**, not the GeoJSON `position` of `GraphQLPositionFrag`. The two
 * fragments are neighbours in this directory and share a field name and nothing else — spreading the
 * wrong one produces a type that compiles and answers coordinates for a menu order.
 *
 * `idParent` is out: it is an id rather than display data, only the tiers that write a category need
 * it echoed back, and the public tier addresses the second level by `/category/:slug/:subSlug`
 * rather than by pointer.
 */
export const GraphQLItemCategoryFrag = {
	name: { type: new GraphQLNonNull(GraphQLString) },
	slug: { type: new GraphQLNonNull(GraphQLString) },
	position: { type: new GraphQLNonNull(GraphQLInt) }
}
