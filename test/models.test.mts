import { Model, Schema } from 'mongoose'
import { beforeAll, describe, expect, it } from 'vitest'

import { Company } from '../src/models/MongoDB/Company.mts'
import { Item } from '../src/models/MongoDB/Item.mts'
import { ItemCategory } from '../src/models/MongoDB/ItemCategory.mts'
import { BaseAddressSchema } from '../src/models/MongoDB/sub/BaseAddressSchema.mts'

// Admin, ShopOwner and User are deliberately NOT in this array: they are dynamically imported inside
// their own describe blocks below (see the comment on the ShopOwner block for why). The catalogue
// pair has no inline `_id: false` anywhere and so nothing that can throw while its Schema is built.
const models: Array<{ model: Model<unknown>; name: string; collection: string }> = [
	{ model: Company as never, name: 'Company', collection: 'company' },
	{ model: Item as never, name: 'Item', collection: 'item' },
	{ model: ItemCategory as never, name: 'ItemCategory', collection: 'itemCategory' }
]

const subSchemaOf = (schema: Schema, path: string) => (schema.path(path) as unknown as { schema: Schema }).schema

/**
 * `resetPwd` and `emailVerify` are spread from the same two shared sub-schemas onto `ShopOwner` and
 * `User`, so both models have exactly the same thing to prove about them: the two are distinct,
 * neither is `required` — a document that has requested neither carries neither — and their field sets
 * are disjoint, because one authenticates the other and an unauthenticated reset request kills every
 * pending activation link. `emailVerify` additionally carries no implicit `_id`, for the same
 * `additionalProperties: false` reason as everything else here.
 */
const expectResetPwdAndEmailVerify = (schema: Schema) => {
	const resetPwd = schema.path('resetPwd')
	expect(resetPwd.instance).toBe('Embedded')
	expect(resetPwd.isRequired).toBeUndefined()
	const resetPwdSchema = subSchemaOf(schema, 'resetPwd')
	expect(Object.keys(resetPwdSchema.paths)).toEqual(['resetDateReq', 'resetHash'])

	const emailVerify = schema.path('emailVerify')
	expect(emailVerify.instance).toBe('Embedded')
	expect(emailVerify.isRequired).toBeUndefined()
	const emailVerifySchema = subSchemaOf(schema, 'emailVerify')
	expect(emailVerifySchema.options._id).toBe(false)
	expect(Object.keys(emailVerifySchema.paths)).toEqual(['valid', 'hash', 'dateLastReq', 'requestTimes', 'newEmailTmp'])

	expect(Object.keys(resetPwdSchema.paths).filter((p) => p in emailVerifySchema.paths)).toEqual([])
}

describe('MongoDB models', () => {
	it.each(models)('$name registers with the right name and collection', ({ model, name, collection }) => {
		expect(model.prototype).toBeInstanceOf(Model)
		expect(model.modelName).toBe(name)
		expect(model.collection.name).toBe(collection)
		expect(model.schema).toBeInstanceOf(Schema)
	})
})

describe('Company schema — full field verification', () => {
	it('_id is a bare ObjectId path', () => {
		expect(Company.schema.path('_id').instance).toBe('ObjectId')
	})

	it('idShopOwner: ObjectId, required, ref ShopOwner', () => {
		const p = Company.schema.path('idShopOwner')
		expect(p.instance).toBe('ObjectId')
		expect(p.isRequired).toBe(true)
		// Required on purpose: an company with no owner is unreachable, since the only list query on
		// the collection is by shopOwner. The migration's validator says the same.
		expect((p.options as { ref?: string }).ref).toBe('ShopOwner')
	})

	it('the company fields carry the requiredness the collection validator declares', () => {
		// `taxCode` and `uniqueCode` optional, everything else required — mirrors the `required` array of
		// 20260803000000-create-company. `taxCode` in particular *has* to stay optional: no stored company
		// carries it and `collMod` does not re-validate what is already there.
		const required: Record<string, boolean | undefined> = {
			legalName: true,
			vatNumber: true,
			taxCode: undefined,
			uniqueCode: undefined,
			certifiedEmail: true,
			registryExtract: true,
			// The three string fields 20260804010000-alter-company-public added. Optional for the
			// reason `taxCode` is: the collection was already populated when they landed, and no slug
			// can be derived from a registered legal name without inventing one.
			publicName: undefined,
			slug: undefined,
			description: undefined
		}
		for (const [name, isRequired] of Object.entries(required)) {
			const path = Company.schema.path(name)
			expect(path.instance, name).toBe('String')
			expect(path.isRequired, name).toBe(isRequired)
		}

		// ⚠️ The only two encrypted fields on this collection, and the only two that name a natural
		// person rather than the entity. Everything in the list above describes a registered company
		// or is what the storefront hands to anonymous visitors, so encrypting any of it would cost
		// the map, the city listing and the text search to protect data the platform publishes.
		for (const name of ['contactPerson', 'administrator']) {
			const path = Company.schema.path(name)
			expect(path.instance, name).toBe('EncryptedField')
			expect(path.options.plaintext, name).toBe('string')
			expect(path.isRequired, name).toBe(true)
		}
	})

	it('published: required Boolean, the one added field whose requiredness was earned', () => {
		// Its three neighbours above are optional; this one is not, and the difference is the whole
		// point of the three-step migration — widen, backfill every stored document with `false`, narrow.
		// Nothing is stranded by the requirement, so the model may demand it too.
		const published = Company.schema.path('published')
		expect(published.instance).toBe('Boolean')
		expect(published.isRequired).toBe(true)
	})

	it('address: required embedded doc carrying a required geo position', () => {
		const address = Company.schema.path('address')
		expect(address.instance).toBe('Embedded')
		expect(address.isRequired).toBe(true)
		const addressSchema = (address as unknown as { schema: Schema }).schema

		// The base address, from the shared BaseAddressSchema — cloned, so a mutant dropping the
		// `.clone()` would add `position` to every other model that spreads the same sub-schema.
		for (const name of ['street', 'postalCode', 'city', 'province']) {
			const path = addressSchema.path(name)
			expect(path.instance, name).toBe('String')
			expect(path.isRequired, name).toBe(true)
		}

		// ⚠️ The last GeoJSON point on the platform still stored as a readable sub-document. A shop's
		// address is what a storefront prints and what a customer navigates to, so it is not personal
		// data and encrypting it would cost the `2dsphere` index for nothing — the shop owner's own
		// point and the customer's are `binData` (ADR-029).
		const position = addressSchema.path('position')
		expect(position.instance).toBe('Embedded')
		// Required: the collection was created empty, so no stored document is stranded by it.
		expect(position.isRequired).toBe(true)
		const positionSchema = (position as unknown as { schema: Schema }).schema
		const typePath = positionSchema.path('type')
		expect(typePath.instance).toBe('String')
		expect(typePath.isRequired).toBe(true)
		expect((typePath as unknown as { enumValues: string[] }).enumValues).toEqual(['Point'])
		const coordinatesPath = positionSchema.path('coordinates')
		expect(coordinatesPath.instance).toBe('Array')
		expect(coordinatesPath.isRequired).toBe(true)
		// With the default `_id: true` mongoose mints an ObjectId here and the validator's
		// `additionalProperties: false` rejects the whole write.
		expect(positionSchema.options._id).toBe(false)
	})

	it('the shared address sub-schema is untouched by the clone', () => {
		// The other half of the `.clone()` guarantee: `BaseAddressSchema.add()` mutates in place,
		// so an un-cloned `.add()` here would leave a `position` path on the shared schema and on
		// every model built from it afterwards.
		expect(BaseAddressSchema.path('position')).toBeUndefined()
	})

	// Soft delete, the same shape `shopOwner` carries: a Date, so the document records
	// *when* it went, and optional — a `required: true` mutant here would make every live company
	// unsaveable, which is the one state the collection is normally in.
	it('deleted: optional Date, not a flag', () => {
		const deleted = Company.schema.path('deleted')
		expect(deleted.instance).toBe('Date')
		expect(deleted.isRequired).toBe(undefined)
	})

	it('__v carries its plain type and nothing else is on the schema', () => {
		expect(Company.schema.path('__v').instance).toBe('Number')
		// Exactly the validator's property list. `additionalProperties: false` on the collection
		// means a stray path here is a field no write can ever carry.
		expect(Object.keys(Company.schema.paths).sort()).toEqual(
			[
				'_id',
				'__v',
				'administrator',
				'taxCode',
				'deleted',
				'idShopOwner',
				'address',
				'certifiedEmail',
				'vatNumber',
				'legalName',
				'contactPerson',
				'uniqueCode',
				'registryExtract',
				// The shop-listing half, added by 20260804010000. A company IS the shop here, so the
				// storefront's fields have nowhere else to hang.
				'publicName',
				'slug',
				'description',
				'published'
			].sort()
		)
	})
})

/**
 * Admin and ShopOwner both embed LoginSubDocSchema under the same name and the same required
 * flag, so the assertion is one shape asserted twice rather than two independent claims.
 */
function expectLoginSubDoc(schema: Schema) {
	const login = schema.path('login')
	expect(login.instance).toBe('Embedded')
	expect(login.isRequired).toBe(true)

	const loginSchema = (login as unknown as { schema: Schema }).schema
	expect(loginSchema.path('email')).toBeDefined()
	expect(loginSchema.path('password')).toBeDefined()
}

/**
 * The `personalData` sub-object both models declare inline, with `_id: false`. Only the fields inside
 * it differ between the two, so the caller gets the sub-schema back and asserts those itself.
 *
 * ⚠️ **Requiredness is a parameter and the two models disagree on it.** An `admin` is created by
 * another admin who fills the whole record in; a `shopOwner` may now create *themselves* through
 * `shopOwnerRegister`, with an address and a password and nothing else, and declare who they are at
 * onboarding. `isRequired` is `undefined` rather than `false` on an optional embedded path, which is
 * why this asserts the exact value both ways instead of a truthiness.
 */
function expectPersonalDataSubDoc(schema: Schema, required: true | undefined) {
	const personalData = schema.path('personalData')
	expect(personalData.instance).toBe('Embedded')
	expect(personalData.isRequired).toBe(required)

	const personalDataSchema = (personalData as unknown as { schema: Schema }).schema
	expect(personalDataSchema.options._id).toBe(false)

	return personalDataSchema
}

describe('Admin schema — full field verification', () => {
	// Same reasoning as the ShopOwner block below: Admin.mts also builds its personalData
	// sub-object with an inline `_id: false`, so the import happens dynamically to keep a mutated
	// `_id: true` observable as a normal test failure instead of an invisible collection crash.
	let Admin: (typeof import('../src/models/MongoDB/Admin.mts'))['Admin']

	beforeAll(async () => {
		;({ Admin } = await import('../src/models/MongoDB/Admin.mts'))
	})

	it('registers with the right name and collection', () => {
		expect(Admin.prototype).toBeInstanceOf(Model)
		expect(Admin.modelName).toBe('Admin')
		expect(Admin.collection.name).toBe('admin')
		expect(Admin.schema).toBeInstanceOf(Schema)
	})

	it('_id is a bare ObjectId path', () => {
		expect(Admin.schema.path('_id').instance).toBe('ObjectId')
	})

	it('login: required embedded LoginSubDocSchema', () => {
		expectLoginSubDoc(Admin.schema)
	})

	it('personalData: required embedded doc, _id disabled, own field shapes', () => {
		const personalDataSchema = expectPersonalDataSubDoc(Admin.schema, true)

		// Encrypted, unlike the shop owner's two: there is no admin table over this collection, so
		// nothing sorts or prefix-searches an admin's name.
		const firstName = personalDataSchema.path('firstName')
		expect(firstName.instance).toBe('EncryptedField')
		expect(firstName.options.plaintext).toBe('string')
		expect(firstName.isRequired).toBeUndefined()

		const lastName = personalDataSchema.path('lastName')
		expect(lastName.instance).toBe('EncryptedField')
		expect(lastName.options.plaintext).toBe('string')
		expect(lastName.isRequired).toBeUndefined()
	})

	it('deleted/disabled/__v carry their plain types', () => {
		expect(Admin.schema.path('deleted').instance).toBe('Date')
		expect(Admin.schema.path('disabled').instance).toBe('Boolean')
		expect((Admin.schema.path('__v') as unknown as { instance: string }).instance).toBe('Number')
	})

	it('resetPwd: embedded ResetPwdSubDocSchema', () => {
		const resetPwd = Admin.schema.path('resetPwd')
		expect(resetPwd.instance).toBe('Embedded')
		const resetPwdSchema = (resetPwd as unknown as { schema: Schema }).schema
		expect(resetPwdSchema.path('resetDateReq')).toBeDefined()
		expect(resetPwdSchema.path('resetHash')).toBeDefined()
	})
})

describe('ShopOwner schema — full field verification', () => {
	// ShopOwner is imported dynamically (not statically at the top of this file) and freshly
	// per describe block. This matters for mutation testing: ShopOwner.mts constructs its
	// Schema with an inline `_id: false` on the personalData sub-object. Mongoose only special-cases
	// a literal `false` there; any other value (e.g. a mutant flipping it to `true`) falls through
	// to interpretAsType and throws synchronously while the Schema is being built. A static
	// top-level `import` would let that throw happen during Vitest's file-collection phase, before
	// any test runs — Stryker's vitest-runner only inspects errors raised during an actual test
	// execution, so a collection-phase crash is invisible to it (the file simply contributes zero
	// tests, every other file still passes, and the mutant is misreported as Survived even though
	// it demonstrably breaks the schema). Importing inside `beforeAll`/`it` instead makes the same
	// throw surface as this suite's own test failure, which Stryker does attribute correctly.
	let ShopOwner: (typeof import('../src/models/MongoDB/ShopOwner.mts'))['ShopOwner']

	beforeAll(async () => {
		;({ ShopOwner } = await import('../src/models/MongoDB/ShopOwner.mts'))
	})

	it('registers with the right name and collection', () => {
		expect(ShopOwner.prototype).toBeInstanceOf(Model)
		expect(ShopOwner.modelName).toBe('ShopOwner')
		expect(ShopOwner.collection.name).toBe('shopOwner')
		expect(ShopOwner.schema).toBeInstanceOf(Schema)
	})

	it('_id is a bare ObjectId path', () => {
		expect(ShopOwner.schema.path('_id').instance).toBe('ObjectId')
	})

	it('login: required embedded LoginSubDocSchema', () => {
		expectLoginSubDoc(ShopOwner.schema)
	})

	it('personalData: required embedded doc, _id disabled, own field shapes', () => {
		const personalDataSchema = expectPersonalDataSubDoc(ShopOwner.schema, undefined)

		// Every required flag below is pinned against the collection validator's own `required`
		// arrays, not against what the model happened to say. The two had drifted apart, and the
		// validator wins: it is what MongoDB enforces, and its migration is immutable.
		// ⚠️ Both names are plain `String` here and `EncryptedField` on `User` and `Admin`, and the
		// asymmetry is the decision ADR-029 records rather than an oversight: `shopOwnersActiveTbl`
		// sorts on `tbl_active_firstName` / `tbl_active_lastName_firstName` and prefix-searches both
		// with `/^term/i`. No CSFLE algorithm answers a sort or a regex, so encrypting them would not
		// slow the admin table, it would falsify it.
		const firstName = personalDataSchema.path('firstName')
		expect(firstName.instance).toBe('String')
		expect(firstName.isRequired).toBe(true)

		const lastName = personalDataSchema.path('lastName')
		expect(lastName.instance).toBe('String')
		expect(lastName.isRequired).toBe(true)

		const birth = personalDataSchema.path('birth')
		expect(birth.instance).toBe('Embedded')
		expect(birth.isRequired).toBe(true)
		const birthSchema = (birth as unknown as { schema: Schema }).schema
		// `_id: false` is load-bearing here, not cosmetic. The validator declares `birth` with
		// `additionalProperties: false`, so the `_id` Mongoose adds by default is on its own enough
		// to make every write of this sub-object fail.
		expect(birthSchema.options._id).toBe(false)
		// The field is `date`. This model alone once carried a `data` spelling, which silently produced
		// a `birth` the validator refused; guarded explicitly so the dead spelling cannot come back.
		expect(birthSchema.path('data')).toBeUndefined()
		// Encrypted, and `plaintext: 'date'` — the path still casts a date string to a `Date` on the
		// way in, which is the whole reason it is not `Schema.Types.Mixed`.
		const date = birthSchema.path('date')
		expect(date.instance).toBe('EncryptedField')
		expect(date.options.plaintext).toBe('date')
		expect(date.isRequired).toBe(true)

		const address = personalDataSchema.path('address')
		expect(address.instance).toBe('Embedded')
		expect(address.isRequired).toBe(true)
		const addressSchema = (address as unknown as { schema: Schema }).schema
		// Three of the four inherited paths are re-declared encrypted by the clone. `city` is the
		// fourth and stays a `String` for the reason the block above `firstName` gives — it is the
		// `tbl_active_city` sort key.
		for (const p of ['street', 'postalCode', 'province']) {
			const path = addressSchema.path(p)
			expect(path.instance, p).toBe('EncryptedField')
			expect(path.options.plaintext, p).toBe('string')
			expect(path.isRequired, p).toBe(true)
		}
		expect(addressSchema.path('city').instance).toBe('String')

		// The geo point the admin app draws a map from — and, unlike the company's, **not
		// required**. Every shopOwner in the collection was written before this path existed, so a
		// required one would make each of them fail validation on the next save: an admin fixing a
		// phone number would be stopped by an address nobody has re-picked yet.
		//
		// Flat rather than the nested GeoJSON sub-schema it used to be: the point is encrypted whole
		// — random, the only algorithm defined for an object — so what sits on the path in the
		// database is a `binData` and a sub-schema under it would have nothing left to cast.
		// `validateShopOwnerPersonalData` in the admin resource service is what still checks its shape.
		const position = addressSchema.path('position')
		expect(position.instance).toBe('EncryptedField')
		expect(position.options.plaintext).toBe('object')
		expect(position.isRequired).toBeUndefined()
		expect(Object.keys(addressSchema.paths).sort()).toEqual(['city', 'position', 'postalCode', 'province', 'street'])

		// `contacts` had no path at all, so a document carrying one lost it on the way through the
		// model — while the validator lists it in `personalData.required`. Both failure directions are
		// pinned: the sub-schema exists, and it carries no implicit `_id`.
		const contacts = personalDataSchema.path('contacts')
		expect(contacts.instance).toBe('Embedded')
		expect(contacts.isRequired).toBe(true)
		const contactsSchema = (contacts as unknown as { schema: Schema }).schema
		expect(contactsSchema.options._id).toBe(false)

		// All three encrypted, all three random: nothing queries a contact detail.
		const mobile = contactsSchema.path('mobile')
		expect(mobile.instance).toBe('EncryptedField')
		expect(mobile.options.plaintext).toBe('string')
		expect(mobile.isRequired).toBe(true)

		// The one optional contact — the validator requires only `mobile` and `email`.
		const landline = contactsSchema.path('landline')
		expect(landline.instance).toBe('EncryptedField')
		expect(landline.isRequired).toBeUndefined()

		// ⚠️ Not the credential — `login.email` is, and that one is deterministic. This is a second
		// address to be reached on and nothing looks an account up by it.
		const email = contactsSchema.path('email')
		expect(email.instance).toBe('EncryptedField')
		expect(email.isRequired).toBe(true)

		// No extra paths crept in: the validator is `additionalProperties: false` at both levels, so
		// anything this model adds beyond the list above is a write that MongoDB will reject.
		expect(Object.keys(personalDataSchema.paths).sort()).toEqual(['address', 'birth', 'contacts', 'firstName', 'lastName'])
		expect(Object.keys(contactsSchema.paths).sort()).toEqual(['email', 'landline', 'mobile'])
		expect(Object.keys(birthSchema.paths)).toEqual(['date'])
	})

	it('registeredAt: required Date', () => {
		const registeredAt = ShopOwner.schema.path('registeredAt')
		expect(registeredAt.instance).toBe('Date')
		expect(registeredAt.isRequired).toBe(true)
	})

	it('deleted/disabled/waitApprov/note/__v carry their plain types', () => {
		expect(ShopOwner.schema.path('deleted').instance).toBe('Date')
		expect(ShopOwner.schema.path('disabled').instance).toBe('Boolean')
		expect(ShopOwner.schema.path('waitApprov').instance).toBe('Boolean')
		// The admin's own free text about this account — never required, and never `personalData`:
		// it is what the platform wrote about the shopOwner, not what they declared themselves.
		// Encrypted all the same, and the one encrypted field here the subject never sees.
		const note = ShopOwner.schema.path('notes')
		expect(note.instance).toBe('EncryptedField')
		expect(note.options.plaintext).toBe('string')
		expect(note.isRequired).toBeUndefined()
		expect((ShopOwner.schema.path('__v') as unknown as { instance: string }).instance).toBe('Number')
	})

	/*
	 * The four lifecycle fields of ADR-041 and ADR-044, and the split between them is the design: three
	 * are ids and a timestamp the *server* minted, and one is free text an admin wrote about a
	 * person. Only the last is encrypted.
	 *
	 * ⚠️ `scrubbedAt` has to stay readable by the database. The retention sweep selects on its absence,
	 * `{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`, and neither CSFLE algorithm
	 * answers that — deterministic does equality only, random does nothing.
	 */
	it('carries the four lifecycle fields, three in the clear and only the reason encrypted', () => {
		const deletedBy = ShopOwner.schema.path('deletedBy')
		expect(deletedBy.instance).toBe('ObjectId')
		expect(deletedBy.isRequired).toBeUndefined()
		// Bare, not `ref: 'Admin'`: a populate would pull an admin's document into a read of this
		// collection, and the only tier that ever renders the name behind this id can look it up itself.
		expect((deletedBy.options as { ref?: string }).ref).toBeUndefined()

		const disabledBy = ShopOwner.schema.path('disabledBy')
		expect(disabledBy.instance).toBe('ObjectId')
		expect(disabledBy.isRequired).toBeUndefined()
		expect((disabledBy.options as { ref?: string }).ref).toBeUndefined()

		const scrubbedAt = ShopOwner.schema.path('scrubbedAt')
		expect(scrubbedAt.instance).toBe('Date')
		expect(scrubbedAt.isRequired).toBeUndefined()

		const reason = ShopOwner.schema.path('disabledReason')
		expect(reason.instance).toBe('EncryptedField')
		expect(reason.options.plaintext).toBe('string')
		// ⚠️ **Optional here and mandatory in the database, which is not a contradiction.** It is
		// required only *when `disabled` is true*, and Mongoose has no conditional requiredness that the
		// collection validator would agree with. The validator's `dependencies` carries the rule; a
		// `required: true` here would refuse every document that was never suspended.
		expect(reason.isRequired).toBeUndefined()
	})

	/*
	 * `.clone()` on the shared address schema is load-bearing, and this is what fails without it.
	 * `Schema.prototype.add` mutates in place: adding the point to `BaseAddressSchema` itself would
	 * put it on every model that embeds that address, which is most of them — and the shopOwner's
	 * point is optional while the company's is required, so they cannot be the same object.
	 *
	 * Imported here rather than asserted in `subschemas.test.mts`: vitest isolates module graphs per
	 * file, so the mutation only shows up in the file that also loads `ShopOwner.mts`.
	 */
	it('leaves the shared BaseAddressSchema without a position', async () => {
		// Aliased because the module is also imported statically at the top of this file, and the two
		// bindings must stay distinguishable: `no-shadow` flags the collision, and reusing the name
		// would make the dynamic import look removable when it is the whole point of the test.
		const { BaseAddressSchema: BaseAddressSchemaReimported } = await import('../src/models/MongoDB/sub/BaseAddressSchema.mts')
		expect(BaseAddressSchemaReimported.path('position')).toBeUndefined()
		expect(Object.keys(BaseAddressSchemaReimported.paths).sort()).toEqual(['city', 'postalCode', 'province', 'street'])
	})

	// The two token sub-documents are asserted together, and their disjointness is the assertion that
	// matters. koa-utils documents what happens when the password-reset token and the activation
	// token share a slot: a hash issued by either flow authenticates the other, and an
	// unauthenticated reset request kills every pending activation link. Neither may be `required` —
	// both are absent on an shopOwner that has requested neither.
	it('resetPwd and emailVerify are distinct, optional, disjoint sub-documents', () => {
		expectResetPwdAndEmailVerify(ShopOwner.schema)
	})
})

/*
 * The domain-neutral catalogue entry. What is asserted here is mostly what is *absent*: a new
 * product type is a document in `itemCategory`, not a file here.
 */
describe('Item schema — full field verification', () => {
	it('_id is a bare ObjectId path', () => {
		expect(Item.schema.path('_id').instance).toBe('ObjectId')
	})

	// Both links are required, and both name a model rather than a collection — `ref` is resolved
	// against mongoose's model registry, so the capitalised name is the correct spelling and 'item'
	// would silently populate nothing.
	it('idCompany: ObjectId, required, ref Company', () => {
		const p = Item.schema.path('idCompany')
		expect(p.instance).toBe('ObjectId')
		expect(p.isRequired).toBe(true)
		expect((p.options as { ref?: string }).ref).toBe('Company')
	})

	// Required, and this is the field the two-level taxonomy hangs off: an item filed under nothing
	// cannot be reached by any category query, which is the only way the public tier lists a shop's
	// catalogue at all.
	it('idCategory: ObjectId, required, ref ItemCategory', () => {
		const p = Item.schema.path('idCategory')
		expect(p.instance).toBe('ObjectId')
		expect(p.isRequired).toBe(true)
		expect((p.options as { ref?: string }).ref).toBe('ItemCategory')
	})

	it('name, description and slug are required strings', () => {
		for (const name of ['name', 'description', 'slug']) {
			const path = Item.schema.path(name)
			expect(path.instance, name).toBe('String')
			expect(path.isRequired, name).toBe(true)
		}
	})

	// Required like `company.published`, and for the same reason: the collection was created empty,
	// so no stored document is stranded by the requirement. It is what lets an owner draft an item without
	// it appearing on an indexed page.
	it('published: required Boolean', () => {
		const published = Item.schema.path('published')
		expect(published.instance).toBe('Boolean')
		expect(published.isRequired).toBe(true)
	})

	// Soft delete, the platform convention — a Date, so the document records *when*, and optional, since a
	// `required: true` mutant here would make every live item unsaveable.
	it('deleted: optional Date, not a flag', () => {
		const deleted = Item.schema.path('deleted')
		expect(deleted.instance).toBe('Date')
		expect(deleted.isRequired).toBeUndefined()
	})

	/*
	 * ⚠️ The absence of `price` is asserted, not merely unwritten.
	 *
	 * Cart, order, delivery and payment are permanently out of scope on this platform (ADR-038,
	 * 2026-08-27), so a price would be a guess at a currency, a precision, a VAT treatment and a
	 * discount model at once, with nothing that will ever resolve the guess — and the
	 * collection validator is `additionalProperties: false`, so a path added here in good faith fails
	 * every write of every item rather than being quietly ignored.
	 */
	// The picture's file name, and optional on purpose: the name is `<_id>.webp` and so derivable, but
	// *whether the file exists* is not, and that is the question a catalogue card asks before it picks
	// between a picture and a placeholder. A `required: true` mutant here makes every imageless item
	// unsaveable, which is what `isRequired` pins.
	it('image: optional String, the file name only', () => {
		const image = Item.schema.path('image')
		expect(image.instance).toBe('String')
		expect(image.isRequired).toBeUndefined()
	})

	it('carries no price, and nothing else beyond the validator property list', () => {
		expect(Item.schema.path('price')).toBeUndefined()
		expect(Item.schema.path('__v').instance).toBe('Number')
		expect(Object.keys(Item.schema.paths).sort()).toEqual(
			['_id', '__v', 'idCompany', 'idCategory', 'name', 'description', 'slug', 'published', 'image', 'deleted'].sort()
		)
	})
})

describe('ItemCategory schema — full field verification', () => {
	it('_id is a bare ObjectId path', () => {
		expect(ItemCategory.schema.path('_id').instance).toBe('ObjectId')
	})

	it('name and slug are required strings', () => {
		for (const name of ['name', 'slug']) {
			const path = ItemCategory.schema.path(name)
			expect(path.instance, name).toBe('String')
			expect(path.isRequired, name).toBe(true)
		}
	})

	/*
	 * Optional and self-referential: absent on a top-level category, present on a subcategory.
	 *
	 * ⚠️ It looks unconstrained here because it cannot be constrained here. "My parent must itself be
	 * top-level" reads a *second* document, and a Mongoose path — like a `$jsonSchema` validator —
	 * sees exactly one. The two-level cap lives in `itemCategoryAdd` / `itemCategoryUpdate` in the
	 * Admin resource service, which is why those are the only write path the collection has.
	 */
	it('idParent: optional ObjectId, ref back to ItemCategory itself', () => {
		const p = ItemCategory.schema.path('idParent')
		expect(p.instance).toBe('ObjectId')
		expect(p.isRequired).toBeUndefined()
		expect((p.options as { ref?: string }).ref).toBe('ItemCategory')
	})

	/*
	 * ⚠️ A **sort ordinal**, and a Number — nothing to do with the GeoJSON `position` on
	 * `Company.address` and `User.addresses[]`, which is an embedded document with a `type` and a
	 * coordinate pair. The two share a field name and nothing else, and the instance check below is
	 * what tells them apart: a mutant (or a copy-paste from the neighbouring model) that turned this
	 * into the geo shape would still be a defined path answering to the same name.
	 */
	it('position: required Number, a sort ordinal and not a geo point', () => {
		const position = ItemCategory.schema.path('position')
		expect(position.instance).toBe('Number')
		expect(position.isRequired).toBe(true)
		expect((position as unknown as { schema?: Schema }).schema).toBeUndefined()
	})

	it('deleted: optional Date, and nothing beyond the validator property list', () => {
		const deleted = ItemCategory.schema.path('deleted')
		expect(deleted.instance).toBe('Date')
		expect(deleted.isRequired).toBeUndefined()
		expect(ItemCategory.schema.path('__v').instance).toBe('Number')
		expect(Object.keys(ItemCategory.schema.paths).sort()).toEqual(
			['_id', '__v', 'name', 'slug', 'idParent', 'position', 'deleted'].sort()
		)
	})
})

/*
 * The customer. It mirrors `ShopOwner` — role on this platform is which collection you authenticate
 * against, not a field — and every assertion below that differs from the ShopOwner block above is one
 * of the four deliberate divergences: an optional `personalData`, an `addresses` **array**, the
 * `defaultAddress` pointer, and no `waitApprov`.
 */
describe('User schema — full field verification', () => {
	// Dynamically imported for the same reason ShopOwner is: `personalData` is declared with an inline
	// `_id: false`, which mongoose only special-cases as a literal `false`. A mutant flipping it falls
	// through to interpretAsType and throws while the Schema is being built — during Vitest's
	// collection phase for a static import, where Stryker cannot attribute the failure to a test and
	// reports the mutant Survived.
	let User: (typeof import('../src/models/MongoDB/User.mts'))['User']

	beforeAll(async () => {
		;({ User } = await import('../src/models/MongoDB/User.mts'))
	})

	it('registers with the right name and collection', () => {
		expect(User.prototype).toBeInstanceOf(Model)
		expect(User.modelName).toBe('User')
		expect(User.collection.name).toBe('user')
		expect(User.schema).toBeInstanceOf(Schema)
	})

	it('_id is a bare ObjectId path', () => {
		expect(User.schema.path('_id').instance).toBe('ObjectId')
	})

	it('login: required embedded LoginSubDocSchema, the same one ShopOwner and Admin carry', () => {
		expectLoginSubDoc(User.schema)
	})

	/*
	 * ⚠️ Divergence 1: **optional**, where the shop owner's is required.
	 *
	 * Registration is an email and a password and nothing else — the collection's `required` array is
	 * `login` and `registeredAt` alone — so a required `personalData` here would refuse every document
	 * the registration mutation writes.
	 */
	it('personalData: optional embedded doc, _id disabled, two required names and nothing more', () => {
		const personalData = User.schema.path('personalData')
		expect(personalData.instance).toBe('Embedded')
		expect(personalData.isRequired).toBeUndefined()

		const personalDataSchema = (personalData as unknown as { schema: Schema }).schema
		// `additionalProperties: false` in the validator, so the `_id` mongoose adds by default is on
		// its own enough to make every write of this sub-object fail.
		expect(personalDataSchema.options._id).toBe(false)

		// Encrypted, unlike the shop owner's two — there is no admin table over this collection, so
		// nothing sorts or prefix-searches a customer's name.
		for (const name of ['firstName', 'lastName']) {
			const path = personalDataSchema.path(name)
			expect(path.instance, name).toBe('EncryptedField')
			expect(path.options.plaintext, name).toBe('string')
			expect(path.isRequired, name).toBe(true)
		}

		// Both sub-objects are optional — a customer types a name into a profile page and leaves the
		// rest — and both are `_id: false` for the reason above.
		const birth = personalDataSchema.path('birth')
		expect(birth.instance).toBe('Embedded')
		expect(birth.isRequired).toBeUndefined()
		const birthSchema = (birth as unknown as { schema: Schema }).schema
		expect(birthSchema.options._id).toBe(false)
		const date = birthSchema.path('date')
		expect(date.instance).toBe('EncryptedField')
		expect(date.options.plaintext).toBe('date')
		// Required *within* an optional parent: a birth sub-object that exists at all must carry the
		// one field it is made of.
		expect(date.isRequired).toBe(true)
		expect(Object.keys(birthSchema.paths)).toEqual(['date'])

		const contacts = personalDataSchema.path('contacts')
		expect(contacts.instance).toBe('Embedded')
		expect(contacts.isRequired).toBeUndefined()
		const contactsSchema = (contacts as unknown as { schema: Schema }).schema
		expect(contactsSchema.options._id).toBe(false)
		// Every member optional, unlike the shop owner's required `mobile` and `email`. The account's
		// address is `login.email` and is the credential; these are a second way to be reached, and
		// requiring one would put a phone number in the way of an account that only needs an inbox.
		for (const name of ['mobile', 'landline', 'email']) {
			const path = contactsSchema.path(name)
			expect(path.instance, name).toBe('EncryptedField')
			expect(path.options.plaintext, name).toBe('string')
			expect(path.isRequired, name).toBeUndefined()
		}
		expect(Object.keys(contactsSchema.paths).sort()).toEqual(['email', 'landline', 'mobile'])

		// ⚠️ No `address` here. A customer's addresses are the top-level array below, with mutations of
		// their own — one address in this object would make "save my profile" able to overwrite an
		// entry in that array.
		expect(personalDataSchema.path('address')).toBeUndefined()
		expect(Object.keys(personalDataSchema.paths).sort()).toEqual(['birth', 'contacts', 'firstName', 'lastName'])
	})

	/*
	 * ⚠️ Divergence 2: an **array**, where the shop owner has one embedded address.
	 *
	 * ⚠️ And divergence 2b, the one thing in this package that keeps its `_id`: every other address
	 * sub-schema here is `{ _id: false }`, because the collection validators declare their embedded
	 * address `additionalProperties: false` and an unasked-for `_id` fails the write. This one is an
	 * array element that `defaultAddress` names by id, so the `user` validator lists `_id` in the
	 * element's `required` — and since `BaseAddressSchema` is `{ _id: false }` and `.clone()` carries
	 * the option across, the path has to be declared by hand with `auto: true`.
	 */
	it('addresses: array of the cloned base address, each element carrying an auto-minted _id', () => {
		const addresses = User.schema.path('addresses')
		expect(addresses.instance).toBe('Array')
		expect(addresses.isRequired).toBeUndefined()

		const elementSchema = (addresses as unknown as { schema: Schema }).schema
		// The clone kept the option, which is exactly why the explicit path below is needed.
		expect(elementSchema.options._id).toBe(false)
		const id = elementSchema.path('_id')
		expect(id.instance).toBe('ObjectId')
		expect((id.options as { auto?: boolean }).auto).toBe(true)

		// `city` included, unlike the shop owner's address: nothing sorts or searches a customer's, and
		// a customer reads their own document by `_id`.
		for (const name of ['street', 'postalCode', 'city', 'province']) {
			const path = elementSchema.path(name)
			expect(path.instance, name).toBe('EncryptedField')
			expect(path.options.plaintext, name).toBe('string')
			expect(path.isRequired, name).toBe(true)
		}

		// The customer's own name for the entry — "Home", "Office". Optional: an address saved from the
		// geocoder has no label until one is typed.
		const label = elementSchema.path('label')
		expect(label.instance).toBe('EncryptedField')
		expect(label.options.plaintext).toBe('string')
		expect(label.isRequired).toBeUndefined()

		// Optional, like the shop owner's and unlike the company's: the point arrives when the customer
		// picks an entry out of the geocoder's autocomplete, and an address typed by hand has none.
		//
		// Flat rather than the nested GeoJSON sub-schema the company's still is: the point is encrypted
		// whole — random, the only algorithm defined for an object — so the path holds a `binData` and
		// a sub-schema under it would have nothing to cast. `validateUserAddress` in the user resource
		// service is what still checks its shape.
		const position = elementSchema.path('position')
		expect(position.instance).toBe('EncryptedField')
		expect(position.options.plaintext).toBe('object')
		expect(position.isRequired).toBeUndefined()

		expect(Object.keys(elementSchema.paths).sort()).toEqual([
			'_id',
			'city',
			'label',
			'position',
			'postalCode',
			'province',
			'street'
		])
	})

	// The other half of the `.clone()` guarantee, asserted in the file that loads User.mts: `add()`
	// mutates in place, so an un-cloned call would put `_id`, `label` and `position` on the shared
	// address schema and on every model built from it afterwards.
	it('leaves the shared BaseAddressSchema without the customer additions', async () => {
		const { BaseAddressSchema: BaseAddressSchemaReimported } = await import('../src/models/MongoDB/sub/BaseAddressSchema.mts')
		expect(Object.keys(BaseAddressSchemaReimported.paths).sort()).toEqual(['city', 'postalCode', 'province', 'street'])
	})

	/*
	 * ⚠️ Divergence 3: a top-level **pointer**, with no counterpart on any other model.
	 *
	 * The obvious design — a boolean `default` on each array element — makes "two defaults" a state the
	 * database can hold and code has to police, and makes setting one a clear-all-then-set-one two-step
	 * with a window in which zero or two are default. A single ObjectId naming an element of
	 * `addresses[]` makes the second default inexpressible and the write a single atomic `$set`.
	 *
	 * The one failure a pointer *can* have is dangling, and that is checkable — so it is checked, by
	 * the collection's `$expr` clause and not by this path. Which is why the path is a bare, unreferenced
	 * ObjectId here: `ref` would be a lie (it points inside this same document, not at a collection).
	 */
	it('defaultAddress: an optional bare ObjectId pointing into addresses[], not a ref', () => {
		const defaultAddress = User.schema.path('defaultAddress')
		expect(defaultAddress.instance).toBe('ObjectId')
		expect(defaultAddress.isRequired).toBeUndefined()
		expect((defaultAddress.options as { ref?: string }).ref).toBeUndefined()
	})

	it('registeredAt: required Date', () => {
		const registeredAt = User.schema.path('registeredAt')
		expect(registeredAt.instance).toBe('Date')
		expect(registeredAt.isRequired).toBe(true)
	})

	/*
	 * ⚠️ Divergence 4: **no `waitApprov`**, and its absence is the assertion.
	 *
	 * A shop owner is held behind a manual approval gate an admin opens; a customer self-serves, and
	 * the only gate is `emailVerify.valid`, which `loginUser` checks. A `waitApprov` path added here by
	 * analogy with ShopOwner would be a field nothing ever clears — every customer stuck at
	 * registration.
	 */
	it('deleted/disabled/__v carry their plain types, and no approval gate exists', () => {
		expect(User.schema.path('deleted').instance).toBe('Date')
		expect(User.schema.path('disabled').instance).toBe('Boolean')
		expect(User.schema.path('__v').instance).toBe('Number')
		expect(User.schema.path('waitApprov')).toBeUndefined()
		// Nor the two ShopOwner-only onboarding fields, which live on `login` there and have no
		// customer equivalent — nothing walks a customer through anything.
		expect(User.schema.path('notes')).toBeUndefined()
	})

	// Same shape and the same disjointness as ShopOwner's. koa-utils documents what happens when the
	// password-reset token and the activation token share a slot: a hash issued by either flow
	// authenticates the other, and an unauthenticated reset request kills every pending activation
	// link. Neither may be required — both are absent on a customer who has requested neither.
	/*
	 * The four lifecycle fields of ADR-041 and ADR-044, and the split between them is the design: three
	 * are ids and a timestamp the *server* minted, and one is free text an admin wrote about a
	 * person. Only the last is encrypted.
	 *
	 * ⚠️ `scrubbedAt` has to stay readable by the database. The retention sweep selects on its absence,
	 * `{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`, and neither CSFLE algorithm
	 * answers that — deterministic does equality only, random does nothing.
	 */
	it('carries the four lifecycle fields, three in the clear and only the reason encrypted', () => {
		const deletedBy = User.schema.path('deletedBy')
		expect(deletedBy.instance).toBe('ObjectId')
		expect(deletedBy.isRequired).toBeUndefined()
		// Bare, not `ref: 'Admin'`: a populate would pull an admin's document into a read of this
		// collection, and the only tier that ever renders the name behind this id can look it up itself.
		expect((deletedBy.options as { ref?: string }).ref).toBeUndefined()

		const disabledBy = User.schema.path('disabledBy')
		expect(disabledBy.instance).toBe('ObjectId')
		expect(disabledBy.isRequired).toBeUndefined()
		expect((disabledBy.options as { ref?: string }).ref).toBeUndefined()

		const scrubbedAt = User.schema.path('scrubbedAt')
		expect(scrubbedAt.instance).toBe('Date')
		expect(scrubbedAt.isRequired).toBeUndefined()

		const reason = User.schema.path('disabledReason')
		expect(reason.instance).toBe('EncryptedField')
		expect(reason.options.plaintext).toBe('string')
		// ⚠️ **Optional here and mandatory in the database, which is not a contradiction.** It is
		// required only *when `disabled` is true*, and Mongoose has no conditional requiredness that the
		// collection validator would agree with. The validator's `dependencies` carries the rule; a
		// `required: true` here would refuse every document that was never suspended.
		expect(reason.isRequired).toBeUndefined()
	})

	it('resetPwd and emailVerify are distinct, optional, disjoint sub-documents', () => {
		expectResetPwdAndEmailVerify(User.schema)
	})

	it('declares exactly the collection validator property list', () => {
		expect(Object.keys(User.schema.paths).sort()).toEqual(
			[
				'_id',
				'__v',
				'login',
				'personalData',
				'addresses',
				'defaultAddress',
				'registeredAt',
				'deleted',
				'deletedBy',
				'disabled',
				'disabledBy',
				'disabledReason',
				'scrubbedAt',
				'resetPwd',
				'emailVerify'
			].sort()
		)
	})
})

describe('generateHashPassword instance method', () => {
	it('Admin hashes a password with bcrypt', async () => {
		const { Admin } = await import('../src/models/MongoDB/Admin.mts')
		const admin = new Admin({})
		const hash = await admin.generateHashPassword('super-secret')
		expect(hash).toMatch(/^\$2[aby]\$/)
	})

	it('ShopOwner hashes a password with bcrypt', async () => {
		const { ShopOwner } = await import('../src/models/MongoDB/ShopOwner.mts')
		const shopOwner = new ShopOwner({})
		const hash = await shopOwner.generateHashPassword('super-secret')
		expect(hash).toMatch(/^\$2[aby]\$/)
	})

	// The third one. A customer registers with a password like everybody else, so the same method has
	// to be on this model — the alternative is `loginUser` comparing a plaintext against a hash and
	// simply never matching.
	it('User hashes a password with bcrypt', async () => {
		const { User } = await import('../src/models/MongoDB/User.mts')
		const user = new User({})
		const hash = await user.generateHashPassword('super-secret')
		expect(hash).toMatch(/^\$2[aby]\$/)
		// Not the plaintext, and salted — two different hashes of the same password never collide,
		// which is the whole reason a bare equality check against a stored value is not a login.
		expect(hash).not.toBe('super-secret')
		expect(await user.generateHashPassword('super-secret')).not.toBe(hash)
	})
})
