import { randomBytes } from 'node:crypto'

import bcrypt from '@node-rs/bcrypt'
import { Binary } from 'mongodb'
import mongoose, { Types } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decryptValue, initFieldEncryption, resetFieldEncryption } from '../../src/encryption/fieldEncryption.mts'
import { isCiphertext } from '../../src/encryption/isCiphertext.mts'
import { Admin } from '../../src/models/MongoDB/Admin.mts'
import { Company } from '../../src/models/MongoDB/Company.mts'
import { ShopOwner } from '../../src/models/MongoDB/ShopOwner.mts'
import { TEST_DB } from '../../vitest.mongo.mts'

// This suite runs against the REAL throwaway MongoDB provisioned by test/integration/globalSetup.mts
// (MONGODB_URI is the R/W MONGO_TEST_* user — see vitest.integration.config.mts), not an in-memory
// server. Every document this file SAVES must have its _id registered here the moment the id is
// created — before the constructor call that could throw — and drained in the single afterAll below.
// Registering at creation time (not in a per-test try/finally) matters: a seed that throws before
// reaching its own cleanup step would otherwise leak the document into the shared throwaway database.
// The tracker calls exactly one method on whatever it is handed, so it is typed by that method and
// not by `Model<T>`. `mongoose.Model<any>` was the obvious spelling and the wrong one: the three
// models seeded here (Admin, Company, ShopOwner) have different document types, `Model<T>` is
// invariant in `T`, and `any` was the only argument that let them all through — at the cost of
// switching off checking on every use of the value. A structural type accepts the same models with
// no `any` and no cast at the call sites, and it also states the constraint that actually matters
// here: the cleanup loop must never do more to a seeded document than delete it by _id.
//
// `PromiseLike`, not `Promise`: mongoose returns a `Query`, which is a thenable but not a Promise —
// it has no `[Symbol.toStringTag]`, so it is not assignable to `Promise<unknown>`. `await` needs only
// the `then`.
interface DeletableModel {
	deleteOne(filter: { _id: Types.ObjectId }): PromiseLike<unknown>
}

const seeded: Array<{ model: DeletableModel; id: Types.ObjectId }> = []

function trackedId(model: DeletableModel): Types.ObjectId {
	const id = new Types.ObjectId()
	seeded.push({ model, id })
	return id
}

/*
 * ⚠️ The suite mints its OWN master key, per run, and keeps the key vault inside the throwaway
 * database.
 *
 * The four models carry `fieldEncryptionPlugin`, so from `20260808*` onward not one of them can save
 * or read a document until a `ClientEncryption` exists — the failure is
 * `Field encryption is not initialised`, on every test below. Something has to bring it up, and the
 * choice is between the platform's real key file and a throwaway.
 *
 * A throwaway, because this suite tests the models and not key management. Reading
 * `CSFLE_MASTER_KEY_PATH` would make a library that never boots a service depend on the one secret
 * whose loss destroys production data, would fail a fresh clone that has never been handed it, and
 * would buy nothing: a key is 96 random bytes, and no assertion here can tell one from another. The
 * vault lives in `MONGO_TEST_DB` rather than the services' `encryption` database for the same reason
 * plus one more — globalSetup drops that database before every run, so the keys never outlive the key
 * that wrapped them, and the R/W user the models connect with holds `readWrite` on it and nothing
 * else.
 */
beforeAll(async () => {
	await mongoose.connect(process.env.MONGODB_URI as string)
	await initFieldEncryption({
		client: mongoose.connection.getClient(),
		keyVaultNamespace: `${TEST_DB}.__keyVault`,
		masterKey: randomBytes(96)
	})
})

afterAll(async () => {
	for (const { model, id } of seeded) {
		await model.deleteOne({ _id: id })
	}
	resetFieldEncryption()
	await mongoose.disconnect()
})

/*
 * The company as its own collection, after migrations 20260803000000 / 20260803000100. Asserted on
 * the RAW stored documents rather than the hydrated ones, for the same reason the ShopOwner block
 * below does: a hydrated read echoes back whatever the model believes the shape is, and the shape is
 * exactly what is under test. This throwaway database carries no `$jsonSchema` of its own, so what is
 * pinned here is the half that lives in this repo — the document the model hands to Mongo.
 */
describe('Company and the reference that replaced the embedded company', () => {
	const address = {
		street: '4 Harbour Road',
		postalCode: '02110',
		city: 'Boston',
		province: 'MA',
		position: { type: 'Point', coordinates: [-71.05012, 42.35631] }
	}

	function companyDoc(_id: Types.ObjectId, extra: Record<string, unknown> = {}) {
		return {
			_id,
			idShopOwner: new Types.ObjectId(),
			legalName: 'Riverside Trading Ltd',
			vatNumber: _id.toHexString().slice(0, 11),
			contactPerson: 'Mark Rivers',
			administrator: 'Mark Rivers',
			certifiedEmail: `${_id.toHexString()}@certified.test`,
			address,
			registryExtract: 'registry/riverside.pdf',
			// Required since 20260804010000-alter-company-public, and `false` is the honest default:
			// a company registered before the catalogue existed has never been reviewed for public
			// display. `true` would additionally need `slug` and `publicName`, which the collection's
			// `$expr` clause enforces — see the publish rule in `lib/schemas/company.js`.
			published: false,
			...extra
		}
	}

	it('requires idShopOwner and the company fields the validator lists', async () => {
		// Never saved — validation only, no cleanup needed.
		const err = await new Company({}).validate().catch((e: unknown) => e)

		expect(err).toBeInstanceOf(mongoose.Error.ValidationError)
		const paths = Object.keys((err as mongoose.Error.ValidationError).errors)
		expect(paths).toEqual(
			expect.arrayContaining([
				'idShopOwner',
				'legalName',
				'vatNumber',
				'contactPerson',
				'administrator',
				'certifiedEmail',
				'address',
				'registryExtract',
				'published'
			])
		)
		// The ones the validator leaves out of its `required` array must not be errors here either.
		// `publicName`, `slug` and `description` join the original three: a company may exist without
		// a storefront, and the `$expr` clause only demands them once `published` is true.
		expect(paths).not.toContain('taxCode')
		expect(paths).not.toContain('uniqueCode')
		expect(paths).not.toContain('deleted')
		expect(paths).not.toContain('publicName')
		expect(paths).not.toContain('slug')
		expect(paths).not.toContain('description')
	})

	it('stores deleted as a Date, so the company is soft-deleted rather than removed', async () => {
		const _id = trackedId(Company)
		const when = new Date('2026-08-04T09:15:00Z')
		await new Company(companyDoc(_id, { deleted: when })).save()

		const raw = await mongoose.connection.db!.collection('company').findOne({ _id })

		expect(raw).not.toBeNull()
		// A Date on the way in and a Date on the way out. Mongoose casts a boolean to a Date happily
		// enough — `new Date(true)` is the epoch plus a millisecond — so the type matters more here
		// than the value, and the document is still there, which is the point of the field.
		expect(raw!.deleted).toBeInstanceOf(Date)
		expect((raw!.deleted as Date).toISOString()).toBe(when.toISOString())
	})

	it('stores the address and its point with no _id on either sub-object', async () => {
		const _id = trackedId(Company)
		await new Company(companyDoc(_id, { taxCode: '01234567890' })).save()

		const raw = await mongoose.connection.db!.collection('company').findOne({ _id })

		expect(raw).not.toBeNull()
		// toEqual, not a key check: it pins that mongoose added no `_id` to `address` or to
		// `position`, which the collection's `additionalProperties: false` would reject outright.
		expect(raw!.address).toEqual(address)
		expect(raw!.taxCode).toBe('01234567890')
	})

	/*
	 * ⚠️ The company's address is the storefront's address, and it stays in the clear on purpose — the
	 * assertion above is the one that would break first if anybody added it to
	 * `ENCRYPTED_FIELDS_COMPANY`, because `address.position_2dsphere`, `published_city_publicName` and
	 * `search_text` all read it. What is encrypted here is the two natural persons the legal entity
	 * carries, and nothing else.
	 *
	 * Read raw, never hydrated. `Company.findById` runs the plugin's decrypt on the way back, so a
	 * hydrated document reads identically whether the field was stored as ciphertext or written
	 * straight through in the clear — which is exactly the bug this asserts against.
	 */
	it('stores contactPerson and administrator as ciphertext, and the entity fields in the clear', async () => {
		const _id = trackedId(Company)
		await new Company(companyDoc(_id)).save()

		const raw = await mongoose.connection.db!.collection('company').findOne({ _id })

		expect(isCiphertext(raw!.contactPerson)).toBe(true)
		expect(isCiphertext(raw!.administrator)).toBe(true)
		// Round-trip, not just "it is a blob": ciphertext of the wrong value is still subtype 6.
		expect(await decryptValue(raw!.contactPerson as Binary)).toBe('Mark Rivers')
		expect(await decryptValue(raw!.administrator as Binary)).toBe('Mark Rivers')

		// The entity's own identifiers, untouched — a registrar's data about a company is not personal
		// data, and `vatNumber` additionally carries a unique index that ciphertext would defeat.
		expect(raw!.legalName).toBe('Riverside Trading Ltd')
		expect(raw!.vatNumber).toBe(_id.toHexString().slice(0, 11))
		expect(raw!.certifiedEmail).toBe(`${_id.toHexString()}@certified.test`)

		// And the hydrated read gives the plaintext back, which is what every resolver sees.
		const found = await Company.findById(_id)
		expect(found!.contactPerson).toBe('Mark Rivers')
		expect(found!.administrator).toBe('Mark Rivers')
	})
})

describe('Admin login.password pre-save hook', () => {
	it('hashes login.password on save (single-nested subdoc pre-save hook fires)', async () => {
		const plaintext = 'super-secret-plaintext'
		const _id = trackedId(Admin)
		const admin = new Admin({
			_id,
			login: { email: `${_id.toHexString()}@example.test`, password: plaintext },
			personalData: { firstName: 'Mark', lastName: 'Rivers' }
		})
		await admin.save()

		const found = await Admin.findById(admin._id)
		expect(found).not.toBeNull()
		// Actual observed behavior: mongoose DOES fire pre('save') hooks on required
		// single-nested subdocuments as part of the parent's save, so the hash hook runs.
		expect(found!.login.password).toMatch(/^\$2[aby]\$/)
		expect(found!.login.password).not.toBe(plaintext)
		const matches = await bcrypt.verify(plaintext, found!.login.password)
		expect(matches).toBe(true)
	})

	/*
	 * ⚠️ **`login.password` must NOT be encrypted, and this is the assertion that says so.** It is the
	 * one sensitive field on the platform that is deliberately absent from every list in
	 * `encryptedFields.mts`, and the reasoning inverts the usual one: it is already a bcrypt hash, so
	 * encrypting it protects nothing that is not protected, and it would make every login a decrypt
	 * before the compare. `login.email` beside it IS encrypted — deterministically, because
	 * `findOne({ 'login.email': … })` is the first thing every sign-in does and deterministic
	 * ciphertext is the only kind an equality filter can still match.
	 */
	it('encrypts login.email deterministically and leaves the bcrypt hash alone', async () => {
		const _id = trackedId(Admin)
		const email = `${_id.toHexString()}@example.test`
		await new Admin({
			_id,
			login: { email, password: 'super-secret-plaintext' },
			personalData: { firstName: 'Mark', lastName: 'Rivers' }
		}).save()

		const raw = await mongoose.connection.db!.collection('admin').findOne({ _id })
		const login = raw!.login as Record<string, unknown>
		const personalData = raw!.personalData as Record<string, unknown>

		expect(isCiphertext(login.email)).toBe(true)
		expect(isCiphertext(personalData.firstName)).toBe(true)
		expect(isCiphertext(personalData.lastName)).toBe(true)
		expect(typeof login.password).toBe('string')
		expect(login.password as string).toMatch(/^\$2[aby]\$/)

		// Deterministic means the same plaintext yields the same bytes, which is the whole reason the
		// sign-in lookup still works. Asserted by doing the lookup: `findOne` on the model encrypts the
		// filter value through `encryptFilter` and has to land on this document.
		const byEmail = await Admin.findOne({ 'login.email': email })
		expect(byEmail!._id.toHexString()).toBe(_id.toHexString())
		expect(byEmail!.personalData.firstName).toBe('Mark')
	})
})

describe('generateHashPassword instance method', () => {
	it('Admin.generateHashPassword produces a verifiable bcrypt hash', async () => {
		// Never saved — this only exercises the instance method, no cleanup needed.
		const admin = new Admin({})
		const hash = await admin.generateHashPassword('pw')
		expect(hash).toMatch(/^\$2[aby]\$/)
		const matches = await bcrypt.verify('pw', hash)
		expect(matches).toBe(true)
	})
})

describe('ShopOwner.personalData survives a real round trip intact', () => {
	/**
	 * Saves one fully-populated shopOwner through the model — so the plugin encrypts on the way in —
	 * and hands back what MongoDB really stored, read with the raw driver.
	 *
	 * Both tests below need exactly this document and exactly this read, and neither may use the
	 * hydrated one: a hydrated read echoes back whatever the model believes the shape is, which is the
	 * thing under test in the first and decrypts the values it inspects in the second.
	 */
	async function saveAndReadRaw() {
		const _id = trackedId(ShopOwner)
		await new ShopOwner({
			_id,
			login: { email: `${_id.toHexString()}@example.test`, password: 'super-secret-plaintext' },
			personalData: {
				firstName: 'Mark',
				lastName: 'Rivers',
				birth: { date: new Date('1970-11-24T00:00:00Z') },
				address: { street: '1 Main Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
				contacts: { mobile: '3900000000', email: 'contact@example.test' }
			},
			registeredAt: new Date()
		}).save()

		return mongoose.connection.db!.collection('shopOwner').findOne({ _id })
	}

	/*
	 * The regression guard for a divergence between this model and the `shopOwner` collection
	 * validator in marketplace-db-setup. The model used to spell `birth.date` as `date` and had no
	 * `contacts` path at all, so casting a correct document through it silently produced a different
	 * one: `contacts` was dropped, `birth` came out as a bare `{ _id }`, and the write was then
	 * rejected by a validator that declares both sub-objects `additionalProperties: false`.
	 *
	 * Asserted on the RAW stored document rather than the hydrated one. A hydrated read would echo
	 * back whatever the model thinks the shape is, which is exactly the thing under test; the raw
	 * driver shows what MongoDB actually received. This throwaway database carries no `$jsonSchema`
	 * validator of its own (see globalSetup.mts) — this pins the shape the model emits, which is the
	 * half that lives in this repo.
	 */
	it('stores birth.date and contacts, and adds no _id to either sub-object', async () => {
		const raw = await saveAndReadRaw()

		expect(raw).not.toBeNull()
		const personalData = raw!.personalData as Record<string, unknown>
		// No extra key: mirrors the collection validator's `additionalProperties: false`, under which
		// any surplus would be a rejected write in the real (migrated) database.
		expect(Object.keys(personalData).sort()).toEqual(['address', 'birth', 'contacts', 'firstName', 'lastName'])
		// The shape survives encryption — same keys, no `_id` added alongside — while the values are
		// blobs. Key sets rather than `toEqual` on the whole sub-object, because random ciphertext
		// differs on every run and there is nothing to compare it against.
		expect(Object.keys(personalData.birth as Record<string, unknown>)).toEqual(['date'])
		expect(Object.keys(personalData.contacts as Record<string, unknown>).sort()).toEqual(['email', 'mobile'])
		expect(await decryptValue((personalData.birth as Record<string, unknown>).date as Binary)).toEqual(
			new Date('1970-11-24T00:00:00Z')
		)
		expect(await decryptValue((personalData.contacts as Record<string, unknown>).mobile as Binary)).toBe('3900000000')
		expect(await decryptValue((personalData.contacts as Record<string, unknown>).email as Binary)).toBe('contact@example.test')
	})

	/*
	 * ⚠️ **`firstName`, `lastName` and `address.city` are the three fields on this collection that stay
	 * in the clear, and this test exists to make that a decision rather than an oversight.**
	 *
	 * They are personal data, and they are the only personal data on the platform left unencrypted.
	 * `shopOwnersActiveTbl` in the Admin tier sorts on all three — `tbl_active_lastName_firstName`,
	 * `tbl_active_firstName`, `tbl_active_city` — and prefix-searches them with `/^term/i`. Neither
	 * CSFLE algorithm survives that: random supports no comparison at all, deterministic supports
	 * equality and nothing more, so neither answers a sort or a prefix match. Encrypting them would not
	 * make the operator table slow, it would make it silently wrong. ADR-029 records the trade.
	 *
	 * The assertion is deliberately two-sided. A future change that encrypts them fails here and is
	 * told where to look; a change that drops the three indexes and closes the hole updates this test
	 * in the same commit, which is the point.
	 */
	it('leaves the three sort keys in the clear and encrypts the rest of the address', async () => {
		const raw = await saveAndReadRaw()
		const personalData = raw!.personalData as Record<string, unknown>
		const address = personalData.address as Record<string, unknown>

		expect(personalData.firstName).toBe('Mark')
		expect(personalData.lastName).toBe('Rivers')
		expect(address.city).toBe('Springfield')

		expect(isCiphertext(address.street)).toBe(true)
		expect(isCiphertext(address.postalCode)).toBe(true)
		expect(isCiphertext(address.province)).toBe(true)
		expect(await decryptValue(address.street as Binary)).toBe('1 Main Street')
	})

	it('rejects an personalData missing the fields the collection validator requires', async () => {
		// Never saved — validation only, no cleanup needed.
		const err = await new ShopOwner({ personalData: {} }).validate().catch((e: unknown) => e)

		expect(err).toBeInstanceOf(mongoose.Error.ValidationError)
		const paths = Object.keys((err as mongoose.Error.ValidationError).errors)
		expect(paths).toEqual(
			expect.arrayContaining([
				'personalData.firstName',
				'personalData.lastName',
				'personalData.birth',
				'personalData.address',
				'personalData.contacts'
			])
		)
		// `landline` is the one contact the validator leaves optional, so its absence must not be an error.
		expect(paths).not.toContain('personalData.contacts.landline')
	})
})

/*
 * The `emailVerify` half of the same guard. It is asserted through real writes rather than through the
 * schema alone because what breaks here breaks at write time, not at build time: the koa-utils
 * verify-email flow never writes the sub-document whole, and the `shopOwner` validator declares it
 * `additionalProperties: false` with no `required` array. So the states this suite reproduces —
 * `setEmailHash`'s hash/dateLastReq/requestTimes with no `valid`, and `enableEmailAccess`'s `valid`
 * with the other three gone — are documents Mongo has to accept, and a stray `_id` or a `required`
 * member would make each of them a rejected write on the very next call.
 *
 * Raw driver reads again, not hydrated ones: a hydrated read echoes back whatever the model believes
 * the shape is, which is the thing under test.
 */
describe('ShopOwner.emailVerify round-trips in every state the verify-email flow produces', () => {
	const personalData = {
		firstName: 'Julia',
		lastName: 'White',
		birth: { date: new Date('1982-03-09T00:00:00Z') },
		address: { street: '9 Green Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
		contacts: { mobile: '3900000001', email: 'julia@example.test' }
	}

	async function seed(_id: Types.ObjectId, emailVerify: Record<string, unknown> | undefined) {
		await new ShopOwner({
			_id,
			login: { email: `${_id.toHexString()}@example.test`, password: 'super-secret-plaintext' },
			personalData,
			registeredAt: new Date(),
			emailVerify
		}).save()

		return await mongoose.connection.db!.collection('shopOwner').findOne({ _id })
	}

	// The state `setEmailHash` leaves behind. `valid` is absent on purpose — it is the field the flow
	// does not touch until the link is honoured, so requiring it would reject the very first write.
	it('stores the post-setEmailHash state, with no valid and no _id', async () => {
		const _id = trackedId(ShopOwner)
		const dateLastReq = new Date('2026-07-20T10:00:00Z')
		const raw = await seed(_id, { hash: 'x'.repeat(50), requestTimes: 1, dateLastReq })

		expect(raw!.emailVerify).toEqual({ hash: 'x'.repeat(50), requestTimes: 1, dateLastReq })
	})

	// The state `enableEmailAccess` leaves behind, once `verifyClear` has unset the other three.
	it('stores the post-enableEmailAccess state, valid alone', async () => {
		const _id = trackedId(ShopOwner)
		const raw = await seed(_id, { valid: true })

		expect(raw!.emailVerify).toEqual({ valid: true })
	})

	// `requestTimes` has to reach Mongo as a BSON int, because the collection validator spells it
	// `bsonType: 'int'` and BSON double fails that check — a `Number` path plus an integral JS value is
	// what makes the driver pick int32. This throwaway database carries no validator of its own, so the
	// type is read off the stored value directly; asserting only the number would pass on a double and
	// the real (migrated) write would then be rejected in production.
	it('stores requestTimes as a BSON int, not a double', async () => {
		const _id = trackedId(ShopOwner)
		await seed(_id, { hash: 'y'.repeat(50), requestTimes: 3, dateLastReq: new Date() })

		const [doc] = await mongoose.connection
			.db!.collection('shopOwner')
			.aggregate([{ $match: { _id } }, { $project: { t: { $type: '$emailVerify.requestTimes' } } }])
			.toArray()

		expect(doc.t).toBe('int')
	})

	// An shopOwner who never asked for a link carries no `emailVerify` key at all — not an empty
	// object. Mongoose materialises a single-nested path only when a value is supplied, and the
	// difference matters: `{}` is a document the flow's `$unset`-based clears would leave behind
	// forever, and it is what an accidental `default: {}` would produce on every existing document.
	it('omits the key entirely when nothing was ever written', async () => {
		const _id = trackedId(ShopOwner)
		const raw = await seed(_id, undefined)

		expect(raw).not.toBeNull()
		expect('emailVerify' in raw!).toBe(false)
	})

	// resetPwd and emailVerify occupy separate slots on a real stored document, not just in the schema.
	it('keeps emailVerify.hash and resetPwd.resetHash in separate slots', async () => {
		const _id = trackedId(ShopOwner)
		await new ShopOwner({
			_id,
			login: { email: `${_id.toHexString()}@example.test`, password: 'super-secret-plaintext' },
			personalData,
			registeredAt: new Date(),
			emailVerify: { hash: 'e'.repeat(50) },
			resetPwd: { resetHash: 'r'.repeat(50), resetDateReq: new Date('2026-07-21T10:00:00Z') }
		}).save()

		const raw = await mongoose.connection.db!.collection('shopOwner').findOne({ _id })

		expect((raw!.emailVerify as Record<string, unknown>).hash).toBe('e'.repeat(50))
		expect((raw!.resetPwd as Record<string, unknown>).resetHash).toBe('r'.repeat(50))
	})
})
