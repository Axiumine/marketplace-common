import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertRedisNamespace } from '../src/others/assertRedisNamespace.mts'

const REDIS_KEY = 'test:'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('assertRedisNamespace', () => {
	const store = (hGetAll: () => Promise<Record<string, string>>) => ({ hGetAll: vi.fn(hGetAll) })

	/*
	 * The key is read through `keygripKey()` rather than rebuilt here, so the prefix this probe asks about
	 * is the same string every other reader of the record derives — a second spelling of it would make the
	 * check pass against a namespace nobody else uses.
	 */
	it('reads the fleet keygrip record under the configured prefix, and writes nothing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => ({ wrapped: 'x', version: '1', fp: 'abc' }))

		await expect(assertRedisNamespace(s)).resolves.toBeUndefined()

		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip`)
	})

	/*
	 * The reason the check exists: a wrong `REDIS_KEY` is a prefix Redis will happily serve, so a resource
	 * service pointed at an unseeded namespace used to boot clean and 401 every request that followed.
	 */
	it('refuses to boot when the namespace holds no record, and names the prefix it looked under', async () => {
		vi.stubEnv('REDIS_KEY', 'wrong:')
		const s = store(async () => ({}))

		await expect(assertRedisNamespace(s)).rejects.toThrow('KEYGRIP_RECORD_MISSING')
		await expect(assertRedisNamespace(s)).rejects.toThrow('wrong:keygrip')
	})

	// Both causes are named because the process cannot tell them apart, and they need different fixes.
	it('names the two remedies a reader has to choose between', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => ({}))

		await expect(assertRedisNamespace(s)).rejects.toThrow('REDIS_KEY names a namespace')
		await expect(assertRedisNamespace(s)).rejects.toThrow('yarn seed:keygrip')
	})

	/*
	 * ⚠️ **`wrapped` is the field tested, not the emptiness of the hash.** A record stripped of its key
	 * material but left with its bookkeeping is not a namespace this platform can be pointed at, and a
	 * truthiness test over the object would accept it.
	 */
	it('refuses a record that carries bookkeeping but no key material', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => ({ version: '1', fp: 'abc' }))

		await expect(assertRedisNamespace(s)).rejects.toThrow('KEYGRIP_RECORD_MISSING')
	})

	// An empty string is what `hGetAll` gives back for a field written empty, and it is not key material.
	it('refuses an empty wrapped field', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => ({ wrapped: '', version: '1', fp: 'abc' }))

		await expect(assertRedisNamespace(s)).rejects.toThrow('KEYGRIP_RECORD_MISSING')
	})

	/*
	 * ⚠️ **`record?.wrapped`, with the `?.`.** node-redis answers a missing key with an empty object, but a
	 * `null` is what several of its own type definitions allow and what a mock or a future client version
	 * may hand back; reading `.wrapped` off it raises a TypeError *inside the boot*, so the failure that
	 * reaches the log is about property access and the cause — a wrong prefix — is gone.
	 */
	it('refuses rather than dying on the property read when the client answers null', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => null as unknown as Record<string, string>)

		await expect(assertRedisNamespace(s)).rejects.toThrow('KEYGRIP_RECORD_MISSING')
	})

	/*
	 * ⚠️ **Presence only.** The record's version and fingerprint are `readKeygrip`'s business, on behalf of
	 * the services that unwrap it — this one is asked whether the record is *here*, and a well-formedness
	 * opinion it cannot act on would refuse a boot the signing tier is perfectly happy with.
	 */
	it('accepts a record whose other fields are absent, having been asked only where it is', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => ({ wrapped: 'x' }))

		await expect(assertRedisNamespace(s)).resolves.toBeUndefined()
	})

	// A refused connection at boot is a refused connection, and dressing it as a prefix problem would send
	// whoever reads the log to the wrong page.
	it('rethrows a store failure unchanged', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const connectionRefused = new Error('connect ECONNREFUSED 127.0.0.1:6379')
		const s = store(async () => {
			throw connectionRefused
		})

		await expect(assertRedisNamespace(s)).rejects.toBe(connectionRefused)
	})
})
