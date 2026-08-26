import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ClientEncryption, MongoClient, MongoServerError } from 'mongodb'
import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM } from '../src/encryption/EncryptionAlgorithm.mts'
import {
	decryptValue,
	encryptValue,
	getFieldEncryption,
	initFieldEncryption,
	isFieldEncryptionReady,
	MASTER_KEY_LENGTH,
	resetFieldEncryption
} from '../src/encryption/fieldEncryption.mts'
import { ENV_KEY_VAULT_NAMESPACE, ENV_MASTER_KEY_PATH, setupFieldEncryption } from '../src/encryption/setupFieldEncryption.mts'

/*
 * The driver's own `ClientEncryption` is faked, one level below the harness the walker suites use.
 *
 * The real one is a wrapper around `mongodb-client-encryption`, a native addon that opens the key
 * vault collection to fetch a data key before it can encrypt a byte — so exercising this module for
 * real means a running MongoDB, a provisioned vault and a 96-byte key on disk, which is `test:int`
 * and not this. What is asserted here is everything *around* the addon: the key length gate, the
 * unique index, the four data keys, the duplicate-key race between nine services starting at once,
 * and the singleton that refuses to hand out an uninitialised encrypter.
 */
interface IFakeState {
	constructed: Array<{ client: unknown; options: unknown }>
	existingKeys: Set<string>
	createdKeys: string[]
	encrypted: Array<{ value: unknown; options: unknown }>
	decrypted: unknown[]
	createDataKeyError: unknown
}

const { fakeState } = vi.hoisted(() => ({
	fakeState: {
		constructed: [],
		existingKeys: new Set<string>(),
		createdKeys: [],
		encrypted: [],
		decrypted: [],
		createDataKeyError: null
	} as IFakeState
}))

vi.mock('mongodb', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongodb')>()

	class FakeClientEncryption {
		constructor(client: unknown, options: unknown) {
			fakeState.constructed.push({ client: client, options: options })
		}

		async getKeyByAltName(keyAltName: string): Promise<unknown> {
			return fakeState.existingKeys.has(keyAltName) ? { _id: keyAltName } : null
		}

		async createDataKey(provider: string, options: { keyAltNames: string[] }): Promise<unknown> {
			fakeState.createdKeys.push(`${provider}:${String(options.keyAltNames[0])}`)

			if (fakeState.createDataKeyError !== null) {
				throw fakeState.createDataKeyError
			}

			return { _id: options.keyAltNames[0] }
		}

		async encrypt(value: unknown, options: unknown): Promise<string> {
			fakeState.encrypted.push({ value: value, options: options })
			return 'ciphertext'
		}

		async decrypt(value: unknown): Promise<string> {
			fakeState.decrypted.push(value)
			return 'plaintext'
		}
	}

	return { ...actual, ClientEncryption: FakeClientEncryption }
})

const KEY_VAULT_NAMESPACE = 'encryption.__keyVault'

interface ICreatedIndex {
	database: string
	collection: string
	keys: unknown
	options: unknown
}

let createdIndexes: ICreatedIndex[] = []

function fakeClient(): MongoClient {
	return {
		db: (database: string) => ({
			collection: (collection: string) => ({
				createIndex: async (keys: unknown, options: unknown) => {
					createdIndexes.push({ database: database, collection: collection, keys: keys, options: options })
					return 'keyAltNames_1'
				}
			})
		})
	} as unknown as MongoClient
}

const masterKey = () => Buffer.alloc(MASTER_KEY_LENGTH, 7)

beforeEach(() => {
	resetFieldEncryption()
	createdIndexes = []
	fakeState.constructed = []
	fakeState.existingKeys = new Set<string>()
	fakeState.createdKeys = []
	fakeState.encrypted = []
	fakeState.decrypted = []
	fakeState.createDataKeyError = null
})

describe('the master key', () => {
	// Not 32. The `local` KMS provider splits the key into a 32-byte encryption key, a 32-byte MAC key
	// and 32 bytes of reserve, and rejects any other length outright.
	it('is 96 bytes, and a key of any other length is refused before anything is built', async () => {
		expect(MASTER_KEY_LENGTH).toBe(96)

		await expect(
			initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: Buffer.alloc(32) })
		).rejects.toThrow('The CSFLE master key must be exactly 96 bytes, got 32')

		// Nothing was created on the way to the refusal: no index, no encrypter, no keys.
		expect(createdIndexes).toEqual([])
		expect(fakeState.constructed).toEqual([])
		expect(isFieldEncryptionReady()).toBe(false)
	})
})

describe('getFieldEncryption', () => {
	/*
	 * ⚠️ It throws rather than falling back to plaintext, and that is the whole point of it existing.
	 * A service that queries a personal field before `initFieldEncryption` has a startup-order bug;
	 * failing the query is loud and local, while writing the value through unencrypted is silent,
	 * lands plaintext in a collection everything else reads as ciphertext, and cannot be detected
	 * afterwards without reading every document.
	 */
	it('refuses to hand out an uninitialised encrypter', () => {
		expect(isFieldEncryptionReady()).toBe(false)
		expect(() => getFieldEncryption()).toThrow(
			'Field encryption is not initialised — call initFieldEncryption() before the first query'
		)
	})

	it('hands out the one built by initFieldEncryption, and resetFieldEncryption drops it', async () => {
		await initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })

		expect(isFieldEncryptionReady()).toBe(true)
		expect(getFieldEncryption()).toBeInstanceOf(ClientEncryption)

		resetFieldEncryption()

		expect(isFieldEncryptionReady()).toBe(false)
		expect(() => getFieldEncryption()).toThrow('Field encryption is not initialised')
	})
})

describe('initFieldEncryption', () => {
	it('builds the encrypter against the given vault and the local provider', async () => {
		const client = fakeClient()
		const key = masterKey()

		await initFieldEncryption({ client: client, keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: key })

		expect(fakeState.constructed).toHaveLength(1)
		expect(fakeState.constructed[0]?.client).toBe(client)
		expect(fakeState.constructed[0]?.options).toEqual({
			keyVaultNamespace: KEY_VAULT_NAMESPACE,
			kmsProviders: { local: { key: key } }
		})
	})

	/*
	 * The partial filter is the driver's own recommendation and it is load-bearing: a plain unique
	 * index on `keyAltNames` treats every key created *without* alt names as one and the same null
	 * entry, so the second such key would be refused.
	 */
	it('creates the unique key-vault index the duplicate-key race depends on', async () => {
		await initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })

		expect(createdIndexes).toEqual([
			{
				database: 'encryption',
				collection: '__keyVault',
				keys: { keyAltNames: 1 },
				options: { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } }
			}
		])
	})

	it('creates one data key per collection, under the local provider', async () => {
		await initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })

		expect(fakeState.createdKeys).toEqual(['local:admin', 'local:shopOwner', 'local:user', 'local:company'])
	})

	it('creates only the keys the vault does not already hold', async () => {
		fakeState.existingKeys = new Set(['admin', 'user'])

		await initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })

		expect(fakeState.createdKeys).toEqual(['local:shopOwner', 'local:company'])
	})

	/*
	 * ⚠️ Not defensive noise. Nine services start together and all nine run this; without the unique
	 * index two of them would each mint a key for `user`, and half the platform would encrypt under a
	 * key the other half cannot find. With it, the loser of the race gets `E11000` and goes on to read
	 * the winner's key — the correct outcome, and the only one.
	 */
	it('swallows the duplicate-key error nine services starting at once produce', async () => {
		const duplicate = new MongoServerError({ message: 'E11000 duplicate key error' })
		duplicate.code = 11000
		fakeState.createDataKeyError = duplicate

		await expect(
			initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })
		).resolves.toBeUndefined()

		expect(fakeState.createdKeys).toHaveLength(4)
		expect(isFieldEncryptionReady()).toBe(true)
	})

	it('rethrows a server error that is not a duplicate key', async () => {
		const unauthorized = new MongoServerError({ message: 'not authorized on encryption' })
		unauthorized.code = 13
		fakeState.createDataKeyError = unauthorized

		await expect(
			initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })
		).rejects.toThrow('not authorized on encryption')

		// The singleton is left unset: a service that could not provision its keys must not start.
		expect(isFieldEncryptionReady()).toBe(false)
	})

	it('rethrows an error that did not come from the server at all', async () => {
		fakeState.createDataKeyError = new Error('the key file is unreadable')

		await expect(
			initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })
		).rejects.toThrow('the key file is unreadable')
	})
})

describe('encryptValue / decryptValue', () => {
	it('pass the algorithm and the collection key straight through', async () => {
		await initFieldEncryption({ client: fakeClient(), keyVaultNamespace: KEY_VAULT_NAMESPACE, masterKey: masterKey() })

		expect(await encryptValue('a@b.test', ALGORITHM_DETERMINISTIC, 'user')).toBe('ciphertext')
		expect(await encryptValue({ type: 'Point' }, ALGORITHM_RANDOM, 'shopOwner')).toBe('ciphertext')

		expect(fakeState.encrypted).toEqual([
			{ value: 'a@b.test', options: { keyAltName: 'user', algorithm: ALGORITHM_DETERMINISTIC } },
			{ value: { type: 'Point' }, options: { keyAltName: 'shopOwner', algorithm: ALGORITHM_RANDOM } }
		])

		expect(await decryptValue('ciphertext' as never)).toBe('plaintext')
		expect(fakeState.decrypted).toEqual(['ciphertext'])
	})

	it('fail loudly when nothing was initialised', async () => {
		await expect(encryptValue('a@b.test', ALGORITHM_DETERMINISTIC, 'user')).rejects.toThrow(
			'Field encryption is not initialised'
		)
		await expect(decryptValue('ciphertext' as never)).rejects.toThrow('Field encryption is not initialised')
	})
})

describe('setupFieldEncryption', () => {
	const originalEnv = { ...process.env }
	let keyPath: string

	beforeEach(async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'csfle-'))
		keyPath = path.join(directory, 'master.key')
		await writeFile(keyPath, masterKey())

		process.env[ENV_KEY_VAULT_NAMESPACE] = KEY_VAULT_NAMESPACE
		process.env[ENV_MASTER_KEY_PATH] = keyPath
	})

	afterEach(() => {
		process.env = { ...originalEnv }
		vi.restoreAllMocks()
	})

	it('names the two variables the deployment has to set', () => {
		expect(ENV_KEY_VAULT_NAMESPACE).toBe('CSFLE_KEY_VAULT_NAMESPACE')
		expect(ENV_MASTER_KEY_PATH).toBe('CSFLE_MASTER_KEY_PATH')
	})

	it('reads the key off disk and brings encryption up against the given client', async () => {
		const client = fakeClient()

		await setupFieldEncryption(client)

		expect(isFieldEncryptionReady()).toBe(true)
		expect(fakeState.constructed[0]?.client).toBe(client)
		expect(fakeState.constructed[0]?.options).toEqual({
			keyVaultNamespace: KEY_VAULT_NAMESPACE,
			kmsProviders: { local: { key: masterKey() } }
		})
	})

	// The no-argument form the nine services call, on the line after `MongoDBConnect()`.
	it('falls back to the connection Mongoose already opened', async () => {
		const client = fakeClient()
		const getClient = vi.spyOn(mongoose.connection, 'getClient').mockReturnValue(client)

		await setupFieldEncryption()

		expect(getClient).toHaveBeenCalledExactlyOnceWith()
		expect(fakeState.constructed[0]?.client).toBe(client)
	})

	/*
	 * ⚠️ It throws rather than warning, and a service that cannot start is the point. One that starts
	 * without this reads `binData` it cannot decrypt and writes plaintext into collections whose other
	 * documents are encrypted — and neither shows up until someone reads the data back.
	 */
	it.each([
		[ENV_KEY_VAULT_NAMESPACE, 'CSFLE_KEY_VAULT_NAMESPACE is not set — field encryption cannot start without it'],
		[ENV_MASTER_KEY_PATH, 'CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it']
	])('refuses to start when %s is missing', async (name, message) => {
		delete process.env[name]

		await expect(setupFieldEncryption(fakeClient())).rejects.toThrow(message)
		expect(isFieldEncryptionReady()).toBe(false)
	})

	// An empty variable is the shape a half-filled `.env` produces, and it is as unusable as an absent
	// one — `client.db('')` is not a database and `readFile('')` is not a key.
	it('treats an empty variable as a missing one', async () => {
		process.env[ENV_MASTER_KEY_PATH] = ''

		await expect(setupFieldEncryption(fakeClient())).rejects.toThrow('CSFLE_MASTER_KEY_PATH is not set')
	})

	it('fails when the key file is not where the variable says it is', async () => {
		process.env[ENV_MASTER_KEY_PATH] = path.join(path.dirname(keyPath), 'absent.key')

		await expect(setupFieldEncryption(fakeClient())).rejects.toThrow(/ENOENT/)
	})
})
