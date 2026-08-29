import { afterEach, describe, expect, it, vi } from 'vitest'

import { wrapKeygripKeys } from '../src/encryption/wrapKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'
import { readKeygrip } from '../src/others/readKeygrip.mts'

const REDIS_KEY = 'test:'

const KEK = Buffer.alloc(32, 7)

const KEYS: IKeygripKeyMaterial[] = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]

const FP = 'c77808de4139'

/** A store that can also write, so "it did not write" is an observation rather than a type argument. */
const store = () => ({
	hGetAll: vi.fn(async () => ({ version: '3', wrapped: wrapKeygripKeys(KEYS, 3, KEK), fp: FP })),
	hSet: vi.fn(async () => 1)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('readKeygrip', () => {
	/*
	 * ⚠️ The one thing this has that `loadKeygrip` does not is the *absence* of the holders write, and it is
	 * the reason the function exists: the admin service that rotates the keys holds the KEK to reseal the
	 * record, never to sign a cookie. A row it wrote would sit in the holders table with no heartbeat behind
	 * it, and E01-S14 reads that table to tell a service that has not adopted a rotation from one that is
	 * dead — a permanently stale row is indistinguishable from the second.
	 *
	 * Every refusal this shares with `loadKeygrip` is proved through it, in `loadKeygrip.test.mts`: they are
	 * one function split for one caller, not two.
	 */
	it('reads and unwraps the record without announcing the caller as a holder', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		vi.stubEnv('KEYGRIP_KEK', KEK.toString('base64'))
		const s = store()

		await expect(readKeygrip(s)).resolves.toEqual({ version: 3, fp: FP, keys: KEYS })
		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip`)
		expect(s.hSet).not.toHaveBeenCalled()
	})
})
