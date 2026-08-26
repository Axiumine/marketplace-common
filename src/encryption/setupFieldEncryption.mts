import { readFile } from 'node:fs/promises'

import { initFieldEncryption } from '@encryption/fieldEncryption.mjs'
import { MongoClient } from 'mongodb'
/*
 * ⚠️ Default import, not `import { connection }`. Mongoose is CommonJS, and `connection` is a getter
 * on its export object rather than a plain property, so Node's static analysis of the CJS module does
 * not see it: `import { connection } from 'mongoose'` type-checks, bundles, and passes every test that
 * runs under Vitest — then throws `does not provide an export named 'connection'` the first time a
 * service boots on plain Node. Reach through the default export instead.
 */
import mongoose from 'mongoose'

export const ENV_MASTER_KEY_PATH = 'CSFLE_MASTER_KEY_PATH'
export const ENV_KEY_VAULT_NAMESPACE = 'CSFLE_KEY_VAULT_NAMESPACE'

function requiredEnv(name: string): string {
	const value = process.env[name]

	if (value === undefined || value === '') {
		throw new Error(`${name} is not set — field encryption cannot start without it`)
	}

	return value
}

/**
 * What a service calls at startup, on the line after `MongoDBConnect()`.
 *
 * Everything it needs is either in the environment or already open, so nine services share one call
 * with no arguments rather than nine copies of the same twelve lines — the reason the three session
 * helpers live here too.
 *
 * ⚠️ **It must run before the first query, and it throws rather than warning if the environment is
 * incomplete.** A service that starts without it does not fail: it reads `binData` it cannot decrypt
 * and writes plaintext into collections whose other documents are encrypted, and neither shows up
 * until someone reads the data back. Refusing to start is the only failure mode of those three worth
 * having.
 *
 * ⚠️ **`CSFLE_MASTER_KEY_PATH` points at the one file whose loss destroys data.** The data keys in
 * the vault are encrypted under it; without it, four collections of `binData` stay `binData` for
 * ever. It is gitignored, it lives outside the repo, and it is not a credential that can be rotated
 * by resetting it.
 */
export async function setupFieldEncryption(client?: MongoClient): Promise<void> {
	const keyVaultNamespace = requiredEnv(ENV_KEY_VAULT_NAMESPACE)
	const masterKey = await readFile(requiredEnv(ENV_MASTER_KEY_PATH))

	await initFieldEncryption({
		client: client ?? mongoose.connection.getClient(),
		keyVaultNamespace: keyVaultNamespace,
		masterKey: masterKey
	})
}
