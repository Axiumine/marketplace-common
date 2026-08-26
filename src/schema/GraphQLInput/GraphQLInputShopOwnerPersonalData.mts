import { GraphQLFloat, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'
import { GraphQLDate } from 'graphql-scalars'

import { GraphQLAddressFrag } from '../types/fragments/GraphQLAddressFrag.mjs'

export const GraphQLInputShopOwnerPersonalData = new GraphQLInputObjectType({
	name: 'GraphQLInputShopOwnerPersonalData',
	fields: () => ({
		firstName: { type: new GraphQLNonNull(GraphQLString) },
		lastName: { type: new GraphQLNonNull(GraphQLString) },
		birth: { type: new GraphQLNonNull(GraphQLInputBirth) },
		address: { type: new GraphQLNonNull(GraphQLInputAddress) },
		contacts: { type: new GraphQLNonNull(GraphQLInputContacts) }
	})
})

const GraphQLInputBirth = new GraphQLInputObjectType({
	name: 'GraphQLInputBirth',
	fields: () => ({
		date: { type: new GraphQLNonNull(GraphQLDate) }
	})
})

/**
 * The GeoJSON point of the shopOwner's address, as **coordinates only**.
 *
 * No `type`: it has exactly one legal value and the Mongoose model declares it as an enum of
 * `['Point']`, so asking a client for the constant is only a way to receive `point` or `Polygon` and
 * fail the write. The service writes the literal — unlike `GraphQLPositionFrag`, which is the
 * *output* shape and does carry it.
 *
 * `Float`, not `Int`: as `Int` graphql-js rejects every real latitude at the schema boundary with
 * `Int cannot represent non-integer value: 45.75`.
 */
const GraphQLInputAddressPosition = new GraphQLInputObjectType({
	name: 'GraphQLInputAddressPosition',
	fields: () => ({
		coordinates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLFloat))) }
	})
})

/*
 * ⚠️ `position` is nullable here. Two reasons, and both have to hold: every shopOwner in the
 * collection was created before the field existed, and `shopOwnerAdd` is called with an address the
 * operator may have typed rather than picked. A NonNull here would turn both into a mutation the
 * client cannot send.
 *
 * Not added to `GraphQLAddressFrag`: that fragment is shared, and a consumer may declare its own
 * **required** position on its own input type built from the same fragment. A field of the same name
 * in the fragment would collide with that.
 */
const GraphQLInputAddress = new GraphQLInputObjectType({
	name: 'GraphQLInputAddress',
	fields: () => ({
		...GraphQLAddressFrag,
		position: { type: GraphQLInputAddressPosition }
	})
})

const GraphQLInputContacts = new GraphQLInputObjectType({
	name: 'GraphQLInputContacts',
	fields: () => ({
		mobile: { type: new GraphQLNonNull(GraphQLString) },
		landline: { type: GraphQLString },
		email: { type: new GraphQLNonNull(GraphQLString) }
	})
})
