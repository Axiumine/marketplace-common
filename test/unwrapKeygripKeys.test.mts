import { describe, expect, it } from 'vitest'

import { unwrapKeygripKeys } from '../src/encryption/unwrapKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'

const KEK = Buffer.alloc(32, 7)

const KEYS: IKeygripKeyMaterial[] = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]

/*
 * ⚠️ A golden vector, not a round trip. It was produced once, outside this repo's code, by encrypting
 * `KEYS` under `KEK` with version 3, a zero-ish iv and plain `node:crypto` — and it is checked in as a
 * literal so that this test knows the wire format independently of the writer. A round trip against
 * `wrapKeygripKeys` would keep passing if both halves of the format moved together, which is precisely
 * the failure that would strand every already-written record in Redis at the next deploy.
 */
const GOLDEN =
	'CQkJCQkJCQkJCQkJ/FySo7IAv6W2E5Q7HVS8vHz+pv3a0vtDy1DpFMSHwquxwgqSWMzN4ir8A/SQJkQolreikacAb0I64eBEAWamhjkG28ZXxuscID1ExRNEP9wpLc1czHSp8Z2yjCb6u8GnWLuORO5Vge847RPUGtVIMEYjkcGMD85bZ5PSWi22cSqJIi8b7/CvnDK2np5vPGLEsKopRkeSec96MPz0QtRymC/lTl7KYo5uJAnWvdXYLas5Ath8SKMX7cFytix7/VcumbDIiEjTK1nlso9mHg1hccgDQ2YRaVZeD1S9iovV2VG0P2YwJWK3ejsEMaXeew0YLLZrVqW7V26+UanFkuSdPzoBv8X6Rn9+sunYbZxuoY4etofiwZvvv+fL6Pa/Mc5AL0m008Kdngze5BnjS5uA6AbZkwDqs+2cJlr3JeFa9vhDD2k='

describe('unwrapKeygripKeys', () => {
	it('opens a record written elsewhere, keys and order intact', () => {
		expect(unwrapKeygripKeys(GOLDEN, 3, KEK)).toEqual(KEYS)
	})

	it('throws on the wrong key', () => {
		expect(() => unwrapKeygripKeys(GOLDEN, 3, Buffer.alloc(32, 8))).toThrow()
	})

	it('throws on the wrong version, because the version is the AAD', () => {
		expect(() => unwrapKeygripKeys(GOLDEN, 4, KEK)).toThrow()
	})

	/*
	 * One flipped byte of ciphertext. GCM is what makes this a throw rather than a plausible-looking key
	 * array: without the tag, a reader would hand `Keygrip` whatever the corrupted bytes decrypted to.
	 */
	it('throws on a tampered payload', () => {
		const raw = Buffer.from(GOLDEN, 'base64')

		raw[raw.length - 1] ^= 0xff

		expect(() => unwrapKeygripKeys(raw.toString('base64'), 3, KEK)).toThrow()
	})

	/*
	 * ⚠️ The message is asserted, not just the throw, and it is the one `authTagLength: 16` produces. A
	 * short blob leaves node holding an 8-byte tag, and GCM will happily verify against a truncated tag —
	 * legal, supported, and worth 2^64 instead of 2^128 to forge. Unpinned, node takes it with nothing but
	 * a deprecation warning and the failure arrives later as "unable to authenticate data"; pinned, the
	 * length itself is the rejection. Asserting the generic throw would pass either way.
	 */
	it('throws on a payload too short to hold an iv and a tag, on the tag length itself', () => {
		expect(() => unwrapKeygripKeys(Buffer.from(GOLDEN, 'base64').subarray(0, 20).toString('base64'), 3, KEK)).toThrow(
			'Invalid authentication tag length: 8'
		)
	})

	it('throws on an empty payload', () => {
		expect(() => unwrapKeygripKeys('', 3, KEK)).toThrow()
	})
})
