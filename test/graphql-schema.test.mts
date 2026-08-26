import {
	assertValidSchema,
	GraphQLInputObjectType,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	printSchema
} from 'graphql'
import { beforeEach, describe, expect, it } from 'vitest'

/*
 * Everything is built inside `beforeEach`, off dynamic imports, and nothing at module scope.
 *
 * `new GraphQLSchema` walks the type map eagerly, which resolves every nested input thunk in
 * GraphQLInputShopOwnerPersonalData. At module scope that resolution happens during Vitest's
 * file-collection phase, so a mutant that empties one of those thunks throws before any test runs —
 * Stryker cannot attribute a collection-phase failure to a test and reports the mutant **Survived**
 * even though the suite did fail. That artifact is what makes `ignoreStatic` look like the fix; it
 * is not. Building here puts the throw inside a test that can fail, which is what kills it.
 * `beforeEach` and not `beforeAll`: a throw in `beforeAll` marks the dependent tests skipped, and
 * the vitest-runner does not count a skipped test as a kill either.
 */
describe('assembled GraphQLSchema', () => {
	let GraphQLInputShopOwnerPersonalData: (typeof import('../src/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData.mts'))['GraphQLInputShopOwnerPersonalData']
	let schema: GraphQLSchema

	beforeEach(async () => {
		;({ GraphQLInputShopOwnerPersonalData } = await import('../src/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData.mts'))
		const { GraphQLAddressFrag } = await import('../src/schema/types/fragments/GraphQLAddressFrag.mts')
		const { GraphQLPositionFrag } = await import('../src/schema/types/fragments/GraphQLPositionFrag.mts')

		const GraphQLPositionType = new GraphQLObjectType({
			name: 'Position',
			fields: () => ({
				...GraphQLPositionFrag
			})
		})

		const Query = new GraphQLObjectType({
			name: 'Query',
			fields: () => ({
				...GraphQLAddressFrag,
				position: { type: new GraphQLNonNull(GraphQLPositionType) },
				personalData: {
					type: GraphQLString,
					args: {
						input: { type: new GraphQLNonNull(GraphQLInputShopOwnerPersonalData) }
					}
				}
			})
		})

		schema = new GraphQLSchema({ query: Query })
	})

	it('is a valid schema', () => {
		expect(() => assertValidSchema(schema)).not.toThrow()
	})

	it('prints the expected type/field names', () => {
		const printed = printSchema(schema)
		expect(printed).toContain('GraphQLInputShopOwnerPersonalData')
		expect(printed).toContain('GraphQLInputBirth')
		expect(printed).toContain('postalCode')
		expect(printed).toContain('coordinates')
	})

	/*
	 * The field lists of GraphQLInputShopOwnerPersonalData and of every input type nested in it are
	 * asserted once, in graphql.test.mts, whose whole describe is that type. They used to be restated
	 * here word for word. Nothing is lost by dropping them: what this file is for is the eager walk
	 * `new GraphQLSchema` does in `beforeEach`, and that walk runs ahead of every test below whatever
	 * each one goes on to assert.
	 */

	/*
	 * Nullable, and asserted as such. Every shopOwner in the collection predates the point, and
	 * `shopOwnerAdd` may be called with an address that was typed rather than picked — a NonNull here
	 * turns both into a mutation the operator app cannot send at all.
	 */
	it('takes the address point as an optional coordinates-only input', () => {
		const address = (GraphQLInputShopOwnerPersonalData.getFields().address.type as GraphQLNonNull<GraphQLInputObjectType>).ofType
		const position = address.getFields().position

		expect(position.type).not.toBeInstanceOf(GraphQLNonNull)
		expect(String(position.type)).toBe('GraphQLInputAddressPosition')

		// Coordinates only: `type` has one legal value, the model pins it to the `Point` enum and the
		// service writes the literal. Asking a client for a constant only invites `point` or `Polygon`.
		const positionFields = (position.type as GraphQLInputObjectType).getFields()
		expect(Object.keys(positionFields)).toEqual(['coordinates'])
		// `[Float!]!`, never `[Int!]!` — as Int graphql-js rejects 45.75 before a resolver ever runs.
		expect(String(positionFields.coordinates.type)).toBe('[Float!]!')
	})
})
