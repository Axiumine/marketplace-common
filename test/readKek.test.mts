import { afterEach, describe, expect, it, vi } from 'vitest'

import { readKek } from '../src/others/readKek.mts'

const KEK = Buffer.alloc(32, 7)

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('readKek', () => {
	/*
	 * The whole point of the function is that this is the only decode on the platform (ADR-040): `readKeygrip`
	 * and the two admin-resource reseal mutations all arrive here, so the length refusal below cannot be
	 * present in one of them and missing in another. `readKeygrip.test.mts` and `loadKeygrip.test.mts` prove
	 * the same refusals through their own callers — that is deliberate duplication, not redundancy: it is what
	 * would fail if one of them ever grew a private `Buffer.from` again.
	 */
	it('decodes the base64 environment value into the raw 32-byte key', () => {
		vi.stubEnv('KEYGRIP_KEK', KEK.toString('base64'))

		expect(readKek()).toEqual(KEK)
	})

	/*
	 * ⚠️ The message names the length it decoded to and nothing else. It is printed to a boot log, so a KEK
	 * that decoded to the wrong size must still not leak a byte of what it did decode to.
	 */
	it.each([
		['a KEK that decodes short', Buffer.alloc(31, 7).toString('base64'), 31],
		['a KEK that decodes long', Buffer.alloc(33, 7).toString('base64'), 33],
		['an unset KEK', null, 0]
	])('refuses %s', (_label, value, bytes) => {
		vi.stubEnv('KEYGRIP_KEK', value ?? undefined)

		expect(() => readKek()).toThrow(
			`KEYGRIP_KEK_MISMATCH: KEYGRIP_KEK must be base64 of 32 bytes, this one decodes to ${bytes}.`
		)
	})
})
