import { Binary } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { pendingRegistrationKey } from '../src/others/registrationKeys.mts'
import { TIER } from '../src/others/Tier.mts'

const REDIS_KEY = 'test:'

// A deterministic ciphertext stand-in — the bytes only matter in that they are not the plaintext
// address, exactly as `login.email` never is on this path.
const EMAIL = new Binary(Buffer.from('ciphertext-bytes'), Binary.SUBTYPE_ENCRYPTED)
const EMAIL_HEX = Buffer.from('ciphertext-bytes').toString('hex')

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('pendingRegistrationKey', () => {
	// The whole string, literal: prefix, the word, the tier and the hex, each in place (ADR-042, ADR-043).
	it('builds the whole key from the prefix, the word, the tier and the hex', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(pendingRegistrationKey(TIER.user, EMAIL)).toBe(`${REDIS_KEY}pending:user:${EMAIL_HEX}`)
	})

	// Each literal segment and separator pinned apart from the whole string, so a mutant that drops one
	// colon or merges two segments cannot hide behind a coincidentally-matching total.
	it('carries the prefix, the word, the tier and the hex as four distinct pieces', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		const key = pendingRegistrationKey(TIER.shopOwner, EMAIL)

		expect(key.startsWith(REDIS_KEY)).toBe(true)
		expect(key.slice(REDIS_KEY.length, REDIS_KEY.length + 'pending:'.length)).toBe('pending:')
		expect(key.slice(`${REDIS_KEY}pending:`.length, `${REDIS_KEY}pending:`.length + 'shopOwner'.length)).toBe('shopOwner')
		expect(key.endsWith(`:${EMAIL_HEX}`)).toBe(true)
	})

	// ⚠️ The tier is part of the key: `user` and `shopOwner` are unrelated collections (ADR-002) and one
	// person may hold a pending registration in both at once, for the same address.
	it('gives the two tiers different keys for the same address', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(pendingRegistrationKey(TIER.user, EMAIL)).not.toBe(pendingRegistrationKey(TIER.shopOwner, EMAIL))
	})

	// ⚠️ The hex is the hex of the Binary's own bytes — not a digest of them, and not of the plaintext
	// address. The ciphertext is already the value MongoDB indexes (ADR-043).
	it('hex-encodes the Binary bytes verbatim, not a digest of them', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		const key = pendingRegistrationKey(TIER.user, EMAIL)

		expect(key.endsWith(EMAIL_HEX)).toBe(true)
		expect(Buffer.from(EMAIL_HEX, 'hex').equals(Buffer.from(EMAIL.buffer))).toBe(true)
	})

	// ⚠️ The prefix comes from the env variable, not a hard-coded constant — a deployment's own
	// `REDIS_KEY` is what every other builder on the platform reads it from too.
	it('takes the prefix from REDIS_KEY, not from a constant', () => {
		vi.stubEnv('REDIS_KEY', 'other:')

		expect(pendingRegistrationKey(TIER.user, EMAIL)).toBe(`other:pending:user:${EMAIL_HEX}`)
		expect(pendingRegistrationKey(TIER.user, EMAIL)).not.toBe(`${REDIS_KEY}pending:user:${EMAIL_HEX}`)
	})
})
