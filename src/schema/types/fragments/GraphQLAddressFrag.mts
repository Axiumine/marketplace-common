import { GraphQLNonNull, GraphQLString } from 'graphql'

export const GraphQLAddressFrag = {
	street: { type: new GraphQLNonNull(GraphQLString) },
	postalCode: { type: new GraphQLNonNull(GraphQLString) },
	city: { type: new GraphQLNonNull(GraphQLString) },
	province: { type: new GraphQLNonNull(GraphQLString) }
}
