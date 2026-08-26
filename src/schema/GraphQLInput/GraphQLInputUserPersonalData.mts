import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql'
import { GraphQLDate } from 'graphql-scalars'

/**
 * What a customer may write about themselves.
 *
 * ⚠️ **Only `firstName` and `lastName` are NonNull, where every field of
 * `GraphQLInputShopOwnerPersonalData` is.** The collection validator requires the same two and no
 * more, and the difference is the tier: a shop owner is onboarded by an operator collecting a full
 * record, a customer types a name into a profile page and leaves the rest for later.
 *
 * ⚠️ **No `address` field.** A customer's addresses are a separate top-level array with its own
 * mutations and its own input (`GraphQLInputUserAddress`) — putting one address in here would make
 * "save my profile" silently able to overwrite an entry in that array.
 */
export const GraphQLInputUserPersonalData = new GraphQLInputObjectType({
	name: 'GraphQLInputUserPersonalData',
	fields: () => ({
		firstName: { type: new GraphQLNonNull(GraphQLString) },
		lastName: { type: new GraphQLNonNull(GraphQLString) },
		birth: { type: GraphQLInputUserBirth },
		contacts: { type: GraphQLInputUserContacts }
	})
})

const GraphQLInputUserBirth = new GraphQLInputObjectType({
	name: 'GraphQLInputUserBirth',
	fields: () => ({
		date: { type: new GraphQLNonNull(GraphQLDate) }
	})
})

/*
 * Every member optional, unlike the shop owner's, which requires `mobile` and `email`.
 *
 * The account's address is `login.email` and is the credential; this `email` is a *second* address
 * to be reached on. A NonNull here would ask the customer to retype what they gave at registration,
 * and a NonNull `mobile` would put a phone number in the way of an account that only needs an inbox.
 * The whole `contacts` object is nullable for the same reason — sending none of it is a legal
 * profile save.
 */
const GraphQLInputUserContacts = new GraphQLInputObjectType({
	name: 'GraphQLInputUserContacts',
	fields: () => ({
		mobile: { type: GraphQLString },
		landline: { type: GraphQLString },
		email: { type: GraphQLString }
	})
})
