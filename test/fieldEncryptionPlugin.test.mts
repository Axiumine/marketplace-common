import { Binary } from 'mongodb'
import { Schema } from 'mongoose'
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest'

import { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM } from '../src/encryption/EncryptionAlgorithm.mts'
import { fieldEncryptionPlugin } from '../src/encryption/fieldEncryptionPlugin.mts'
import { IEncryptedFieldSpec } from '../src/encryption/IEncryptedFieldSpec.mts'
import { Admin } from '../src/models/MongoDB/Admin.mts'
import { Company } from '../src/models/MongoDB/Company.mts'
import { Item } from '../src/models/MongoDB/Item.mts'
import { ShopOwner } from '../src/models/MongoDB/ShopOwner.mts'
import { User } from '../src/models/MongoDB/User.mts'
import { entryOf, plaintextOf, resetVault, vault } from './encryptionHarness.mts'

vi.mock('@encryption/fieldEncryption.mjs', async () => {
	const harness = await import('./encryptionHarness.mts')
	return { encryptValue: harness.fakeEncryptValue, decryptValue: harness.fakeDecryptValue }
})

const KEY = 'testKey'

/*
 * The hooks are driven through Kareem directly, which is where mongoose keeps them, so the whole
 * suite runs with no MongoDB and no connection. `execPre`/`execPost` apply the registered functions
 * to whatever `this` they are given — a stand-in query or document is enough, and is closer to what
 * is being asserted than a hydrated model would be.
 */
interface IKareem {
	_pres: Map<string, unknown[]>
	_posts: Map<string, unknown[]>
	execPre(name: string, context: unknown, args?: unknown[]): Promise<unknown>
	execPost(name: string, context: unknown, args: unknown[]): Promise<unknown>
}

function hooksOf(schema: Schema): IKareem {
	return (schema as unknown as { s: { hooks: IKareem } }).s.hooks
}

/**
 * A stand-in for the `Query` the filter and update hooks read. Both getters, plus the empty `$__`
 * that mongoose's own sharding plugin reads off a compiled model's hooks — running the built-ins
 * alongside ours is the price of driving Kareem directly, and an empty bag makes them no-ops.
 */
function queryContext(filter: unknown, update: unknown = null): unknown {
	return { getFilter: () => filter, getUpdate: () => update, $__: {} }
}

function valueAt(data: unknown, path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>(
			(node, key) => (node === null || node === undefined ? undefined : (node as Record<string, unknown>)[key]),
			data
		)
}

/**
 * A stand-in for the `Document` the save hook walks. `get` and `set` are all it touches, and `get` is
 * a spy because *which* paths it is asked for is itself part of the contract — see the array test.
 */
interface IDocumentContext {
	get: Mock<(path: string) => unknown>
	set: (path: string, value: unknown) => void
}

function documentContext(data: Record<string, unknown>): IDocumentContext {
	return {
		get: vi.fn((path: string) => valueAt(data, path)),
		set: (path: string, value: unknown) => {
			const keys = path.split('.')
			const last = keys.pop() as string
			const parent = keys.length === 0 ? data : (valueAt(data, keys.join('.')) as Record<string, unknown>)
			parent[last] = value
		}
	}
}

const FIELDS: IEncryptedFieldSpec[] = [
	{ path: 'login.email', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'notes', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].street', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'position', algorithm: ALGORITHM_RANDOM, plaintext: 'object' }
]

const schema = new Schema({}, { strict: false })
schema.plugin(fieldEncryptionPlugin, { fields: FIELDS, keyAltName: KEY })

const hooks = hooksOf(schema)

beforeEach(() => {
	resetVault()
})

/*
 * Every query kind that carries a filter is listed by name and exercised by name, rather than looped
 * over the exported array — the array is the thing under test, and a suite that reads it back would
 * pass just as happily with half of it deleted. A missing name here is a query whose filter goes to
 * the server in plaintext and quietly matches nothing.
 *
 * `estimatedDocumentCount` is absent because it takes no filter at all.
 */
describe.each([
	'find',
	'findOne',
	'findOneAndDelete',
	'findOneAndReplace',
	'findOneAndUpdate',
	'replaceOne',
	'updateOne',
	'updateMany',
	'deleteOne',
	'deleteMany',
	'countDocuments',
	'distinct'
])('the filter of %s', (name) => {
	it('is rewritten to ciphertext before it leaves the process', async () => {
		const filter: Record<string, unknown> = { 'login.email': 'a@b.test', deleted: { $exists: false } }

		await hooks.execPre(name, queryContext(filter))

		expect(plaintextOf(filter['login.email'])).toBe('a@b.test')
		expect(entryOf(filter['login.email'])).toEqual({ value: 'a@b.test', algorithm: ALGORITHM_DETERMINISTIC, keyAltName: KEY })

		// A field nobody declared is left exactly as it was, which is almost every filter here.
		expect(filter.deleted).toEqual({ $exists: false })
	})
})

describe.each(['findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'updateOne', 'updateMany'])('the update of %s', (name) => {
	it('is rewritten to ciphertext before it leaves the process', async () => {
		const update: Record<string, unknown> = { $set: { notes: 'a note', 'company.slug': 'a-shop' } }

		await hooks.execPre(name, queryContext({}, update))

		const set = update.$set as Record<string, unknown>
		expect(entryOf(set.notes)).toEqual({ value: 'a note', algorithm: ALGORITHM_RANDOM, keyAltName: KEY })
		expect(set['company.slug']).toBe('a-shop')
	})
})

/*
 * The count and update kinds are deliberately not here: they answer with a number, and walking one
 * is wasted work on the hottest path there is.
 */
describe.each(['find', 'findOne', 'findOneAndDelete', 'findOneAndReplace', 'findOneAndUpdate'])('the result of %s', (name) => {
	it('comes back decrypted', async () => {
		vault.push({ value: 'a@b.test', algorithm: ALGORITHM_DETERMINISTIC, keyAltName: KEY })
		const result = { login: { email: new Binary(Buffer.from('0'), Binary.SUBTYPE_ENCRYPTED) } }

		await hooks.execPost(name, null, [result])

		expect(result.login.email).toBe('a@b.test')
	})
})

describe('the count and update kinds', () => {
	it('have no result hook at all', () => {
		for (const name of ['countDocuments', 'distinct', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) {
			expect(hooks._posts.get(name)).toBeUndefined()
		}
	})
})

describe('save', () => {
	// `Model.create()` routes through `save()`, so this one hook covers both.
	it('encrypts every declared field, each under its own algorithm', async () => {
		const data: Record<string, unknown> = {
			login: { email: 'a@b.test', password: '$2b$14$hash' },
			notes: 'a note',
			position: { type: 'Point', coordinates: [9.19, 45.46] }
		}

		await hooks.execPre('save', documentContext(data))

		expect(entryOf(valueAt(data, 'login.email'))).toEqual({
			value: 'a@b.test',
			algorithm: ALGORITHM_DETERMINISTIC,
			keyAltName: KEY
		})
		expect(entryOf(data.notes)).toEqual({ value: 'a note', algorithm: ALGORITHM_RANDOM, keyAltName: KEY })
		expect(entryOf(data.position)).toEqual({
			value: { type: 'Point', coordinates: [9.19, 45.46] },
			algorithm: ALGORITHM_RANDOM,
			keyAltName: KEY
		})

		// A bcrypt hash is not personal data, and every login compares against it.
		expect(valueAt(data, 'login.password')).toBe('$2b$14$hash')
	})

	// `addresses.[].street` is not a path mongoose can `get`; `addresses.0.street` is, and which of
	// those exist depends on the document in hand.
	it('expands an array path into the elements the document actually has', async () => {
		const data: Record<string, unknown> = { addresses: [{ street: 'One Road' }, { street: 'Two Road' }] }
		const context = documentContext(data)

		await hooks.execPre('save', context)

		const addresses = data.addresses as Array<{ street: unknown }>
		expect(plaintextOf(addresses[0]?.street)).toBe('One Road')
		expect(plaintextOf(addresses[1]?.street)).toBe('Two Road')
		expect(vault).toHaveLength(2)

		// ⚠️ Asked for two elements and no third. One past the end reads `undefined`, which the loop
		// skips as an absent value — so an off-by-one costs nothing here and everything on a document
		// whose array is the last thing a resolver iterates.
		expect(context.get).not.toHaveBeenCalledWith('addresses.2.street')
	})

	it('writes a customer with no addresses through untouched', async () => {
		const data: Record<string, unknown> = { addresses: [] }

		await hooks.execPre('save', documentContext(data))

		expect(data.addresses).toEqual([])
		expect(vault).toHaveLength(0)
	})

	it('leaves an array path alone when the value is not an array', async () => {
		const data: Record<string, unknown> = { addresses: 'not an array' }

		await hooks.execPre('save', documentContext(data))

		expect(data.addresses).toBe('not an array')
		expect(vault).toHaveLength(0)
	})

	/*
	 * ⚠️ `null` and `undefined` pass through unencrypted, deliberately. Every one of these fields is
	 * optional somewhere — `notes` is absent on most shop owners — and encrypting an absent value
	 * would turn "this person gave no notes" into a `binData` that decrypts to nothing, at which
	 * point `$exists` stops meaning what it says.
	 */
	it('leaves an absent field absent', async () => {
		const data: Record<string, unknown> = { login: { email: 'a@b.test' }, notes: null, position: undefined }

		await hooks.execPre('save', documentContext(data))

		expect(data.notes).toBeNull()
		expect(data.position).toBeUndefined()
		expect(vault).toHaveLength(1)
	})

	// A document read out of the database and saved straight back. Encrypting it again would produce
	// a `binData` that decrypts to a `binData`.
	it('does not encrypt a value that is already ciphertext', async () => {
		const ciphertext = new Binary(Buffer.from('7'), Binary.SUBTYPE_ENCRYPTED)
		const data: Record<string, unknown> = { notes: ciphertext }

		await hooks.execPre('save', documentContext(data))

		expect(data.notes).toBe(ciphertext)
		expect(vault).toHaveLength(0)
	})

	/*
	 * `save()` leaves the document full of the ciphertext the pre-hook set, so a resolver that saves
	 * an account and then reads `account.login.email` off the same object — which `registerNewUser`
	 * does — would answer a `Binary` without this.
	 */
	it('puts the plaintext back into the document the caller is still holding', async () => {
		const data: Record<string, unknown> = { login: { email: 'a@b.test' }, notes: 'a note' }
		const context = documentContext(data)

		await hooks.execPre('save', context)
		await hooks.execPost('save', context, [data])

		expect(valueAt(data, 'login.email')).toBe('a@b.test')
		expect(data.notes).toBe('a note')
	})
})

describe('insertMany', () => {
	/*
	 * Nothing on the platform calls it today. The hook exists because the day something does, the
	 * alternative is a batch of plaintext personal data written into a collection whose every other
	 * document is encrypted — silently, and with no way to tell afterwards which documents went in
	 * which way.
	 */
	it('encrypts every document in the batch', async () => {
		const documents: unknown[] = [{ login: { email: 'one@b.test' } }, { login: { email: 'two@b.test' } }]

		await hooks.execPre('insertMany', null, [documents])

		expect(plaintextOf(valueAt(documents[0], 'login.email'))).toBe('one@b.test')
		expect(plaintextOf(valueAt(documents[1], 'login.email'))).toBe('two@b.test')
	})

	/*
	 * The hook takes the documents as its *first* argument and no `next`: mongoose's hook runner
	 * stopped passing a callback, and a first parameter named `next` would be handed the array.
	 *
	 * ⚠️ A string, rather than a lone document object. The guard has to be the thing that returns, and
	 * a batch loop let loose on an object simply finds no numeric keys and does nothing — so the
	 * assertion would hold with the guard deleted. A string has a `length` and indices the loop will
	 * walk and then try to assign to, which under ESM's strict mode throws.
	 */
	it('does nothing when it is not handed an array', async () => {
		await expect(hooks.execPre('insertMany', null, ['not an array'])).resolves.toBeDefined()

		expect(vault).toHaveLength(0)
	})
})

/*
 * The three account models the plugin is registered on, checked through the plugin rather than by
 * looking for it: a filter on the login credential comes back as ciphertext under that collection's
 * own key. A model that lost its `.plugin(...)` line fails here, and so does one that got the wrong
 * key — which would encrypt readable data into something no other service can decrypt.
 */
describe.each([
	['Admin', Admin, 'admin'],
	['ShopOwner', ShopOwner, 'shopOwner'],
	['User', User, 'user']
] as const)('%s', (_name, model, keyAltName) => {
	it('encrypts a filter on the login email under its own data key', async () => {
		const filter: Record<string, unknown> = { 'login.email': 'a@b.test' }

		await hooksOf(model.schema).execPre('findOne', queryContext(filter))

		expect(entryOf(filter['login.email'])).toEqual({
			value: 'a@b.test',
			algorithm: ALGORITHM_DETERMINISTIC,
			keyAltName: keyAltName
		})
	})
})

// Checked through an update rather than a filter: both of Company's encrypted fields are random, and
// `encryptFilter` refuses to build a query against one — see its own suite.
describe('Company', () => {
	it('encrypts its two personal fields under its own data key', async () => {
		const update = { $set: { publicName: 'A Shop', contactPerson: 'A Person', administrator: 'Another Person' } }

		await hooksOf(Company.schema).execPre('updateOne', queryContext({}, update))

		expect(entryOf(update.$set.contactPerson)).toEqual({ value: 'A Person', algorithm: ALGORITHM_RANDOM, keyAltName: 'company' })
		expect(entryOf(update.$set.administrator)).toEqual({
			value: 'Another Person',
			algorithm: ALGORITHM_RANDOM,
			keyAltName: 'company'
		})

		// A shop's trading name is what the storefront renders. Nothing public is encrypted.
		expect(update.$set.publicName).toBe('A Shop')
	})
})

// ⚠️ The catalogue is domain-neutral and holds nothing personal (ADR-008). Encrypting an item field
// would cost the two text indexes and the category sort for nothing.
describe('Item', () => {
	it('has no encryption hooks at all', async () => {
		const filter: Record<string, unknown> = { name: 'a value' }

		await hooksOf(Item.schema).execPre('findOne', queryContext(filter))

		expect(filter.name).toBe('a value')
		expect(vault).toHaveLength(0)
	})
})
