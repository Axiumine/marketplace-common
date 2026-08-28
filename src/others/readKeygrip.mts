import { unwrapKeygripKeys } from '@encryption/unwrapKeygripKeys.mjs'
import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'
import { readKek } from '@others/readKek.mjs'
import { keygripKey } from '@others/sessionKeys.mjs'

/**
 * The one Redis verb reading the record needs, as a parameter (ADR-034).
 *
 * ⚠️ **The client is a parameter, not an import**, for the reason `assertUnderRateLimit` states at
 * length: importing `redisClient` here would pull the `redis` types into this package, and `redis` is a
 * dependency of the *services*, not of this library.
 */
export interface IKeygripReadStore {
	hGetAll(key: string): Promise<Record<string, string>>
}

/** What the record holds, unwrapped, as the caller needs it. */
export interface IKeygripRecord {
	version: number
	fp: string
	keys: IKeygripKeyMaterial[]
}

/**
 * Reads the fleet's cookie-signing keys out of Redis and unwraps them, or throws (ADR-034).
 *
 * ⚠️ **Reading is not holding.** This writes nothing, which is what separates it from `loadKeygrip`: the
 * five services that *sign* with these keys announce themselves in the holders table, and the operator
 * service that rotates them must not — it holds the KEK to reseal the record, never to sign a cookie, and
 * a row it wrote would sit in that table without a heartbeat behind it, indistinguishable from a signing
 * service that died.
 *
 * The two failures are deliberately two, because they need two different fixes:
 *
 * - `KEYGRIP_RECORD_MISSING` — nobody has minted a key set yet, or the record was flushed with the rest
 *   of Redis. The operator runs the seed script. Nothing is wrong with the caller.
 * - `KEYGRIP_KEK_MISMATCH` — a key set exists and this process cannot open it. The length half of that
 *   refusal is `readKek`'s, which every KEK decode on the platform goes through (ADR-040); the unwrap half
 *   is below, because only a caller holding the record can tell that the key is the wrong one rather than
 *   the wrong shape. Its `KEYGRIP_KEK` differs
 *   from the one the record was written under. For a signing service, starting anyway would be the
 *   split-brain this whole design removes; for the rotation mutation, rewrapping anyway would hand the
 *   fleet a record none of it can open.
 *
 * ⚠️ **No message here names a key, a fingerprint of key material, or any part of the KEK.** These
 * strings are printed to a boot log, which is the least protected place on the platform. The version and
 * the record fingerprint are safe by construction — see `keygripFingerprint` — and are what an operator
 * actually needs to tell two records apart.
 */
export async function readKeygrip(store: IKeygripReadStore): Promise<IKeygripRecord> {
	const record = await store.hGetAll(keygripKey())

	if (!record?.wrapped || !record.version || !record.fp)
		throw new Error(
			`KEYGRIP_RECORD_MISSING: no keygrip key set at "${keygripKey()}". Run "yarn seed:keygrip" in marketplace-db-setup before starting any service.`
		)

	const kek = readKek()

	const version = Number(record.version)

	let keys: IKeygripKeyMaterial[]

	try {
		keys = unwrapKeygripKeys(record.wrapped, version, kek)
	} catch {
		throw new Error(
			`KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version ${record.version} (${record.fp}). Its KEYGRIP_KEK is not the one the record was written under.`
		)
	}

	if (keys.length === 0)
		throw new Error(
			`KEYGRIP_RECORD_MISSING: keygrip record version ${record.version} (${record.fp}) holds no keys. Run "yarn seed:keygrip" in marketplace-db-setup.`
		)

	return { version, fp: record.fp, keys }
}
