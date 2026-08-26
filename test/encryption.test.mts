import { Binary, ObjectId } from 'mongodb'
import { Schema, SchemaType } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptDocument } from '../src/encryption/decryptDocument.mts'
import { encryptAtNode } from '../src/encryption/encryptAtNode.mts'
import { encryptDocument } from '../src/encryption/encryptDocument.mts'
import { ENCRYPTED_FIELD_TYPE, EncryptedField, encryptedPath } from '../src/encryption/EncryptedField.mts'
import {
	ENCRYPTED_FIELDS_ADMIN,
	ENCRYPTED_FIELDS_COMPANY,
	ENCRYPTED_FIELDS_SHOP_OWNER,
	ENCRYPTED_FIELDS_USER,
	KEY_ALT_NAME_ADMIN,
	KEY_ALT_NAME_COMPANY,
	KEY_ALT_NAME_SHOP_OWNER,
	KEY_ALT_NAME_USER,
	KEY_ALT_NAMES
} from '../src/encryption/encryptedFields.mts'
import { buildEncryptedFieldTrie, IEncryptedFieldNode, resolveEncryptedPath } from '../src/encryption/encryptedFieldTrie.mts'
import { encryptFilter } from '../src/encryption/encryptFilter.mts'
import { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM } from '../src/encryption/EncryptionAlgorithm.mts'
import { encryptUpdate } from '../src/encryption/encryptUpdate.mts'
import { IEncryptedFieldSpec } from '../src/encryption/IEncryptedFieldSpec.mts'
import { isCiphertext } from '../src/encryption/isCiphertext.mts'
import { isPlainObject } from '../src/encryption/isPlainObject.mts'
import { entryOf, fakeDecryptValue, fakeEncryptValue, plaintextOf, resetVault, vault } from './encryptionHarness.mts'

// The one seam these suites need. `fieldEncryption.mts` is the module that owns the driver's
// `ClientEncryption`, and it has a suite of its own; everything below is about *what gets encrypted*
// rather than about the encrypting, so it runs against a round-trippable double. See the harness.
vi.mock('@encryption/fieldEncryption.mjs', async () => {
	const harness = await import('./encryptionHarness.mts')
	return { encryptValue: harness.fakeEncryptValue, decryptValue: harness.fakeDecryptValue }
})

const KEY = 'testKey'

const ciphertext = (index: number) => new Binary(Buffer.from(String(index)), Binary.SUBTYPE_ENCRYPTED)

/*
 * ⚠️ Deliberately not `await expect(p).rejects.toThrow(message)`. That assertion passes when the
 * promise rejects with `undefined` — so a mutant that empties the body of `unsupported()` makes the
 * walkers throw nothing at all, and every refusal test below goes green against a layer that has
 * stopped naming the field and the operator it refused. Reading `.message` off the rejection needs a
 * real `Error` first, and comparing it with `toBe` needs the whole string.
 */
async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
	const reason = await promise.then(
		() => undefined,
		(error: unknown) => error
	)

	expect(reason).toBeInstanceOf(Error)
	expect((reason as Error).message).toBe(message)
}

beforeEach(() => {
	resetVault()
})

describe('the two algorithms', () => {
	// Pinned by value, not by identity: these strings are the driver's own algorithm names and a typo
	// in one of them is a runtime error at the first encrypt, in a service, at startup.
	it('are the two AEAD names the driver accepts, and nothing else', () => {
		expect(ALGORITHM_DETERMINISTIC).toBe('AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic')
		expect(ALGORITHM_RANDOM).toBe('AEAD_AES_256_CBC_HMAC_SHA_512-Random')
	})
})

describe('isCiphertext', () => {
	it('is true only for a Binary of subtype 6', () => {
		expect(isCiphertext(ciphertext(0))).toBe(true)
		// Subtype 4 is a UUID — a perfectly ordinary Binary, and not ours.
		expect(isCiphertext(new Binary(Buffer.from('0'), Binary.SUBTYPE_UUID))).toBe(false)
		expect(isCiphertext('AEAD…')).toBe(false)
		expect(isCiphertext(Buffer.from('0'))).toBe(false)
		expect(isCiphertext(null)).toBe(false)
		expect(isCiphertext(undefined)).toBe(false)
	})
})

describe('isPlainObject', () => {
	it('is true for a literal and for a null-prototype object', () => {
		expect(isPlainObject({})).toBe(true)
		expect(isPlainObject({ a: 1 })).toBe(true)
		expect(isPlainObject(Object.create(null))).toBe(true)
	})

	// ⚠️ The list below is the whole reason the check is by prototype. Every one of these is
	// `typeof 'object'`, and `ObjectId`, `Binary` and a Mongoose document hold references that lead
	// back up the tree — descending into one turns a document walk into an unbounded one.
	it('is false for everything with an identity of its own', () => {
		expect(isPlainObject(new Date())).toBe(false)
		expect(isPlainObject(new ObjectId())).toBe(false)
		expect(isPlainObject(ciphertext(0))).toBe(false)
		expect(isPlainObject(Buffer.from('x'))).toBe(false)
		expect(isPlainObject([])).toBe(false)
		expect(isPlainObject(null)).toBe(false)
		expect(isPlainObject(undefined)).toBe(false)
		expect(isPlainObject('x')).toBe(false)
		expect(isPlainObject(1)).toBe(false)
	})
})

describe('the declared field map', () => {
	it('names one key per collection and nothing else', () => {
		expect(KEY_ALT_NAME_ADMIN).toBe('admin')
		expect(KEY_ALT_NAME_SHOP_OWNER).toBe('shopOwner')
		expect(KEY_ALT_NAME_USER).toBe('user')
		expect(KEY_ALT_NAME_COMPANY).toBe('company')
		expect(KEY_ALT_NAMES).toEqual(['admin', 'shopOwner', 'user', 'company'])
	})

	// ⚠️ **Exactly five deterministic fields, and the assertion is on the whole set rather than on
	// each one.** Deterministic leaks equality — two documents holding the same value are visibly
	// holding the same value — so the set may only grow when a flow genuinely filters by value, and a
	// sixth entry appearing here should have to be argued for in a diff rather than slipped in.
	it('is deterministic on the five equality lookups and random everywhere else', () => {
		const all = [
			...ENCRYPTED_FIELDS_ADMIN.map((spec) => ({ ...spec, model: 'admin' })),
			...ENCRYPTED_FIELDS_SHOP_OWNER.map((spec) => ({ ...spec, model: 'shopOwner' })),
			...ENCRYPTED_FIELDS_USER.map((spec) => ({ ...spec, model: 'user' })),
			...ENCRYPTED_FIELDS_COMPANY.map((spec) => ({ ...spec, model: 'company' }))
		]

		const deterministic = all
			.filter((spec) => spec.algorithm === ALGORITHM_DETERMINISTIC)
			.map((spec) => `${spec.model}.${spec.path}`)

		expect(deterministic.sort()).toEqual([
			// The credential of each of the three tiers — `tryLoginAdmin`, `tryLoginShopOwner` and
			// `loginUser` all match on it, and `login.email_unique` is a unique index over it.
			'admin.login.email',
			// `emailChangeHashVerify` looks an account up *by its pending address*.
			'shopOwner.emailVerify.newEmailTmp',
			'shopOwner.login.email',
			'user.emailVerify.newEmailTmp',
			'user.login.email'
		])

		expect(all.filter((spec) => spec.algorithm === ALGORITHM_RANDOM)).toHaveLength(all.length - 5)
	})

	// ⚠️ Deterministic is undefined for `object` in the driver — it would throw at the first encrypt,
	// in whichever service happened to save a geo point first.
	it('never asks for deterministic on an object', () => {
		const all = [
			...ENCRYPTED_FIELDS_ADMIN,
			...ENCRYPTED_FIELDS_SHOP_OWNER,
			...ENCRYPTED_FIELDS_USER,
			...ENCRYPTED_FIELDS_COMPANY
		]
		const objects = all.filter((spec) => spec.plaintext === 'object')

		expect(objects.map((spec) => spec.path)).toEqual(['personalData.address.position', 'addresses.[].position'])
		expect(objects.every((spec) => spec.algorithm === ALGORITHM_RANDOM)).toBe(true)
	})

	it('declares the three fields the operator table sorts on nowhere', () => {
		// The single most consequential absence on the platform: encrypting any of these three does not
		// slow `shopOwnersActiveTbl` down, it falsifies it — rows ordered by ciphertext and every
		// `/^term/i` search answering nothing. ADR-029 records the trade.
		const paths = ENCRYPTED_FIELDS_SHOP_OWNER.map((spec) => spec.path)
		expect(paths).not.toContain('personalData.firstName')
		expect(paths).not.toContain('personalData.lastName')
		expect(paths).not.toContain('personalData.address.city')
	})
})

/**
 * Walks a schema for every path declared `EncryptedField`, in the dotted `[]`-for-array-element
 * spelling the field map uses.
 */
function collectEncryptedPaths(schema: Schema, prefix = ''): string[] {
	const found: string[] = []

	for (const [name, path] of Object.entries(schema.paths)) {
		const full = prefix === '' ? name : `${prefix}.${name}`

		if (path.instance === ENCRYPTED_FIELD_TYPE) {
			found.push(full)
			continue
		}

		const nested = (path as unknown as { schema?: Schema }).schema
		if (nested !== undefined) {
			found.push(...collectEncryptedPaths(nested, path.instance === 'Array' ? `${full}.[]` : full))
		}
	}

	return found
}

/** The `SchemaType` at a dotted field-map path, descending through sub-schemas and array elements. */
function schemaPathAt(schema: Schema, dotted: string): SchemaType | undefined {
	const segments = dotted.split('.')
	let current: Schema = schema

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] as string
		if (segment === '[]') {
			continue
		}

		const path: SchemaType | undefined = current.path(segment)
		if (path === undefined) {
			return undefined
		}

		if (index === segments.length - 1) {
			return path
		}

		const nested = (path as unknown as { schema?: Schema }).schema
		if (nested === undefined) {
			return undefined
		}

		current = nested
	}

	return undefined
}

/*
 * ⚠️ The field map and the models are two statements of the same fact and nothing in the type system
 * ties them together. A path in the map that no model declares is encrypted on write and cast back to
 * a string on read; a path declared `EncryptedField` and left out of the map is written in the clear
 * into a collection whose neighbours are ciphertext. Both are silent. This is the check.
 */
describe('the field map and the models agree, both ways', () => {
	const cases: Array<{ name: string; fields: IEncryptedFieldSpec[]; load: () => Promise<Schema> }> = [
		{
			name: 'Admin',
			fields: ENCRYPTED_FIELDS_ADMIN,
			load: async () => (await import('../src/models/MongoDB/Admin.mts')).Admin.schema
		},
		{
			name: 'ShopOwner',
			fields: ENCRYPTED_FIELDS_SHOP_OWNER,
			load: async () => (await import('../src/models/MongoDB/ShopOwner.mts')).ShopOwner.schema
		},
		{
			name: 'User',
			fields: ENCRYPTED_FIELDS_USER,
			load: async () => (await import('../src/models/MongoDB/User.mts')).User.schema
		},
		{
			name: 'Company',
			fields: ENCRYPTED_FIELDS_COMPANY,
			load: async () => (await import('../src/models/MongoDB/Company.mts')).Company.schema
		}
	]

	it.each(cases)('$name declares exactly the paths the map lists, with matching plaintext', async ({ fields, load }) => {
		const schema = await load()

		expect(collectEncryptedPaths(schema).sort()).toEqual(fields.map((spec) => spec.path).sort())

		for (const spec of fields) {
			const path = schemaPathAt(schema, spec.path)
			expect(path, spec.path).toBeDefined()
			expect(path?.instance, spec.path).toBe(ENCRYPTED_FIELD_TYPE)
			expect((path?.options as { plaintext?: string }).plaintext, spec.path).toBe(spec.plaintext)
		}
	})

	// The catalogue is domain-neutral and holds nothing personal — an `item` names a thing for sale
	// and an `itemCategory` names a kind of thing.
	it('leaves the catalogue pair entirely in the clear', async () => {
		const { Item } = await import('../src/models/MongoDB/Item.mts')
		const { ItemCategory } = await import('../src/models/MongoDB/ItemCategory.mts')

		expect(collectEncryptedPaths(Item.schema)).toEqual([])
		expect(collectEncryptedPaths(ItemCategory.schema)).toEqual([])
	})
})

/*
 * ⚠️ Every trie below is built in a `beforeEach`, never in a `describe` body, and the four walker
 * suites do the same. A trie built while vitest is collecting files is built *before any test runs*,
 * so a mutant that makes `childNode` throw — dropping its body, or turning its `??` into `&&` — takes
 * the whole file down during collection. Stryker's vitest runner then sees zero failed tests, cannot
 * attribute the collection error to one, and reports the mutant **Survived** while the suite did in
 * fact fail. Inside a `beforeEach` the same throw fails a test, which is what a mutant deserves.
 */
describe('buildEncryptedFieldTrie / resolveEncryptedPath', () => {
	let root: IEncryptedFieldNode

	beforeEach(() => {
		root = buildEncryptedFieldTrie(ENCRYPTED_FIELDS_USER)
	})

	it('resolves a nested leaf to its algorithm and plaintext', () => {
		expect(resolveEncryptedPath(root, 'login.email')).toEqual({
			algorithm: ALGORITHM_DETERMINISTIC,
			plaintext: 'string'
		})
		expect(resolveEncryptedPath(root, 'personalData.birth.date')?.plaintext).toBe('date')
	})

	it('resolves an interior node to a node with no algorithm', () => {
		const node = resolveEncryptedPath(root, 'personalData')
		expect(node?.algorithm).toBeUndefined()
		expect([...(node?.children?.keys() ?? [])]).toEqual(['firstName', 'lastName', 'birth', 'contacts'])
	})

	// ⚠️ The four spellings MongoDB uses for "an element of this array", plus the one with no
	// subscript at all — `{ 'addresses._id': x }`, which is the shape `throwIfUserDontOwnAddress`
	// queries with. All five have to land on the same node, because what is encrypted is the field
	// inside the element and that does not depend on which element.
	it.each([
		'addresses.0.street',
		'addresses.12.street',
		'addresses.$.street',
		'addresses.$[].street',
		'addresses.$[elem].street',
		'addresses.street'
	])('resolves %s to the element field', (key) => {
		expect(resolveEncryptedPath(root, key)).toEqual({ algorithm: ALGORITHM_RANDOM, plaintext: 'string' })
	})

	it('resolves nothing for a path that is not encrypted', () => {
		// `_id` and `defaultAddress` are the two the `$expr` validator compares, and both must stay in
		// the clear — the walk has to answer "not encrypted" for them rather than guessing.
		expect(resolveEncryptedPath(root, 'addresses._id')).toBeUndefined()
		expect(resolveEncryptedPath(root, 'addresses.0._id')).toBeUndefined()
		expect(resolveEncryptedPath(root, 'defaultAddress')).toBeUndefined()
		expect(resolveEncryptedPath(root, 'deleted')).toBeUndefined()
		// Past a leaf: `login.email` has no children, so nothing below it resolves either.
		expect(resolveEncryptedPath(root, 'login.email.domain')).toBeUndefined()
	})

	/*
	 * ⚠️ A subscript is the *whole* segment or it is not a subscript, and both anchors of the pattern
	 * earn their place. Without the leading one a field ending in a digit would pass for one; without
	 * the trailing one anything beginning with `$` would. Either way the segment gets consumed instead
	 * of retried against the element's own children, and the walk answers with the element node — so a
	 * key naming no encrypted field at all comes back looking like one, and `encryptFilter` then
	 * rewrites a value it should have left alone.
	 */
	it.each(['addresses.line2', 'addresses.$elemMatch'])('does not mistake %s for an array subscript', (key) => {
		expect(resolveEncryptedPath(root, key)).toBeUndefined()
	})

	it('merges two specs that share a prefix into one node', () => {
		const shared = buildEncryptedFieldTrie([
			{ path: 'a.b', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
			{ path: 'a.c', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' }
		])

		expect([...(shared.children?.get('a')?.children?.keys() ?? [])]).toEqual(['b', 'c'])
		expect(shared.children?.get('a')?.algorithm).toBeUndefined()
	})

	it('merges two specs that share an array element node', () => {
		const shared = buildEncryptedFieldTrie([
			{ path: 'list.[].x', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
			{ path: 'list.[].y', algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
		])

		expect([...(shared.children?.get('list')?.element?.children?.keys() ?? [])]).toEqual(['x', 'y'])
	})
})

describe('encryptAtNode', () => {
	const leaf: IEncryptedFieldNode = { algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
	let root: IEncryptedFieldNode

	beforeEach(() => {
		root = buildEncryptedFieldTrie(ENCRYPTED_FIELDS_USER)
	})

	// ⚠️ Absence stays absence. Encrypting a `null` would turn "this person gave no landline" into a
	// `binData`, and `$exists` would stop meaning what it says.
	it('passes null and undefined through untouched', async () => {
		expect(await encryptAtNode(null, leaf, KEY)).toBeNull()
		expect(await encryptAtNode(undefined, leaf, KEY)).toBeUndefined()
		expect(vault).toHaveLength(0)
	})

	it('encrypts a leaf under the node algorithm and the model key', async () => {
		const result = await encryptAtNode('a@b.test', { algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' }, 'user')

		expect(entryOf(result)).toEqual({ value: 'a@b.test', algorithm: ALGORITHM_DETERMINISTIC, keyAltName: 'user' })
	})

	// Idempotence, and it is load-bearing: a document read out of the database and written straight
	// back passes through here again, and double-encrypting produces a blob that decrypts to a blob.
	it('leaves existing ciphertext alone', async () => {
		const existing = ciphertext(7)
		expect(await encryptAtNode(existing, leaf, KEY)).toBe(existing)
		expect(vault).toHaveLength(0)
	})

	it('encrypts every field of a whole sub-document', async () => {
		const value = { firstName: 'Ada', lastName: 'Lovelace', unknown: 'kept' }
		const node = resolveEncryptedPath(root, 'personalData') as IEncryptedFieldNode

		const result = (await encryptAtNode(value, node, 'user')) as Record<string, unknown>

		expect(plaintextOf(result.firstName)).toBe('Ada')
		expect(plaintextOf(result.lastName)).toBe('Lovelace')
		// A key the map does not declare is left exactly as it was, rather than encrypted on a guess.
		expect(result.unknown).toBe('kept')
	})

	it('does not invent the fields a sub-document does not carry', async () => {
		const node = resolveEncryptedPath(root, 'personalData') as IEncryptedFieldNode

		const result = (await encryptAtNode({ firstName: 'Ada' }, node, 'user')) as Record<string, unknown>

		expect(Object.keys(result)).toEqual(['firstName'])
		expect(vault).toHaveLength(1)
	})

	it('encrypts every element of an array', async () => {
		const node = resolveEncryptedPath(root, 'addresses') as IEncryptedFieldNode
		const value = [
			{ _id: 'one', street: 'A street', city: 'Town' },
			{ _id: 'two', street: 'B street', city: 'City' }
		]

		const result = (await encryptAtNode(value, node, 'user')) as Array<Record<string, unknown>>

		expect(plaintextOf(result[0]?.street)).toBe('A street')
		expect(plaintextOf(result[1]?.city)).toBe('City')
		// The element `_id` is what the `$expr` validator compares against `defaultAddress`.
		expect(result[0]?._id).toBe('one')
	})

	it('leaves an array alone when the node has no element child', async () => {
		const value = ['a', 'b']
		expect(await encryptAtNode(value, { children: new Map() }, KEY)).toBe(value)
		expect(vault).toHaveLength(0)
	})

	it('leaves a value alone when the node has no children', async () => {
		const value = { firstName: 'Ada' }
		expect(await encryptAtNode(value, {}, KEY)).toBe(value)
		expect(vault).toHaveLength(0)
	})

	it('treats a value with an identity of its own as a leaf', async () => {
		// A `Date` reached at an interior node is not descended into — it has no fields worth walking
		// and its own prototype, which is exactly what `isPlainObject` is there to notice.
		const value = new Date('2020-01-01T00:00:00.000Z')
		const node = resolveEncryptedPath(root, 'personalData') as IEncryptedFieldNode

		expect(await encryptAtNode(value, node, KEY)).toBe(value)
		expect(vault).toHaveLength(0)
	})
})

describe('encryptDocument', () => {
	// The seed shape the integration suites write with the raw driver: personal fields at three
	// depths, and the three shopOwner fields that stay in the clear because the operator table sorts
	// and prefix-searches them.
	const seed = () => ({
		_id: new ObjectId(),
		login: { email: 'owner@example.com', password: 'x'.repeat(60) },
		personalData: {
			firstName: 'M',
			lastName: 'R',
			birth: { date: new Date('1970-11-24T00:00:00.000Z') },
			address: { street: 'Via', postalCode: '24030', city: 'C', province: 'BG' },
			contacts: { mobile: '333' }
		},
		notes: 'Operator note'
	})

	it('encrypts every declared field and leaves everything else alone', async () => {
		const document = seed()

		const returned = await encryptDocument(document, ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER)

		// In place and handed back — a seed writes `await encryptDocument(doc, …)` straight into
		// `insertOne`, so the return value has to be the document rather than a copy of it.
		expect(returned).toBe(document)

		expect(plaintextOf(document.login.email)).toBe('owner@example.com')
		expect(plaintextOf(document.personalData.birth.date)).toEqual(new Date('1970-11-24T00:00:00.000Z'))
		expect(plaintextOf(document.personalData.address.street)).toBe('Via')
		expect(plaintextOf(document.personalData.address.postalCode)).toBe('24030')
		expect(plaintextOf(document.personalData.contacts.mobile)).toBe('333')
		expect(plaintextOf(document.notes)).toBe('Operator note')

		// ⚠️ The three the operator table depends on, and the bcrypt hash. A helper that encrypted
		// the whole document rather than the declared list would break `tbl_active_*` silently.
		expect(document.personalData.firstName).toBe('M')
		expect(document.personalData.lastName).toBe('R')
		expect(document.personalData.address.city).toBe('C')
		expect(document.login.password).toBe('x'.repeat(60))
		expect(document.personalData.address.province).not.toBe('BG')
	})

	it('encrypts under the key alt name and the algorithm the list declares', async () => {
		const document = seed()

		await encryptDocument(document, ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER)

		// The whole point of the deterministic/random split, asserted where it is decided rather than
		// inferred from a blob: the login address is the one field a seeded account is looked up by.
		expect(entryOf(document.login.email).algorithm).toBe(ALGORITHM_DETERMINISTIC)
		expect(entryOf(document.login.email).keyAltName).toBe(KEY_ALT_NAME_SHOP_OWNER)
		expect(entryOf(document.notes).algorithm).toBe(ALGORITHM_RANDOM)
	})

	it('takes the list it is given, not the one the collection usually carries', async () => {
		// Same document, the company list: nothing matches, so nothing is encrypted. What proves the
		// helper is driven by its argument rather than by anything it guesses from the shape.
		const document = seed()

		await encryptDocument(document, ENCRYPTED_FIELDS_COMPANY, KEY_ALT_NAME_COMPANY)

		expect(document.login.email).toBe('owner@example.com')
		expect(vault).toHaveLength(0)
	})
})

describe('encryptFilter', () => {
	let root: IEncryptedFieldNode

	beforeEach(() => {
		root = buildEncryptedFieldTrie(ENCRYPTED_FIELDS_USER)
	})

	it('ignores anything that is not a filter object', async () => {
		await expect(encryptFilter(undefined, root, KEY)).resolves.toBeUndefined()
		await expect(encryptFilter([1, 2], root, KEY)).resolves.toBeUndefined()
	})

	// Almost every filter on the platform: by `_id`, by foreign key, by `deleted`, by `published`.
	it('leaves a filter that names no encrypted field byte for byte alone', async () => {
		const filter = { _id: 'abc', deleted: { $exists: false }, disabled: true }

		await encryptFilter(filter, root, KEY)

		expect(filter).toEqual({ _id: 'abc', deleted: { $exists: false }, disabled: true })
		expect(vault).toHaveLength(0)
	})

	it('encrypts a deterministic field matched by value', async () => {
		const filter: Record<string, unknown> = { 'login.email': 'a@b.test', deleted: { $exists: false } }

		await encryptFilter(filter, root, 'user')

		expect(entryOf(filter['login.email'])).toEqual({ value: 'a@b.test', algorithm: ALGORITHM_DETERMINISTIC, keyAltName: 'user' })
		expect(filter.deleted).toEqual({ $exists: false })
	})

	it('encrypts $eq and $ne on a deterministic field', async () => {
		const filter: Record<string, Record<string, unknown>> = {
			'login.email': { $eq: 'a@b.test' },
			'emailVerify.newEmailTmp': { $ne: 'c@d.test' }
		}

		await encryptFilter(filter, root, 'user')

		expect(plaintextOf(filter['login.email']?.$eq)).toBe('a@b.test')
		expect(plaintextOf(filter['emailVerify.newEmailTmp']?.$ne)).toBe('c@d.test')
	})

	it('encrypts every member of $in and $nin', async () => {
		const filter: Record<string, Record<string, unknown>> = {
			'login.email': { $in: ['a@b.test', 'c@d.test'] },
			'emailVerify.newEmailTmp': { $nin: ['e@f.test'] }
		}

		await encryptFilter(filter, root, 'user')

		expect((filter['login.email']?.$in as unknown[]).map(plaintextOf)).toEqual(['a@b.test', 'c@d.test'])
		expect((filter['emailVerify.newEmailTmp']?.$nin as unknown[]).map(plaintextOf)).toEqual(['e@f.test'])
	})

	// `$exists` reads presence and `$type` reads the BSON type, which for an encrypted field is
	// `binData` whichever algorithm produced it. Neither looks at the value, so both are legal
	// everywhere — including on the random fields where an equality match is not.
	it('allows $exists and $type on a random field and touches neither', async () => {
		const filter = { 'personalData.contacts.landline': { $exists: true }, 'personalData.firstName': { $type: 'binData' } }

		await encryptFilter(filter, root, KEY)

		expect(filter).toEqual({
			'personalData.contacts.landline': { $exists: true },
			'personalData.firstName': { $type: 'binData' }
		})
		expect(vault).toHaveLength(0)
	})

	// All three are asserted through an encrypted field of their own. A branch carrying only ordinary
	// fields would pass whether the operator was descended into or stepped over.
	it('descends into $and, $or and $nor', async () => {
		const filter = {
			$and: [
				{ 'login.email': 'a@b.test' },
				{ $or: [{ deleted: { $exists: false } }, { 'emailVerify.newEmailTmp': 'c@d.test' }] }
			],
			$nor: [{ 'login.email': 'e@f.test' }]
		}

		await encryptFilter(filter, root, 'user')

		expect(plaintextOf((filter.$and[0] as Record<string, unknown>)['login.email'])).toBe('a@b.test')
		const nested = (filter.$and[1] as { $or: Array<Record<string, unknown>> }).$or
		expect(plaintextOf(nested[1]?.['emailVerify.newEmailTmp'])).toBe('c@d.test')
		expect(plaintextOf((filter.$nor[0] as Record<string, unknown>)['login.email'])).toBe('e@f.test')
	})

	it('ignores a logical operator whose operand is not an array', async () => {
		const filter = { $and: 'nonsense' }

		await encryptFilter(filter, root, KEY)

		expect(filter).toEqual({ $and: 'nonsense' })
	})

	// `$expr`, `$text`, `$where`. An aggregation expression is not a filter tree, so walking into one
	// with this walker would misread it — and none of them can name an encrypted field here anyway:
	// the two `$expr` validators compare `_id`s and both text indexes are on public fields.
	it('steps over a top-level operator it does not own', async () => {
		const filter = { $expr: { $in: ['$defaultAddress', { $map: { input: '$addresses', in: '$$this._id' } }] } }
		const snapshot = structuredClone(filter)

		await encryptFilter(filter, root, KEY)

		expect(filter).toEqual(snapshot)
	})

	it('encrypts the inside of a whole sub-document matched by equality', async () => {
		const filter: Record<string, unknown> = { personalData: { firstName: 'Ada', lastName: 'Lovelace' } }

		await encryptFilter(filter, root, 'user')

		const personalData = filter.personalData as Record<string, unknown>
		expect(plaintextOf(personalData.firstName)).toBe('Ada')
		expect(plaintextOf(personalData.lastName)).toBe('Lovelace')
	})

	// A plain object with no `$` key is a value, not an operand — `{ 'login.email': { a: 1 } }` asks
	// for a field equal to that object rather than for an operator.
	it('treats an operator-free object operand as a value', async () => {
		const filter: Record<string, unknown> = { 'login.email': { nested: 'value' }, 'emailVerify.newEmailTmp': {} }

		await encryptFilter(filter, root, 'user')

		expect(plaintextOf(filter['login.email'])).toEqual({ nested: 'value' })

		// ⚠️ The empty object earns its place: it is the one operand on which "carries a `$` key" and
		// "is nothing but `$` keys" disagree. It names no operator, so it is a value — a match against a
		// field equal to `{}` — and it has to be encrypted like one. Read the other way it is an operand
		// with no operators in it, which encrypts nothing and sends the plaintext to the server.
		expect(plaintextOf(filter['emailVerify.newEmailTmp'])).toEqual({})
	})

	/*
	 * ⚠️ Every case below throws, and that is the design rather than strictness for its own sake. A
	 * filter that ciphertext cannot answer does not fail at the database: it runs, matches nothing and
	 * returns an empty result, which reads downstream as "no such account" or "this customer has no
	 * addresses". Every one of those is a plausible answer, so the bug ships looking like data.
	 */
	it('refuses an equality match on a random field', async () => {
		await expectRejection(
			encryptFilter({ 'personalData.firstName': 'Ada' }, root, KEY),
			'Cannot query the encrypted field "personalData.firstName": it is random-encrypted, so an equality match can never succeed (ADR-029)'
		)
	})

	it('refuses an operator on a random field', async () => {
		await expectRejection(
			encryptFilter({ 'personalData.contacts.mobile': { $eq: '+390000000' } }, root, KEY),
			'Cannot query the encrypted field "personalData.contacts.mobile": it is random-encrypted, so "$eq" can never match (ADR-029)'
		)
	})

	it('refuses an ordering or pattern operator on a deterministic field', async () => {
		// Equal ciphertexts say nothing about the order of the plaintexts behind them, and a prefix of
		// a ciphertext is a prefix of nothing.
		await expectRejection(
			encryptFilter({ 'login.email': { $gt: 'a@b.test' } }, root, KEY),
			'Cannot query the encrypted field "login.email": deterministic ciphertext supports equality only, not "$gt" (ADR-029)'
		)
		await expectRejection(
			encryptFilter({ 'login.email': { $regex: '^a' } }, root, KEY),
			'Cannot query the encrypted field "login.email": deterministic ciphertext supports equality only, not "$regex" (ADR-029)'
		)
	})

	it('refuses $in with something other than an array', async () => {
		await expectRejection(
			encryptFilter({ 'login.email': { $in: 'a@b.test' } }, root, KEY),
			'Cannot query the encrypted field "login.email": "$in" needs an array (ADR-029)'
		)
	})
})

describe('encryptUpdate', () => {
	let root: IEncryptedFieldNode

	beforeEach(() => {
		root = buildEncryptedFieldTrie(ENCRYPTED_FIELDS_USER)
	})

	it('ignores anything that is not an update object', async () => {
		await expect(encryptUpdate(undefined, root, KEY)).resolves.toBeUndefined()
		await expect(encryptUpdate('nonsense', root, KEY)).resolves.toBeUndefined()
	})

	/*
	 * ⚠️ A pipeline update is left untouched, and it is a real limitation rather than an oversight:
	 * `updateOne(filter, [{ $set: … }])` is computation on the server over values the client never
	 * sees, so there is nothing here to encrypt. The one such update on the platform,
	 * `funUserAddressDel`, computes over `addresses[]._id`, which is deliberately in the clear.
	 */
	it('leaves an aggregation-pipeline update alone', async () => {
		const update = [{ $set: { 'personalData.firstName': 'Ada' } }]

		await encryptUpdate(update, root, KEY)

		expect(update).toEqual([{ $set: { 'personalData.firstName': 'Ada' } }])
		expect(vault).toHaveLength(0)
	})

	it('encrypts $set, by dotted path and by whole sub-document alike', async () => {
		const update: { $set: Record<string, unknown> } = {
			$set: {
				'personalData.contacts.email': 'a@b.test',
				personalData: { firstName: 'Ada' },
				defaultAddress: 'kept'
			}
		}

		await encryptUpdate(update, root, 'user')

		expect(plaintextOf(update.$set['personalData.contacts.email'])).toBe('a@b.test')
		expect(plaintextOf((update.$set.personalData as Record<string, unknown>).firstName)).toBe('Ada')
		expect(update.$set.defaultAddress).toBe('kept')
	})

	it('encrypts $setOnInsert the same way', async () => {
		const update = { $setOnInsert: { 'login.email': 'a@b.test' } }

		await encryptUpdate(update, root, 'user')

		expect(plaintextOf(update.$setOnInsert['login.email'])).toBe('a@b.test')
	})

	/*
	 * ⚠️ `null`, not a string, and the same in the two sibling cases below. Each of the three walkers
	 * opens with a "this operand is not a value map" guard, and a string walks straight past a dropped
	 * one: `Object.entries('nonsense')` is a list of characters by index, no index names an encrypted
	 * path, and the update comes back unchanged — so the assertion holds with the guard gone. `null` is
	 * the operand that makes `Object.entries` throw, which is what a missing guard deserves.
	 */
	it('ignores a $set whose operand is not a value map', async () => {
		const update = { $set: null }

		await encryptUpdate(update, root, KEY)

		expect(update).toEqual({ $set: null })
	})

	it('encrypts a pushed array element against the element node', async () => {
		const update = { $push: { addresses: { street: 'A street', _id: 'one' } } }

		await encryptUpdate(update, root, 'user')

		expect(plaintextOf(update.$push.addresses.street)).toBe('A street')
		expect(update.$push.addresses._id).toBe('one')
	})

	it('encrypts every element of a $push $each, and $addToSet the same way', async () => {
		const update = {
			$push: { addresses: { $each: [{ street: 'A street' }, { street: 'B street' }] } },
			$addToSet: { addresses: { city: 'Town' } }
		}

		await encryptUpdate(update, root, 'user')

		expect(update.$push.addresses.$each.map((entry) => plaintextOf((entry as Record<string, unknown>).street))).toEqual([
			'A street',
			'B street'
		])
		expect(plaintextOf(update.$addToSet.addresses.city)).toBe('Town')
	})

	it('ignores a push at a key that is not an encrypted array, and an operand that is not a value map', async () => {
		const update = { $push: { history: { note: 'x' } } }
		const bare = { $push: null }

		await encryptUpdate(update, root, KEY)
		await encryptUpdate(bare, root, KEY)

		expect(update).toEqual({ $push: { history: { note: 'x' } } })
		expect(bare).toEqual({ $push: null })
		expect(vault).toHaveLength(0)
	})

	// `$pull`'s operand selects elements to remove, so it is a filter — which is why it goes through
	// `encryptFilter` and inherits the "a random field cannot be matched" rule instead of restating it.
	it('routes $pull through the filter walker', async () => {
		const update: { $pull: { addresses: Record<string, unknown> } } = { $pull: { addresses: { _id: 'one' } } }

		await encryptUpdate(update, root, KEY)
		expect(update.$pull.addresses).toEqual({ _id: 'one' })

		await expectRejection(
			encryptUpdate({ $pull: { addresses: { city: 'Town' } } }, root, KEY),
			'Cannot query the encrypted field "city": it is random-encrypted, so an equality match can never succeed (ADR-029)'
		)
	})

	it('ignores a $pull at a key that is not an encrypted array, and an operand that is not a value map', async () => {
		const update = { $pull: { history: { note: 'x' } } }
		const bare = { $pull: null }

		await encryptUpdate(update, root, KEY)
		await encryptUpdate(bare, root, KEY)

		expect(update).toEqual({ $pull: { history: { note: 'x' } } })
		expect(bare).toEqual({ $pull: null })
	})

	// `{ $unset: { notes: '' } }` names a field and discards the `''`. Encrypting the operand would
	// turn a valid update into a rejected one.
	it('steps over operators whose operand is not a value', async () => {
		const update = {
			$unset: { 'personalData.contacts.landline': '' },
			$inc: { 'login.loginCount': 1 },
			$currentDate: { 'login.lastLogin': true }
		}
		const snapshot = structuredClone(update)

		await encryptUpdate(update, root, KEY)

		expect(update).toEqual(snapshot)
		expect(vault).toHaveLength(0)
	})

	// A replacement document from `replaceOne`, or the shorthand Mongoose expands into `$set`.
	it('encrypts the bare keys of a replacement document', async () => {
		const update: Record<string, unknown> = { 'login.email': 'a@b.test', registeredAt: 'kept' }

		await encryptUpdate(update, root, 'user')

		expect(plaintextOf(update['login.email'])).toBe('a@b.test')
		expect(update.registeredAt).toBe('kept')
	})
})

describe('decryptDocument', () => {
	it('replaces ciphertext with plaintext, however deep', async () => {
		const email = await fakeEncryptValue('a@b.test', ALGORITHM_DETERMINISTIC, 'user')
		const street = await fakeEncryptValue('A street', ALGORITHM_RANDOM, 'user')
		const document = { login: { email: email, password: '$2b$…' }, addresses: [{ street: street, _id: 'one' }] }

		await decryptDocument(document)

		expect(document).toEqual({
			login: { email: 'a@b.test', password: '$2b$…' },
			addresses: [{ street: 'A street', _id: 'one' }]
		})
	})

	it('walks an array of documents', async () => {
		const first = await fakeEncryptValue('a@b.test', ALGORITHM_DETERMINISTIC, 'user')
		const second = await fakeEncryptValue('c@d.test', ALGORITHM_DETERMINISTIC, 'user')
		const documents = [{ login: { email: first } }, { login: { email: second } }]

		await decryptDocument(documents)

		expect(documents).toEqual([{ login: { email: 'a@b.test' } }, { login: { email: 'c@d.test' } }])
	})

	/*
	 * ⚠️ A hydrated document keeps its values in `_doc`, one bag per nested schema, and is walked
	 * through those bags rather than through its accessors — assigning `doc.login.email` would mark
	 * the path modified and the next `save()` would send the plaintext back to the server.
	 *
	 * `_doc` is also the *only* bag walked, which is what the sibling below is here to pin. The rest of
	 * what a document carries — `$__`, `$locals`, the parent back-reference a sub-document keeps — is
	 * bookkeeping rather than stored values, and part of it leads back up the tree this walk came from.
	 * So the sibling holds ciphertext and has to come back exactly as it went in.
	 */
	it('walks a hydrated document through its _doc bag and through nothing else', async () => {
		const email = await fakeEncryptValue('a@b.test', ALGORITHM_DETERMINISTIC, 'user')
		const bookkeeping = await fakeEncryptValue('c@d.test', ALGORITHM_DETERMINISTIC, 'user')
		class FakeDocument {
			readonly _doc = { login: { _doc: { email: email } } }
			readonly $__ = { untouchable: bookkeeping }
		}
		const document = new FakeDocument()

		await decryptDocument(document)

		expect(document._doc.login._doc.email).toBe('a@b.test')
		expect(document.$__.untouchable).toBe(bookkeeping)
	})

	it('treats a value with its own identity and no _doc as a leaf', async () => {
		// `null` returns from the `typeof` guard, a `Date` from the `_doc` one. Neither may be walked:
		// a `Date` has no fields to decrypt, and the guard is what keeps this off `ObjectId`, `Binary`
		// and the parent references a Mongoose document carries.
		const date = new Date('2020-01-01T00:00:00.000Z')
		await expect(decryptDocument(date)).resolves.toBeUndefined()
		await expect(decryptDocument(null)).resolves.toBeUndefined()
		await expect(decryptDocument('a string')).resolves.toBeUndefined()
		expect(date.toISOString()).toBe('2020-01-01T00:00:00.000Z')
	})

	it('is a no-op on a document that carries no ciphertext', async () => {
		const document = { _id: 'abc', published: true, address: { city: 'Town' } }
		const snapshot = structuredClone(document)

		await decryptDocument(document)

		expect(document).toEqual(snapshot)
	})

	it('reads back exactly what the fake wrote, for a date and for an object', async () => {
		const date = new Date('1990-05-01T00:00:00.000Z')
		const position = { type: 'Point', coordinates: [9.19, 45.46] }
		const document = {
			birth: { date: await fakeEncryptValue(date, ALGORITHM_RANDOM, 'user') },
			position: await fakeEncryptValue(position, ALGORITHM_RANDOM, 'user')
		}

		await decryptDocument(document)

		expect(document.birth.date).toBe(date)
		expect(document.position).toBe(position)
		expect(await fakeDecryptValue(await fakeEncryptValue('x', ALGORITHM_RANDOM, 'user'))).toBe('x')
	})
})

describe('EncryptedField', () => {
	// Mongoose resolves `type:` through its own registry rather than by reading the constructor, so an
	// unregistered type is a `TypeError` at schema-build time — at import, before a test can run.
	it('registers itself on Schema.Types under its own name', () => {
		expect((Schema.Types as unknown as Record<string, unknown>)[ENCRYPTED_FIELD_TYPE]).toBe(EncryptedField)
		expect(EncryptedField.schemaName).toBe('EncryptedField')
	})

	const castWith = (plaintext: string, value: unknown) =>
		new EncryptedField('some.path', { plaintext: plaintext } as never).cast(value)

	it('passes null, undefined and ciphertext through uncast', () => {
		const existing = ciphertext(3)
		expect(castWith('string', null)).toBeNull()
		expect(castWith('string', undefined)).toBeUndefined()
		// The one that matters: a `String` path would stringify this into the text `Binary.toString()`
		// produces, which is garbage that validates.
		expect(castWith('string', existing)).toBe(existing)
	})

	it('casts a string field the way a String path would', () => {
		expect(castWith('string', 'Ada')).toBe('Ada')
		expect(castWith('string', 42)).toBe('42')
		expect(castWith('string', true)).toBe('true')
	})

	it('casts a date field the way a Date path would', () => {
		const date = new Date('1990-05-01T00:00:00.000Z')
		expect(castWith('date', date)).toBe(date)
		expect(castWith('date', '1990-05-01T00:00:00.000Z')).toEqual(date)
	})

	it('raises a CastError on a value the path could never have held', () => {
		expect(() => castWith('date', 'not a date')).toThrow(/Cast to EncryptedField failed/)
		expect(() => castWith('string', { a: 1 })).toThrow(/Cast to EncryptedField failed/)
		expect(() => castWith('string', ['a'])).toThrow(/Cast to EncryptedField failed/)
	})

	// The escape hatch for `position`, which is a sub-document encrypted whole and so has no scalar
	// cast to perform.
	it('leaves an object field exactly as handed in', () => {
		const position = { type: 'Point', coordinates: [9.19, 45.46] }
		expect(castWith('object', position)).toBe(position)
	})

	it('encryptedPath declares the type and carries the options through', () => {
		expect(encryptedPath({ plaintext: 'string', required: true })).toEqual({
			type: EncryptedField,
			plaintext: 'string',
			required: true
		})
		expect(encryptedPath({ plaintext: 'object' })).toEqual({ type: EncryptedField, plaintext: 'object' })
	})
})
