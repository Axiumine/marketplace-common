import { GraphQLNonNull, GraphQLString } from 'graphql'

/**
 * The three fields of an `item` that every tier renders: the shop owner editing it, the operator
 * moderating it, and the anonymous visitor reading the page.
 *
 * `published` and `deleted` are deliberately **not** here. They are tier-specific — the owner and the
 * operator need the flag to see a draft, and the public tier never renders one, because an unpublished item
 * is filtered out before it reaches a field resolver. Putting them in the fragment would make the
 * public type carry a field whose only possible value is `true`.
 *
 * `idCompany` and `idCategory` are out for the same reason from the other side: a shop page already
 * knows which shop it is, and only the tiers that write need the ids echoed back.
 */
export const GraphQLItemFrag = {
	name: { type: new GraphQLNonNull(GraphQLString) },
	description: { type: new GraphQLNonNull(GraphQLString) },
	slug: { type: new GraphQLNonNull(GraphQLString) }
}
