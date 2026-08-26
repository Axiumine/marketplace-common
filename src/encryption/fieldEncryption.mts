import { KEY_ALT_NAMES } from '@encryption/encryptedFields.mjs'
import { EncryptionAlgorithm } from '@encryption/EncryptionAlgorithm.mjs'
import { Binary, ClientEncryption, MongoClient, MongoServerError } from 'mongodb'

/**
 * What a service has to hand over before any model can read or write a personal field.
 *
 * `client` is an ordinary `MongoClient` — the key vault is an ordinary collection in an ordinary
 * database, and the server never learns that any of this is happening. Reusing the connection
 * Mongoose already opened is fine and is what `setupFieldEncryption` does.
 *
 * `masterKey` is 96 bytes. Not 32: the `local` KMS provider splits it into a 32-byte encryption key,
 * a 32-byte MAC key and 32 bytes of reserve, and rejects any other length outright.
 */
export interface IFieldEncryptionConfig {
	client: MongoClient
	keyVaultNamespace: string
	masterKey: Buffer
}

export const MASTER_KEY_LENGTH = 96

/**
 * The one `ClientEncryption` for the process.
 *
 * A module singleton rather than something threaded through every call, because the alternative is
 * a parameter on every model method, every koa-utils entry point and every resolver — and koa-utils
 * is a published package whose signatures are not ours to change.
 */
let clientEncryption: ClientEncryption | null = null

export function isFieldEncryptionReady(): boolean {
	return clientEncryption !== null
}

/**
 * ⚠️ Throws rather than falling back to plaintext, and that is the whole point of it existing.
 *
 * A service that queries a personal field before calling `initFieldEncryption` has a startup-order
 * bug. Failing the query is loud and local; the alternative — writing the value through unencrypted
 * — is silent, lands plaintext in a collection everything else reads as ciphertext, and is not
 * detectable afterwards without reading every document.
 */
export function getFieldEncryption(): ClientEncryption {
	if (clientEncryption === null) {
		throw new Error('Field encryption is not initialised — call initFieldEncryption() before the first query')
	}

	return clientEncryption
}

/**
 * Drops the singleton. For tests, which build a fresh one per suite; nothing in a running service
 * calls it.
 */
export function resetFieldEncryption(): void {
	clientEncryption = null
}

/**
 * Makes sure the key vault can hold what the driver expects of it.
 *
 * The partial filter is the driver's own recommendation and it is load-bearing: a plain unique index
 * on `keyAltNames` treats every key created *without* alt names as one and the same null entry, so
 * the second such key would be refused. Every key here has alt names, so the partial clause changes
 * nothing today and costs nothing to keep correct.
 */
async function ensureKeyVaultIndex(client: MongoClient, keyVaultNamespace: string): Promise<void> {
	const [database, collection] = keyVaultNamespace.split('.')

	await client
		.db(database)
		.collection(collection as string)
		.createIndex({ keyAltNames: 1 }, { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } })
}

/**
 * Creates the four data encryption keys the first time, and finds them every time after.
 *
 * ⚠️ The duplicate-key catch is not defensive noise. Nine services start together and all nine run
 * this; without the unique index two of them would each mint a key for `user` and half the platform
 * would encrypt under a key the other half cannot find. With it, the loser of the race gets
 * `E11000` and reads the winner's key, which is the correct outcome and the only one.
 */
async function ensureDataKeys(encryption: ClientEncryption): Promise<void> {
	for (const keyAltName of KEY_ALT_NAMES) {
		const existing = await encryption.getKeyByAltName(keyAltName)
		if (existing !== null) {
			continue
		}

		try {
			await encryption.createDataKey('local', { keyAltNames: [keyAltName] })
		} catch (error) {
			if (!(error instanceof MongoServerError) || error.code !== 11000) {
				throw error
			}
		}
	}
}

/**
 * Brings field encryption up. Idempotent, and safe to call from every service at startup.
 *
 * ⚠️ **Losing `masterKey` loses every encrypted field on the platform, permanently.** There is no
 * escrow and no recovery: the data encryption keys in the vault are themselves encrypted under it,
 * so without it the vault is four unreadable blobs and every `binData` in four collections stays a
 * blob for ever. It is the one credential here whose loss destroys data rather than requiring a
 * reset.
 */
export async function initFieldEncryption(config: IFieldEncryptionConfig): Promise<void> {
	if (config.masterKey.length !== MASTER_KEY_LENGTH) {
		throw new Error(`The CSFLE master key must be exactly ${MASTER_KEY_LENGTH} bytes, got ${config.masterKey.length}`)
	}

	await ensureKeyVaultIndex(config.client, config.keyVaultNamespace)

	const encryption = new ClientEncryption(config.client, {
		keyVaultNamespace: config.keyVaultNamespace,
		kmsProviders: { local: { key: config.masterKey } }
	})

	await ensureDataKeys(encryption)

	clientEncryption = encryption
}

export async function encryptValue(value: unknown, algorithm: EncryptionAlgorithm, keyAltName: string): Promise<Binary> {
	return await getFieldEncryption().encrypt(value, { keyAltName: keyAltName, algorithm: algorithm })
}

export async function decryptValue(value: Binary): Promise<unknown> {
	return await getFieldEncryption().decrypt(value)
}
