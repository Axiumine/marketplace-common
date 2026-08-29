import { Schema } from 'mongoose'
import { describe, expect, it } from 'vitest'

import { ENCRYPTED_FIELDS_SHOP_OWNER, ENCRYPTED_FIELDS_USER } from '../src/encryption/encryptedFields.mts'
import { ShopOwner } from '../src/models/MongoDB/ShopOwner.mts'
import { User } from '../src/models/MongoDB/User.mts'
import {
	buildAccountScrub,
	SCRUBBED_DISABLED_REASON,
	SCRUBBED_EMAIL_HOST,
	SCRUBBED_FIRST_NAME,
	SCRUBBED_LAST_NAME,
	SCRUBBED_PASSWORD_HASH,
	SCRUBBED_POSTAL_CODE,
	SCRUBBED_PROVINCE,
	SCRUBBED_TEXT,
	scrubbedBirthDate,
	scrubbedEmail
} from '../src/others/accountScrub.mts'
import { TIER } from '../src/others/Tier.mts'

const ACCOUNT_ID = '68b1a9c4d3e2f10123456789'
const AT = new Date('2026-09-28T00:00:00.000Z')

/**
 * The paths a scrub deliberately leaves exactly as it found them, per collection.
 *
 * ⚠️ **This list is the whole point of the suite.** A field added to either model is, by default, in
 * none of the three sets below, and the assertion that the three cover the schema then fails — which
 * forces whoever added it to say whether it is personal data. The failure mode this exists to prevent
 * is silent and permanent: a personal field nobody classified survives every scrub, and nothing
 * anywhere reports it.
 *
 * `deleted`, `deletedBy`, `disabled` and `disabledBy` are the record ADR-041 keeps for ever, and
 * `registeredAt` is what makes it a record of *when*. `waitApprov` is an approval state, not a person.
 */
const KEEP_USER = ['_id', 'registeredAt', 'deleted', 'deletedBy', 'disabled', 'disabledBy', '__v']
const KEEP_SHOP_OWNER = [...KEEP_USER, 'waitApprov']

/** The members of `login` a scrub leaves standing: neither is one, so the list is empty and says so. */
const KEEP_LOGIN: string[] = []

/**
 * The two states an account can reach the sweep in, because they take different halves of the update.
 *
 * ⚠️ **A suite that only ever built one of them would be blind to the case ADR-041 had to special-case.**
 * `disabledReason` is overwritten on an account that was parked and removed on one that never was, so a
 * fixture fixed at either value leaves the other branch free to drop an encrypted path or to leave a
 * schema path classified as neither personal nor kept.
 */
const SUSPENSIONS = [
	{ label: 'suspended', disabled: true },
	{ label: 'never suspended', disabled: false }
] as const

/** The two collections, each with the pieces of itself a scrub has to be measured against. */
const TIERS = [
	{ tier: TIER.user, schema: User.schema, keep: KEEP_USER, fields: ENCRYPTED_FIELDS_USER },
	{ tier: TIER.shopOwner, schema: ShopOwner.schema, keep: KEEP_SHOP_OWNER, fields: ENCRYPTED_FIELDS_SHOP_OWNER }
] as const

/** Both collections crossed with both suspension states — the four documents the sweep actually meets. */
const CASES = SUSPENSIONS.flatMap(({ label, disabled }) =>
	TIERS.map((entry) => ({ ...entry, disabled, name: `${entry.tier} (${label})` }))
)

const topLevelPaths = (schema: Schema) => Object.keys(schema.paths)

const subPaths = (schema: Schema, path: string) => Object.keys((schema.path(path) as unknown as { schema: Schema }).schema.paths)

/** The top-level path a `$set` or `$unset` key belongs to — `login.firstLogin` is `login`. */
const rootOf = (path: string) => path.split('.')[0] as string

describe('the scrub covers every path both collections carry', () => {
	it.each(CASES)('$name — every path is overwritten, removed or deliberately kept', ({ tier, schema, keep, disabled }) => {
		const scrub = buildAccountScrub(tier, ACCOUNT_ID, AT, disabled)
		const touched = new Set([...Object.keys(scrub.$set), ...Object.keys(scrub.$unset)].map(rootOf))

		expect([...touched, ...keep].sort()).toStrictEqual([...new Set([...touched, ...keep])].sort())
		expect(topLevelPaths(schema).filter((path) => !touched.has(path) && !keep.includes(path))).toStrictEqual([])
	})

	it.each(CASES)(
		'$name — every member of login is overwritten or removed, none is merely left',
		({ tier, schema, disabled }) => {
			const scrub = buildAccountScrub(tier, ACCOUNT_ID, AT, disabled)
			const touched = new Set(
				[...Object.keys(scrub.$set), ...Object.keys(scrub.$unset)]
					.filter((path) => path.startsWith('login.'))
					.map((path) => path.slice('login.'.length))
			)

			expect(subPaths(schema, 'login').filter((member) => !touched.has(member) && !KEEP_LOGIN.includes(member))).toStrictEqual(
				[]
			)
		}
	)

	it.each(CASES)('$name — no encrypted path survives a scrub untouched', ({ tier, fields, disabled }) => {
		const scrub = buildAccountScrub(tier, ACCOUNT_ID, AT, disabled)
		const keys = [...Object.keys(scrub.$set), ...Object.keys(scrub.$unset)]
		const reached = (path: string) => keys.some((key) => key === path || path.startsWith(`${key}.`))

		expect(fields.map(({ path }) => path).filter((path) => !reached(path))).toStrictEqual([])
	})
})

describe('what the scrub writes', () => {
	it('moves the address to a per-account name under a host that can never resolve', () => {
		expect(scrubbedEmail(ACCOUNT_ID)).toBe(`deleted-${ACCOUNT_ID}@${SCRUBBED_EMAIL_HOST}`)
		expect(scrubbedEmail(ACCOUNT_ID)).not.toBe(scrubbedEmail('68b1a9c4d3e2f10123456780'))
		expect(buildAccountScrub(TIER.user, ACCOUNT_ID, AT, false).$set['login.email']).toBe(scrubbedEmail(ACCOUNT_ID))
	})

	it('leaves a password nobody holds, in the exact shape the validator demands', () => {
		expect(SCRUBBED_PASSWORD_HASH).toHaveLength(60)
		expect(SCRUBBED_PASSWORD_HASH).toMatch(/^\$2[aby]\$14\$/)
		expect(buildAccountScrub(TIER.shopOwner, ACCOUNT_ID, AT, false).$set['login.password']).toBe(SCRUBBED_PASSWORD_HASH)
	})

	it('stamps scrubbedAt with the moment it was handed, so the sweep stops selecting the row', () => {
		expect(buildAccountScrub(TIER.user, ACCOUNT_ID, AT, false).$set.scrubbedAt).toBe(AT)
	})

	it('gives the customer the two-member block that collection requires, and nothing more', () => {
		expect(buildAccountScrub(TIER.user, ACCOUNT_ID, AT, false).$set.personalData).toStrictEqual({
			firstName: SCRUBBED_FIRST_NAME,
			lastName: SCRUBBED_LAST_NAME
		})
	})

	it('gives the shop owner every member its all-or-nothing block requires', () => {
		expect(buildAccountScrub(TIER.shopOwner, ACCOUNT_ID, AT, false).$set.personalData).toStrictEqual({
			firstName: SCRUBBED_FIRST_NAME,
			lastName: SCRUBBED_LAST_NAME,
			birth: { date: new Date(0) },
			address: {
				street: SCRUBBED_TEXT,
				postalCode: SCRUBBED_POSTAL_CODE,
				city: SCRUBBED_TEXT,
				province: SCRUBBED_PROVINCE
			},
			contacts: {
				mobile: SCRUBBED_TEXT,
				email: scrubbedEmail(ACCOUNT_ID)
			}
		})
	})

	it('hands out a fresh birth date every time, so no caller can mutate the one the next scrub uses', () => {
		const first = scrubbedBirthDate()
		first.setUTCFullYear(1999)

		expect(scrubbedBirthDate()).toStrictEqual(new Date(0))
	})

	it('removes the address book only on the collection that has one, and the notes only on the other', () => {
		const user = buildAccountScrub(TIER.user, ACCOUNT_ID, AT, false).$unset
		const shopOwner = buildAccountScrub(TIER.shopOwner, ACCOUNT_ID, AT, false).$unset

		expect(Object.keys(user)).toContain('addresses')
		expect(Object.keys(user)).toContain('defaultAddress')
		expect(Object.keys(user)).not.toContain('notes')
		expect(Object.keys(shopOwner)).toContain('notes')
		expect(Object.keys(shopOwner)).not.toContain('addresses')
	})

	it('removes the two credential sub-documents on both', () => {
		for (const tier of [TIER.user, TIER.shopOwner] as const) {
			const { $unset } = buildAccountScrub(tier, ACCOUNT_ID, AT, false)

			expect($unset.emailVerify).toBe('')
			expect($unset.resetPwd).toBe('')
		}
	})

	it('says the note was erased rather than leaving something an operator could have typed', () => {
		expect(SCRUBBED_DISABLED_REASON).toBe('Deleted — the reason was erased with the account')
		expect(SCRUBBED_DISABLED_REASON.startsWith(SCRUBBED_TEXT)).toBe(true)
	})

	it('overwrites the operator reason on an account that was parked, because removing it is refused', () => {
		for (const tier of [TIER.user, TIER.shopOwner] as const) {
			const { $set, $unset } = buildAccountScrub(tier, ACCOUNT_ID, AT, true)

			expect($set.disabledReason).toBe(SCRUBBED_DISABLED_REASON)
			expect('disabledReason' in $unset).toBe(false)
		}
	})

	it('removes the operator reason outright on an account that was never parked', () => {
		for (const tier of [TIER.user, TIER.shopOwner] as const) {
			const { $set, $unset } = buildAccountScrub(tier, ACCOUNT_ID, AT, false)

			expect($unset.disabledReason).toBe('')
			expect('disabledReason' in $set).toBe(false)
		}
	})

	it('keeps the closure record itself out of both halves of the update', () => {
		for (const { tier, disabled } of CASES) {
			const { $set, $unset } = buildAccountScrub(tier, ACCOUNT_ID, AT, disabled)

			for (const path of ['deleted', 'deletedBy', 'disabled', 'disabledBy', 'registeredAt', '_id']) {
				expect(path in $set).toBe(false)
				expect(path in $unset).toBe(false)
			}
		}
	})
})
