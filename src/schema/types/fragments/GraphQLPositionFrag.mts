import { GraphQLFloat, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'

// GeoJSON `Point`: `coordinates` is [longitude, latitude], in that order.
//
// Float, not Int. As Int this fragment could not express a coordinate at all — graphql-js throws
// `Int cannot represent non-integer value: 45.75` in parseValue/parseLiteral, so every real latitude
// was rejected at the schema boundary before a resolver ever ran, and the only values that got
// through were the whole-degree ones that MongoDB then refused on the way in. Both halves are fixed
// together: the collection validators store the type as `['double', 'int', 'long']`, not `decimal`,
// which is what `{ type: [Number] }` actually writes.
//
// Keep it Float rather than a decimal scalar: resolvers returning a document that embeds this point
// (shopOwner, company) use `.lean()`, so no mongoose getter runs and whatever the driver
// deserialized reaches this scalar directly. A Decimal128 there throws `Float cannot represent non
// numeric value`.
export const GraphQLPositionFrag = {
	type: { type: new GraphQLNonNull(GraphQLString) },
	coordinates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLFloat))) }
}
