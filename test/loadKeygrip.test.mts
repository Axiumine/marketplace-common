import { afterEach, describe, expect, it, vi } from 'vitest'

import { wrapKeygripKeys } from '../src/encryption/wrapKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'
import { IKeygripLoadStore, loadKeygrip } from '../src/others/loadKeygrip.mts'
import { KEYGRIP_HOLDER_TTL_SECONDS } from '../src/others/recordKeygripHolder.mts'

const REDIS_KEY = 'test:'
const SERVICE = 'marketplace-dev-public-authorization'

const KEK = Buffer.alloc(32, 7)
const KEK_B64 = KEK.toString('base64')

const KEYS: IKeygripKeyMaterial[] = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]

// The same checked-in blob `unwrapKeygripKeys.test.mts` opens: `KEYS`, version 3, under `KEK`.
const GOLDEN =
	'CQkJCQkJCQkJCQkJ/FySo7IAv6W2E5Q7HVS8vHz+pv3a0vtDy1DpFMSHwquxwgqSWMzN4ir8A/SQJkQolreikacAb0I64eBEAWamhjkG28ZXxuscID1ExRNEP9wpLc1czHSp8Z2yjCb6u8GnWLuORO5Vge847RPUGtVIMEYjkcGMD85bZ5PSWi22cSqJIi8b7/CvnDK2np5vPGLEsKopRkeSec96MPz0QtRymC/lTl7KYo5uJAnWvdXYLas5Ath8SKMX7cFytix7/VcumbDIiEjTK1nlso9mHg1hccgDQ2YRaVZeD1S9iovV2VG0P2YwJWK3ejsEMaXeew0YLLZrVqW7V26+UanFkuSdPzoBv8X6Rn9+sunYbZxuoY4etofiwZvvv+fL6Pa/Mc5AL0m008Kdngze5BnjS5uA6AbZkwDqs+2cJlr3JeFa9vhDD2k='

const FP = 'c77808de4139'

const RECORD: Record<string, string> = { version: '3', wrapped: GOLDEN, fp: FP }

const store = (
	hash: Record<string, string> | null = RECORD
): IKeygripLoadStore & { [K in keyof IKeygripLoadStore]: ReturnType<typeof vi.fn> } => ({
	hGetAll: vi.fn(async () => hash as Record<string, string>),
	hSet: vi.fn(async () => 1),
	hExpire: vi.fn(async () => [1])
})

// `null` means "not set at all" — passing `undefined` would take the default parameter instead.
const env = (kek: string | null = KEK_B64) => {
	vi.stubEnv('REDIS_KEY', REDIS_KEY)
	vi.stubEnv('KEYGRIP_KEK', kek ?? undefined)
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('loadKeygrip', () => {
	it('reads the record, unwraps it, and answers version, fingerprint and keys in order', async () => {
		env()
		const s = store()

		await expect(loadKeygrip(s, SERVICE)).resolves.toEqual({ version: 3, fp: FP, keys: KEYS })
		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip`)
	})

	/*
	 * ⚠️ The holders row is the detection this whole design was written for: five services, five rows, and
	 * a disagreement visible as two different fingerprints instead of as users being logged out at random.
	 * The timestamp is what turns it into rotation progress — a service still showing the old fingerprint
	 * an hour after a rotation has not swapped.
	 */
	it('records this service as a holder of the fingerprint it read, stamped now', async () => {
		env()
		const s = store()

		await loadKeygrip(s, SERVICE)

		expect(s.hSet).toHaveBeenCalledExactlyOnceWith(
			`${REDIS_KEY}keygrip:holders`,
			SERVICE,
			expect.stringMatching(/^c77808de4139@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		)
		// And the row is given an hour to live, refreshed by every heartbeat behind it: a service that
		// stops heartbeating leaves the table on its own instead of sitting in it as a permanent red.
		expect(s.hExpire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip:holders`, SERVICE, KEYGRIP_HOLDER_TTL_SECONDS)
		// ⚠️ Ordered: HEXPIRE on a field that does not exist yet is a no-op that answers -2, so a row
		// written after its own expiry would never expire at all.
		expect(s.hSet.mock.invocationCallOrder[0]).toBeLessThan(s.hExpire.mock.invocationCallOrder[0])
	})

	it.each([
		['an empty hash', {}],
		['no reply at all', null],
		['a record with no wrapped blob', { version: '3', fp: FP }],
		['a record with no version', { wrapped: GOLDEN, fp: FP }],
		['a record with no fingerprint', { version: '3', wrapped: GOLDEN }]
	])('refuses to boot on %s', async (_label, hash) => {
		env()
		const s = store(hash as Record<string, string> | null)

		await expect(loadKeygrip(s, SERVICE)).rejects.toThrow(
			`KEYGRIP_RECORD_MISSING: no keygrip key set at "${REDIS_KEY}keygrip". Run "yarn seed:keygrip" in marketplace-db-setup before starting any service.`
		)
		expect(s.hSet).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ A key set that unwraps to nothing would build `new Keygrip([])`, which throws deep inside the
	 * cookie layer on the first signed cookie rather than at boot — a service that starts and then fails
	 * every request. Caught here, where the answer is the same seed script.
	 */
	it('refuses to boot on a record that holds no keys', async () => {
		env()
		const s = store({ version: '9', wrapped: wrapKeygripKeys([], 9, KEK), fp: 'e3b0c44298fc' })

		await expect(loadKeygrip(s, SERVICE)).rejects.toThrow(
			'KEYGRIP_RECORD_MISSING: keygrip record version 9 (e3b0c44298fc) holds no keys. Run "yarn seed:keygrip" in marketplace-db-setup.'
		)
		expect(s.hSet).not.toHaveBeenCalled()
	})

	it.each([
		['a KEK that decodes short', Buffer.alloc(31, 7).toString('base64'), 31],
		['a KEK that decodes long', Buffer.alloc(33, 7).toString('base64'), 33],
		['an unset KEK', null, 0]
	])('refuses to boot on %s', async (_label, kek, bytes) => {
		env(kek)
		const s = store()

		await expect(loadKeygrip(s, SERVICE)).rejects.toThrow(
			`KEYGRIP_KEK_MISMATCH: KEYGRIP_KEK must be base64 of 32 bytes, this one decodes to ${bytes}.`
		)
		expect(s.hSet).not.toHaveBeenCalled()
	})

	/*
	 * The failure the platform has already paid for twice, now caught at boot instead of at request time:
	 * this service holds a different key from the one the record was written under.
	 */
	it('refuses to boot when its KEK is not the one the record was written under', async () => {
		env(Buffer.alloc(32, 8).toString('base64'))
		const s = store()

		await expect(loadKeygrip(s, SERVICE)).rejects.toThrow(
			'KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 3 (c77808de4139). Its KEYGRIP_KEK is not the one the record was written under.'
		)
		expect(s.hSet).not.toHaveBeenCalled()
	})

	// Same refusal for a blob that no longer matches the version it is filed under — a rollback attempt.
	it('refuses to boot when the blob does not match the version it is filed under', async () => {
		env()
		const s = store({ ...RECORD, version: '4' })

		await expect(loadKeygrip(s, SERVICE)).rejects.toThrow(
			'KEYGRIP_KEK_MISMATCH: this service cannot unwrap keygrip record version 4 (c77808de4139). Its KEYGRIP_KEK is not the one the record was written under.'
		)
		expect(s.hSet).not.toHaveBeenCalled()
	})
})
