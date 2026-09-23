import { describe, expect, it } from 'vitest'

import { assertPasswordByteLength } from '../src/others/assertPasswordByteLength.mts'
import { expectStatus, rejection } from './graphQLErrors.mts'

describe('assertPasswordByteLength', () => {
	// The boundary itself, both sides of it, in plain ASCII where every character is exactly one byte —
	// the case `.length` and `Buffer.byteLength` agree on, and the one a mutated `>`/`>=` shows up on.
	it('accepts exactly 72 bytes and refuses 73, in plain ASCII', () => {
		const seventyTwo = 'a'.repeat(72)
		const seventyThree = 'a'.repeat(73)

		expect(() => assertPasswordByteLength(seventyTwo)).not.toThrow()
		expect(() => assertPasswordByteLength(seventyThree)).toThrow()
	})

	/*
	 * ⚠️ **The bug this helper exists to close, reproduced directly.** Thirty-seven precomposed `é`
	 * characters are 37 UTF-16 code units — comfortably under every length-based limit this platform
	 * has ever enforced, including koa-utils' own `checkPwdLen` — but each one is two UTF-8 bytes, so the
	 * string is 74 bytes: past what bcrypt actually hashes. A caller measuring `.length` alone waves this
	 * straight through; a caller measuring bytes refuses it before it ever reaches bcrypt.
	 */
	it('refuses a password that is short by .length but long by UTF-8 bytes', () => {
		const password = 'é'.repeat(37)

		expect(password.length).toBe(37)
		expect(Buffer.byteLength(password, 'utf8')).toBe(74)
		expect(() => assertPasswordByteLength(password)).toThrow()
	})

	// The mirror case at the same character: 36 of the same two-byte character is exactly 72 bytes, so it
	// must be accepted even though `.length` (36) looks nothing like the byte count that matters.
	it('accepts a password whose byte length lands exactly on the boundary via multi-byte characters', () => {
		const password = 'é'.repeat(36)

		expect(Buffer.byteLength(password, 'utf8')).toBe(72)
		expect(() => assertPasswordByteLength(password)).not.toThrow()
	})

	// Emoji: four-byte UTF-8 sequences and surrogate pairs in UTF-16, the character class the bug report
	// names by name. Nineteen of them is 38 UTF-16 code units and 76 bytes — refused on bytes, and another
	// shape `.length` alone would have missed.
	it('refuses an emoji-heavy password that stays under any character-count limit', () => {
		const password = '😀'.repeat(19)

		expect(password.length).toBe(38)
		expect(Buffer.byteLength(password, 'utf8')).toBe(76)
		expect(() => assertPasswordByteLength(password)).toThrow()
	})

	// Short passwords are not this helper's job — `checkPwdLen` still owns the floor — so an empty string
	// must pass through untouched rather than being refused as "too long" by an inverted comparison.
	it('does not refuse a short password', () => {
		expect(() => assertPasswordByteLength('')).not.toThrow()
		expect(() => assertPasswordByteLength('short')).not.toThrow()
	})

	/*
	 * ⚠️ **The exact shape `checkPwdLen` throws for its own "too long" branch**, asserted field by field so
	 * a client needs no second branch to handle this guard's refusal. Same title, same HTTP status, same
	 * description — the two are indistinguishable on the wire, which is the whole point.
	 */
	it('throws the same GraphQLError shape checkPwdLen throws for a too-long password', async () => {
		const error = await rejection(() => assertPasswordByteLength('a'.repeat(73)))

		expectStatus(error, 400, 'Bad Request')
		expect(error.extensions.description).toBe('Password is too long')
		expect(Object.keys(error.extensions)).toEqual(['http', 'description'])
	})
})
