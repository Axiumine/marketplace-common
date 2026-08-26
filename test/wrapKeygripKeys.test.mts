import { createDecipheriv } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { KEYGRIP_IV_BYTES, KEYGRIP_TAG_BYTES, wrapKeygripKeys } from '../src/encryption/wrapKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'

// A 32-byte key, written as bytes rather than read from anywhere. Nothing here is a real key.
const KEK = Buffer.alloc(32, 7)

const KEYS: IKeygripKeyMaterial[] = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]

/**
 * ⚠️ The reader is written out by hand, with the offsets as literals, and never calls
 * `unwrapKeygripKeys`. A test that opened the blob with this package's own reader would agree with the
 * writer about any layout the two happened to share — including a mutated one, since both take their
 * lengths from the same two constants. Hard-coding `12` and `16` here is what makes a change to either
 * constant fail rather than pass quietly.
 */
const openByHand = (wrapped: string, version: string, kek: Buffer): unknown => {
	const raw = Buffer.from(wrapped, 'base64')
	const decipher = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, 12))

	decipher.setAAD(Buffer.from(version, 'utf8'))
	decipher.setAuthTag(raw.subarray(12, 28))

	return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
}

describe('wrapKeygripKeys', () => {
	it('writes iv ‖ tag ‖ ciphertext, and the plaintext is the key array in the order given', () => {
		const wrapped = wrapKeygripKeys(KEYS, 3, KEK)

		expect(openByHand(wrapped, '3', KEK)).toEqual(KEYS)
	})

	it('writes the two lengths this format is defined by', () => {
		expect(KEYGRIP_IV_BYTES).toBe(12)
		expect(KEYGRIP_TAG_BYTES).toBe(16)
		expect(Buffer.from(wrapKeygripKeys([], 1, KEK), 'base64').length).toBe(12 + 16 + '[]'.length)
	})

	/*
	 * ⚠️ GCM is a stream cipher under the bonnet: a repeated iv under the same key leaks the xor of the
	 * two plaintexts and destroys the authentication guarantee outright. Rotation re-wraps the same key
	 * array whenever a key is appended, so "same input twice" is a case this platform actually reaches.
	 */
	it('draws a fresh iv per call, so wrapping the same keys twice never repeats a payload', () => {
		const first = wrapKeygripKeys(KEYS, 3, KEK)
		const second = wrapKeygripKeys(KEYS, 3, KEK)

		expect(first).not.toBe(second)
		expect(Buffer.from(first, 'base64').subarray(0, 12)).not.toEqual(Buffer.from(second, 'base64').subarray(0, 12))
	})

	/*
	 * ⚠️ The point of authenticating the version: a blob wrapped under an earlier version cannot be pasted
	 * back into a record whose version has moved on. Without this an attacker with write access to Redis —
	 * and no ability to decrypt anything — could roll the fleet back to a retired key set.
	 */
	it('binds the version, so a payload does not open under a different one', () => {
		const wrapped = wrapKeygripKeys(KEYS, 4, KEK)

		expect(() => openByHand(wrapped, '3', KEK)).toThrow()
		expect(openByHand(wrapped, '4', KEK)).toEqual(KEYS)
	})

	it('does not open under a different key', () => {
		const wrapped = wrapKeygripKeys(KEYS, 3, KEK)

		expect(() => openByHand(wrapped, '3', Buffer.alloc(32, 8))).toThrow()
	})
})
