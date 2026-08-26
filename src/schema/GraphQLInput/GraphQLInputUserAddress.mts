import { GraphQLFloat, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

import { GraphQLAddressFrag } from '../types/fragments/GraphQLAddressFrag.mjs'

/**
 * One saved address of a customer, as it arrives from the client.
 *
 * ⚠️ **No `_id`, and none is accepted.** The element id is minted by Mongoose and is what
 * `user.defaultAddress` points at; letting a client supply one would let it aim the pointer at an
 * address it does not own. An update names the address it is editing with a separate `_id: ID!`
 * argument on the mutation and an ownership guard in front of it — the same shape `companyUpdate`
 * uses, and for the same reason.
 *
 * ⚠️ **No `default` flag.** "This is now my default" is its own mutation, because it is a write to a
 * *sibling* field: `defaultAddress` lives at the document root, and the database refuses a pointer
 * that names no element of `addresses`. Accepting a boolean here would mean adding an address and
 * repointing the default in one call, which is two writes wearing one name.
 */
export const GraphQLInputUserAddress = new GraphQLInputObjectType({
	name: 'GraphQLInputUserAddress',
	fields: () => ({
		...GraphQLAddressFrag,
		label: { type: GraphQLString },
		position: { type: GraphQLInputUserAddressPosition }
	})
})

/**
 * The GeoJSON point of a saved address, as **coordinates only**.
 *
 * No `type`: it has exactly one legal value, the Mongoose model declares it as an enum of
 * `['Point']` and the service writes the literal — asking a client for the constant is only a way to
 * receive `point` and fail the write. Same call as `GraphQLInputAddressPosition` in
 * `GraphQLInputShopOwnerPersonalData`, and unlike `GraphQLPositionFrag`, which is the *output* shape
 * and does carry it.
 *
 * Nullable, because the address is: the point arrives when the customer picks an entry from the
 * geocoder's autocomplete, and one typed by hand has no map until it is re-picked.
 *
 * `Float`, not `Int` — as `Int` graphql-js rejects every real latitude at the schema boundary with
 * `Int cannot represent non-integer value: 45.75`.
 */
const GraphQLInputUserAddressPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputUserAddressPosition',
	fields: () => ({
		coordinates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLFloat))) }
	})
})
