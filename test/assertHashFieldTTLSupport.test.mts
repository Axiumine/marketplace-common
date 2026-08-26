import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertHashFieldTTLSupport, HASH_FIELD_TTL_PROBE_KEY } from '../src/others/assertHashFieldTTLSupport.mts'

const REDIS_KEY = 'test:'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('assertHashFieldTTLSupport', () => {
	const store = (hTTL: () => Promise<unknown>) => ({ hTTL: vi.fn(hTTL) })

	/*
	 * ⚠️ **`hTTL`, and not `hExpire`.** This runs at boot against the live keyspace, so the probe has to be
	 * one that cannot change anything: a write would need a key of its own and a cleanup that a crash
	 * between the two would skip. Reading the TTL of a field of a key that does not exist is answerable on
	 * a 7.4 server and unknown on anything older, which is the whole question being asked.
	 */
	it('asks the server for a hash-field TTL, on a key it never writes', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => [-2])

		await expect(assertHashFieldTTLSupport(s)).resolves.toBeUndefined()

		expect(s.hTTL).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}hash-field-ttl-probe`, 'probe')
		expect(HASH_FIELD_TTL_PROBE_KEY()).toBe(`${REDIS_KEY}hash-field-ttl-probe`)
	})

	/*
	 * The reason the check exists at all: Redis accepts an unknown command at startup and refuses it at the
	 * first call, so without this the platform boots on a 7.2 server and dies inside the first login of the
	 * day, three layers below the symptom.
	 */
	it('refuses to boot on a Redis with no hash-field TTLs, and says which version is needed', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => {
			throw new Error("ERR unknown command 'HTTL', with args beginning with: ")
		})

		await expect(assertHashFieldTTLSupport(s)).rejects.toThrow('Redis is older than 7.4.0')
	})

	/*
	 * ⚠️ **Anything else is rethrown exactly as it arrived.** A boot-time probe is the first thing to touch
	 * Redis, so it is also the first thing to see a refused connection or a wrong password — and reporting
	 * either of those as a version problem sends whoever reads the log to the wrong page entirely.
	 */
	it('rethrows an error that is not about an unknown command, unchanged', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const connectionRefused = new Error('connect ECONNREFUSED 127.0.0.1:6379')
		const s = store(async () => {
			throw connectionRefused
		})

		await expect(assertHashFieldTTLSupport(s)).rejects.toBe(connectionRefused)
	})

	// The match is on the phrase, whatever case the server sent it in — the client surfaces the server's
	// own bytes and this is the only thing separating "too old" from "unreachable".
	it('recognises the phrase whatever its case', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => {
			throw new Error('ERR Unknown Command')
		})

		await expect(assertHashFieldTTLSupport(s)).rejects.toThrow('Redis is older than 7.4.0')
	})

	// The phrase is looked for in `.message` and nowhere else. A thrown string whose *value* is the phrase
	// is not a version problem, and translating it would be the probe answering a question nobody asked.
	it('reads the message and not the thrown value itself', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => {
			throw 'unknown command'
		})

		await expect(assertHashFieldTTLSupport(s)).rejects.toBe('unknown command')
	})

	/*
	 * ⚠️ **`(e as Error)?.message`, with the `?.`.** A rejection carries whatever was thrown, and `null` is
	 * as throwable as an Error; reading `.message` off it raises a TypeError *inside the handler*, so the
	 * boot failure that reaches the log is about property access and the real cause is gone. A thrown
	 * string does not show this — it has a `.message` of `undefined` and reads fine either way.
	 */
	it('rethrows a thrown null rather than dying on the property read', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store(async () => {
			throw null
		})

		await expect(assertHashFieldTTLSupport(s)).rejects.toBeNull()
	})
})
