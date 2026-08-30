import { GraphQLFloat, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql'
import { beforeAll, describe, expect, it } from 'vitest'

import { GraphQLAddressFrag } from '../src/schema/types/fragments/GraphQLAddressFrag.mts'
import { GraphQLBaseAddressFrag } from '../src/schema/types/fragments/GraphQLBaseAddressFrag.mts'
import { GraphQLItemCategoryFrag } from '../src/schema/types/fragments/GraphQLItemCategoryFrag.mts'
import { GraphQLItemFrag } from '../src/schema/types/fragments/GraphQLItemFrag.mts'
import { GraphQLPositionFrag } from '../src/schema/types/fragments/GraphQLPositionFrag.mts'

describe('GraphQL fragments', () => {
	it('GraphQLBaseAddressFrag has 4 non-null string fields', () => {
		for (const key of ['street', 'postalCode', 'city', 'province'] as const) {
			expect(GraphQLBaseAddressFrag[key].type).toBeInstanceOf(GraphQLNonNull)
		}
	})

	it('GraphQLAddressFrag has 4 non-null string fields', () => {
		for (const key of ['street', 'postalCode', 'city', 'province'] as const) {
			expect(GraphQLAddressFrag[key].type).toBeInstanceOf(GraphQLNonNull)
		}
	})

	// Asserted through `String(type)` rather than by walking `.ofType`: the previous version of this
	// test unwrapped one level and stopped at `toBeInstanceOf(GraphQLList)`, which never looked at the
	// element scalar at all. It passed identically while `coordinates` was `[Int!]!` — a shape that
	// could not carry a coordinate, since graphql-js throws `Int cannot represent non-integer value`
	// on any real latitude. Print the whole type and the scalar cannot go unchecked again.
	it('GraphQLPositionFrag: type String! + coordinates [Float!]!', () => {
		expect(String(GraphQLPositionFrag.type.type)).toBe('String!')
		expect(String(GraphQLPositionFrag.coordinates.type)).toBe('[Float!]!')
	})

	// Belt and braces on the one that matters: `String()` would also read '[Float!]!' off a lookalike
	// built from a different `graphql` realm, and the element type is what the DB migration is paired
	// with. Compare scalar identity too.
	it('GraphQLPositionFrag: coordinates elements are the GraphQLFloat singleton', () => {
		const coords = GraphQLPositionFrag.coordinates.type
		expect(coords).toBeInstanceOf(GraphQLNonNull)

		const list = coords.ofType
		expect(list).toBeInstanceOf(GraphQLList)

		const element = (list as GraphQLList<GraphQLNonNull<typeof GraphQLFloat>>).ofType
		expect(element).toBeInstanceOf(GraphQLNonNull)
		expect(element.ofType).toBe(GraphQLFloat)
		expect(element.ofType).not.toBe(GraphQLInt)
	})
})

describe('GraphQLInputShopOwnerPersonalData', () => {
	// Imported dynamically (not statically at the top of this file): every field on this type and
	// its nested input types is built with a `name: '...'` string literal passed straight into
	// `new GraphQLInputObjectType({...})`/`new GraphQLObjectType({...})`. graphql-js asserts that
	// name at construction time, so a mutant that empties one of those strings (or guts the whole
	// config object) throws synchronously while this module is first evaluated — i.e. during
	// Vitest's file-collection phase for a static top-level import, before any test runs. Stryker's
	// vitest-runner only attributes a mutant kill to an error raised during an actual test's
	// execution; a collection-phase crash just leaves this file with zero collected tests while
	// every other file still passes, so the mutant is misreported as Survived. Importing inside
	// `beforeAll` moves the same throw into the suite's own execution, where it correctly fails.
	let GraphQLInputShopOwnerPersonalData: (typeof import('../src/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData.mts'))['GraphQLInputShopOwnerPersonalData']

	beforeAll(async () => {
		;({ GraphQLInputShopOwnerPersonalData } = await import('../src/schema/GraphQLInput/GraphQLInputShopOwnerPersonalData.mts'))
	})

	it('resolves the top-level fields', () => {
		const fields = GraphQLInputShopOwnerPersonalData.getFields()
		expect(Object.keys(fields).sort()).toEqual(['address', 'birth', 'contacts', 'firstName', 'lastName'])
	})

	it('resolves every nested input thunk', () => {
		const fields = GraphQLInputShopOwnerPersonalData.getFields()
		const unwrap = (field: keyof typeof fields): GraphQLInputObjectType =>
			(fields[field].type as GraphQLNonNull<GraphQLInputObjectType>).ofType

		expect(Object.keys(unwrap('birth').getFields())).toEqual(['date'])
		expect(Object.keys(unwrap('address').getFields()).sort()).toEqual(['city', 'position', 'postalCode', 'province', 'street'])
		expect(Object.keys(unwrap('contacts').getFields()).sort()).toEqual(['email', 'landline', 'mobile'])
	})

	// The point is spread here and *not* into `GraphQLAddressFrag`: the fragment is shared, and a
	// consumer may declare its own required `position` on its own input type built from the same
	// fragment. A same-named field in the fragment would collide with that.
	it('keeps the point out of the shared address fragment', () => {
		expect(Object.keys(GraphQLAddressFrag).sort()).toEqual(['city', 'postalCode', 'province', 'street'])
		expect(Object.keys(GraphQLBaseAddressFrag).sort()).toEqual(['city', 'postalCode', 'province', 'street'])
	})
})

/*
 * The catalogue pair. Both are read by all three tiers, so what each one leaves *out* is as much a
 * decision as what it carries — and the key lists below are the assertion, since an extra field
 * spread into a public type is a field the anonymous surface then has to answer.
 */
describe('GraphQLItemFrag', () => {
	it('is the three fields every tier renders, each non-null', () => {
		expect(Object.keys(GraphQLItemFrag).sort()).toEqual(['description', 'name', 'slug'])
		for (const key of ['name', 'description', 'slug'] as const) {
			expect(String(GraphQLItemFrag[key].type), key).toBe('String!')
		}
	})

	/*
	 * ⚠️ `published` and `deleted` are tier-specific and deliberately absent.
	 *
	 * The owner and the admin need the flag to see a draft; the public tier never renders one,
	 * because an unpublished item is filtered out before a field resolver is ever reached. In the fragment they
	 * would make the public type carry a field whose only possible value is `true` — and `deleted` a
	 * field whose only possible value is null.
	 *
	 * `idCompany` and `idCategory` are out from the other side: a shop page already knows which shop it
	 * is, and only the tiers that write need the ids echoed back.
	 */
	it('carries neither the tier-specific flags nor the references', () => {
		for (const key of ['published', 'deleted', 'idCompany', 'idCategory', 'price']) {
			expect(GraphQLItemFrag, key).not.toHaveProperty(key)
		}
	})
})

describe('GraphQLItemCategoryFrag', () => {
	it('is name, slug and the ordinal', () => {
		expect(Object.keys(GraphQLItemCategoryFrag).sort()).toEqual(['name', 'position', 'slug'])
		expect(String(GraphQLItemCategoryFrag.name.type)).toBe('String!')
		expect(String(GraphQLItemCategoryFrag.slug.type)).toBe('String!')
	})

	/*
	 * ⚠️ `position` here is a **sort ordinal** — `Int!` — and not the GeoJSON `position` of
	 * `GraphQLPositionFrag`, which is an object with a `type` and a `[Float!]!`.
	 *
	 * The two fragments are neighbours in one directory and share a field name and nothing else, so
	 * spreading the wrong one produces a type that compiles and answers coordinates for a menu order.
	 * Compared against the other fragment's shape rather than merely asserted, because that is the
	 * mistake this is here to catch.
	 */
	it('position is an Int ordinal, not the geo point of the same name', () => {
		expect(String(GraphQLItemCategoryFrag.position.type)).toBe('Int!')
		expect(String(GraphQLItemCategoryFrag.position.type)).not.toBe(String(GraphQLPositionFrag.coordinates.type))

		const ordinal = GraphQLItemCategoryFrag.position.type
		expect(ordinal).toBeInstanceOf(GraphQLNonNull)
		expect(ordinal.ofType).toBe(GraphQLInt)
	})

	// `idParent` is out: it is a pointer rather than display data, only the tier that writes a category
	// needs it echoed back, and the public tier addresses the second level as
	// `/category/:slug/:subSlug` rather than by id.
	it('carries no parent pointer', () => {
		expect(GraphQLItemCategoryFrag).not.toHaveProperty('idParent')
		expect(GraphQLItemCategoryFrag).not.toHaveProperty('deleted')
	})
})

describe('GraphQLInputUserAddress', () => {
	// Dynamically imported inside `beforeAll`, like the shop owner's input above and for the same
	// reason — a `name: ''` mutant throws where graphql-js constructs the type, and a static top-level
	// import puts that throw in Vitest's collection phase, which Stryker cannot attribute to a test.
	let GraphQLInputUserAddress: (typeof import('../src/schema/GraphQLInput/GraphQLInputUserAddress.mts'))['GraphQLInputUserAddress']

	beforeAll(async () => {
		;({ GraphQLInputUserAddress } = await import('../src/schema/GraphQLInput/GraphQLInputUserAddress.mts'))
	})

	/*
	 * ⚠️ One test on purpose, and splitting it back into three re-opens two surviving mutants.
	 *
	 * `fields` is a thunk and `getFields()` memoises: the field configs — and the nested position type
	 * with them — are built exactly once, on the *first* call, and Stryker records a mutant as covered
	 * where its literal is evaluated, not where its effect is observed. Split across three `it`s, the
	 * `position: { type: … }` config and the point's own `fields` thunk were attributed to whichever
	 * test called `getFields()` first, so Stryker only ever ran *that* test against them — while the
	 * assertions that catch an emptied config sat in the third test, which was never run for those
	 * mutants and reported them Survived. One test means the covering test is also the failing one.
	 */
	it('is the shared address plus a label and a coordinates-only point, with no id and no default flag', () => {
		const fields = GraphQLInputUserAddress.getFields()

		expect(Object.keys(fields).sort()).toEqual(['city', 'label', 'position', 'postalCode', 'province', 'street'])
		expect(GraphQLInputUserAddress.name).toBe('GraphQLInputUserAddress')
		// The four the fragment brings are required; the two this input adds are not — a customer types
		// an address before naming it, and one typed by hand has no point until it is re-picked.
		for (const key of ['street', 'postalCode', 'city', 'province'] as const) {
			expect(String(fields[key].type), key).toBe('String!')
		}
		expect(String(fields.label.type)).toBe('String')

		/*
		 * ⚠️ No `_id`, and none is accepted.
		 *
		 * The element id is minted by Mongoose and is what `user.defaultAddress` points at; letting a
		 * client supply one would let it aim that pointer at an address it does not own. An update names
		 * the address it is editing with a separate `_id: ID!` argument and an ownership guard in front
		 * of it — the shape `companyUpdate` uses, for the same reason.
		 *
		 * ⚠️ And no `default` flag. "This is now my default" is a write to a *sibling* field at the
		 * document root, which the database refuses unless it names an existing element; accepting a
		 * boolean here would be two writes wearing one name.
		 */
		expect(fields).not.toHaveProperty('_id')
		expect(fields).not.toHaveProperty('id')
		expect(fields).not.toHaveProperty('default')

		/*
		 * ⚠️ Coordinates only — no `type`.
		 *
		 * It has exactly one legal value, the model declares it as an enum of `['Point']` and the service
		 * writes the literal, so asking a client for the constant is only a way to receive `point` and
		 * fail the write. The *output* fragment does carry it, which is what makes this worth pinning.
		 *
		 * `Float`, not `Int`: as `Int`, graphql-js rejects every real latitude at the schema boundary
		 * with `Int cannot represent non-integer value: 45.75`.
		 */
		const position = fields.position.type as GraphQLInputObjectType

		expect(position).toBeInstanceOf(GraphQLInputObjectType)
		expect(position.name).toBe('GraphQLInputUserAddressPosition')
		expect(Object.keys(position.getFields())).toEqual(['coordinates'])
		expect(String(position.getFields().coordinates.type)).toBe('[Float!]!')

		const list = (position.getFields().coordinates.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<typeof GraphQLFloat>>>)
			.ofType
		const element = list.ofType
		expect(element.ofType).toBe(GraphQLFloat)
		expect(element.ofType).not.toBe(GraphQLInt)
	})
})

describe('GraphQLInputUserPersonalData', () => {
	// Same reason as the address input above — both for the dynamic `beforeAll` import and for the
	// single test: the two nested inputs are built inside a memoised thunk, so the test that resolves
	// them first is the only one Stryker runs against their mutants.
	let GraphQLInputUserPersonalData: (typeof import('../src/schema/GraphQLInput/GraphQLInputUserPersonalData.mts'))['GraphQLInputUserPersonalData']

	beforeAll(async () => {
		;({ GraphQLInputUserPersonalData } = await import('../src/schema/GraphQLInput/GraphQLInputUserPersonalData.mts'))
	})

	/*
	 * ⚠️ Only the two names are NonNull, where **every** field of `GraphQLInputShopOwnerPersonalData`
	 * is. The collection validator requires the same two and no more, and the difference is the tier: a
	 * shop owner is onboarded by an admin collecting a full record, a customer types a name into a
	 * profile page and leaves the rest for later.
	 */
	it('requires the two names, carries no address, and resolves both nested inputs', () => {
		const fields = GraphQLInputUserPersonalData.getFields()

		expect(Object.keys(fields).sort()).toEqual(['birth', 'contacts', 'firstName', 'lastName'])
		expect(String(fields.firstName.type)).toBe('String!')
		expect(String(fields.lastName.type)).toBe('String!')
		expect(String(fields.birth.type)).toBe('GraphQLInputUserBirth')
		expect(String(fields.contacts.type)).toBe('GraphQLInputUserContacts')

		// ⚠️ No `address`. A customer's addresses are a separate top-level array with mutations and an
		// input of their own — one address in here would make "save my profile" silently able to
		// overwrite an entry in that array.
		expect(fields).not.toHaveProperty('address')

		const nested = (field: 'birth' | 'contacts') => fields[field].type as GraphQLInputObjectType

		// A birth that is sent at all must carry the one field it is made of — and it is a `Date`, the
		// calendar-day scalar, not a `DateTime`: nobody was born at a time zone.
		expect(Object.keys(nested('birth').getFields())).toEqual(['date'])
		expect(String(nested('birth').getFields().date.type)).toBe('Date!')

		/*
		 * Every member optional, unlike the shop owner's required `mobile` and `email`.
		 *
		 * The account's address is `login.email` and is the credential; this `email` is a *second*
		 * address to be reached on, so a NonNull would ask the customer to retype what they gave at
		 * registration, and a NonNull `mobile` would put a phone number in the way of an account that
		 * only needs an inbox.
		 */
		expect(Object.keys(nested('contacts').getFields()).sort()).toEqual(['email', 'landline', 'mobile'])
		for (const key of ['mobile', 'landline', 'email']) {
			expect(String(nested('contacts').getFields()[key].type), key).toBe('String')
		}
	})
})
