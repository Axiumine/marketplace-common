import { afterEach, describe, expect, it, vi } from 'vitest'

import { retentionLockKey } from '../src/others/retentionKeys.mts'

const REDIS_KEY = 'test:'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('retentionLockKey', () => {
	// The whole string, literal: the single key the fleet's hourly sweeps contend on (ADR-041).
	it('builds the whole key from the prefix and the constant', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(retentionLockKey()).toBe(`${REDIS_KEY}retention:lock`)
	})

	// Pinned apart from the whole string above, so a mutant that drops the colon or merges the two words
	// survives the literal check above only if the prefix half also happened to shift — this catches it
	// on the constant half alone.
	it('carries the prefix and the literal as two distinct pieces', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		const key = retentionLockKey()

		expect(key.startsWith(REDIS_KEY)).toBe(true)
		expect(key.slice(REDIS_KEY.length)).toBe('retention:lock')
	})

	// ⚠️ The prefix is read from the env variable, not a hard-coded constant — a deployment's own
	// `REDIS_KEY` is what keeps two environments from contending on the same lock.
	it('takes the prefix from REDIS_KEY, not from a constant', () => {
		vi.stubEnv('REDIS_KEY', 'other:')

		expect(retentionLockKey()).toBe('other:retention:lock')
		expect(retentionLockKey()).not.toBe(`${REDIS_KEY}retention:lock`)
	})
})
