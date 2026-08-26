import { Schema } from 'mongoose'
import { describe, expect, it, vi } from 'vitest'

import { BaseAddressSchema } from '../src/models/MongoDB/sub/BaseAddressSchema.mts'
import { EmailVerifySubDocSchema } from '../src/models/MongoDB/sub/EmailVerifySubDocSchema.mts'
import { LoginSubDocSchema } from '../src/models/MongoDB/sub/LoginSubDocSchema.mts'
import { ResetPwdSubDocSchema } from '../src/models/MongoDB/sub/ResetPwdSubDocSchema.mts'

describe('sub-document schemas build with the expected paths', () => {
	it('BaseAddressSchema', () => {
		expect(BaseAddressSchema).toBeInstanceOf(Schema)
		expect(BaseAddressSchema.options._id).toBe(false)
		for (const p of ['street', 'postalCode', 'city', 'province']) {
			const path = BaseAddressSchema.path(p)
			expect(path.instance).toBe('String')
			expect(path.isRequired).toBe(true)
		}
	})

	it('ResetPwdSubDocSchema', () => {
		expect(ResetPwdSubDocSchema.path('resetDateReq').instance).toBe('Date')
		expect(ResetPwdSubDocSchema.path('resetHash').instance).toBe('String')
		expect(ResetPwdSubDocSchema.options._id).toBe(false)
	})

	// `isRequired` is asserted undefined on every member, not skipped as an uninteresting default:
	// the verify-email flow writes the members one subset at a time (`setEmailHash` sets hash +
	// requestTimes + dateLastReq and never valid; `enableEmailAccess` sets valid and unsets the rest),
	// so a `required: true` on any of them would reject a document the flow itself produces. The path
	// list is length-checked for the same reason — an extra path here is a path the collection
	// validator rejects under `additionalProperties: false`, and a missing one is silently dropped
	// from every write.
	it('EmailVerifySubDocSchema', () => {
		expect(EmailVerifySubDocSchema).toBeInstanceOf(Schema)
		expect(EmailVerifySubDocSchema.options._id).toBe(false)

		const expected = {
			valid: 'Boolean',
			hash: 'String',
			dateLastReq: 'Date',
			requestTimes: 'Number',
			// Encrypted (ADR-029), which is why it is not a `String` path: a `Binary` cast through one
			// comes back out as the text `Binary.toString()` produces.
			newEmailTmp: 'EncryptedField'
		}

		for (const [name, instance] of Object.entries(expected)) {
			const path = EmailVerifySubDocSchema.path(name)
			expect(path.instance).toBe(instance)
			expect(path.isRequired).toBeUndefined()
		}

		expect(EmailVerifySubDocSchema.path('newEmailTmp').options.plaintext).toBe('string')

		expect(Object.keys(EmailVerifySubDocSchema.paths)).toEqual(Object.keys(expected))
	})

	it('LoginSubDocSchema', () => {
		expect(LoginSubDocSchema.options._id).toBe(false)

		// Encrypted, and deterministic — it is the credential every login matches on and the key of
		// `login.email_unique`. The path type is what stops Mongoose casting the ciphertext to text.
		const email = LoginSubDocSchema.path('email')
		expect(email.instance).toBe('EncryptedField')
		expect(email.options.plaintext).toBe('string')
		expect(email.isRequired).toBe(true)

		// Never encrypted: a bcrypt hash is not personal data, and every login compares against it.
		const password = LoginSubDocSchema.path('password')
		expect(password.instance).toBe('String')
		expect(password.isRequired).toBe(true)

		const firstLogin = LoginSubDocSchema.path('firstLogin')
		expect(firstLogin.instance).toBe('Date')
		expect(firstLogin.isRequired).toBeUndefined()

		const lastLogin = LoginSubDocSchema.path('lastLogin')
		expect(lastLogin.instance).toBe('Date')
		expect(lastLogin.isRequired).toBeUndefined()

		const rememberMe = LoginSubDocSchema.path('rememberMe')
		expect(rememberMe.instance).toBe('Boolean')
		expect(rememberMe.isRequired).toBeUndefined()

		const onboardingStep = LoginSubDocSchema.path('onboardingStep')
		expect(onboardingStep.instance).toBe('String')
		expect(onboardingStep.isRequired).toBeUndefined()

		const onboardingDone = LoginSubDocSchema.path('onboardingDone')
		expect(onboardingDone.instance).toBe('Boolean')
		expect(onboardingDone.isRequired).toBeUndefined()
	})
})

describe('LoginSubDocSchema pre-save password hook', () => {
	// The hook is registered via schema.pre('save', ...). Pull it straight out of Kareem so both
	// branches can be exercised without a live MongoDB connection.
	function preSaveHook(): (this: { isModified(field: string): boolean; password: string }) => Promise<void> {
		const pres = (
			LoginSubDocSchema as unknown as { s: { hooks: { _pres: Map<string, Array<{ fn: unknown }>> } } }
		).s.hooks._pres.get('save')
		expect(pres).toBeDefined()
		return (pres as Array<{ fn: unknown }>)[0].fn as never
	}

	it('does nothing when the password was not modified', async () => {
		const hook = preSaveHook()
		// Asserting the call argument (not just the return value) catches a mutant that changes
		// the 'password' string literal the hook passes to isModified().
		const isModified = vi.fn(() => false)
		const ctx = { isModified, password: 'plain-text' }
		await hook.call(ctx)
		expect(isModified).toHaveBeenCalledWith('password')
		expect(ctx.password).toBe('plain-text')
	})

	it('hashes the password when it was modified', async () => {
		const hook = preSaveHook()
		const isModified = vi.fn(() => true)
		const ctx = { isModified, password: 'plain-text' }
		await hook.call(ctx)
		expect(isModified).toHaveBeenCalledWith('password')
		expect(ctx.password).not.toBe('plain-text')
		expect(ctx.password).toMatch(/^\$2[aby]\$/)
	})
})
