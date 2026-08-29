import { TIER } from '@others/Tier.mjs'

/**
 * The host every scrubbed address is moved to.
 *
 * `.invalid` is reserved by RFC 2606 precisely so that a name under it can never resolve and can never
 * be registered by anybody, so a scrubbed account cannot be mailed by accident and the address cannot
 * one day belong to a real person. The sub-label keeps it out of the way of `example.invalid` and of
 * anything a test fixture might reach for.
 */
export const SCRUBBED_EMAIL_HOST = 'invalid.local'

/**
 * The address a closed account carries once its personal data has been overwritten.
 *
 * ⚠️ **The account id is in it, and that is what makes it unique.** `login.email_unique` has no
 * `partialFilterExpression` and no `sparse` (ADR-011), so every document in the collection competes for
 * one key space — scrubbing two accounts to one constant address would make the second write fail on
 * the index, which on the confirm path means a registration refused because somebody *else* closed
 * their account. An `ObjectId` is already unique and is not personal data on its own.
 *
 * It is also what frees the address the person registered with, which is the whole point of the
 * overwrite: the value moves, the row stays (ADR-041).
 */
export const scrubbedEmail = (accountId: string): string => `deleted-${accountId}@${SCRUBBED_EMAIL_HOST}`

/**
 * What `login.password` becomes.
 *
 * ⚠️ **A real bcrypt hash of a random 48-byte secret that was never written down**, not a made-up
 * 60-character string. Two reasons it has to be genuine. The collection validator demands exactly 60
 * characters and nothing more, so a malformed value would install happily — and `@node-rs/bcrypt`'s
 * `verify` throws on a hash it cannot parse, which would turn a login attempt against a scrubbed
 * account into a 500 instead of a refusal. Every scrubbed account shares this one value, which gives
 * away nothing: knowing that two accounts have no usable password is not knowing a password.
 *
 * A hash computed per account was the alternative and was rejected on cost: bcrypt at 14 rounds is
 * over a second of CPU each, and the retention sweep runs over a whole day's closures at once.
 */
export const SCRUBBED_PASSWORD_HASH = '$2y$14$pWWeKVbn6Buoc3.DB8KXguj1FxmxODlbbLT8g0dNNVI1dG6nHzGG2'

/** The given name every scrubbed account carries — with `SCRUBBED_LAST_NAME`, it reads "Deleted User". */
export const SCRUBBED_FIRST_NAME = 'Deleted'

/** The family name every scrubbed account carries. */
export const SCRUBBED_LAST_NAME = 'User'

/**
 * The filler for every other required string.
 *
 * One word rather than a dash or an empty string: an operator reading a scrubbed record in the admin
 * table has to be able to tell "this was erased" from "this was never filled in", and a blank cell says
 * the second.
 */
export const SCRUBBED_TEXT = 'Deleted'

/** The postal code a scrubbed address carries — five characters, the shape the clear-text rule wants. */
export const SCRUBBED_POSTAL_CODE = '00000'

/** The province a scrubbed address carries — two characters, the shape the clear-text rule wants. */
export const SCRUBBED_PROVINCE = 'XX'

/**
 * The date of birth a scrubbed account carries.
 *
 * A function rather than a constant, because a shared `Date` is mutable and one caller normalising it
 * in place would rewrite every future scrub. The epoch is not a plausible birth date, which is the
 * point: nothing downstream should mistake it for one.
 */
export const scrubbedBirthDate = (): Date => new Date(0)

/**
 * The two collections that can be scrubbed.
 *
 * ⚠️ **`admin` is deliberately not one of them.** Operators are seeded, never publicly registered, and
 * nobody has decided who may close an operator's account or what happens to one — the same reason
 * `20260829000000` gives none of the four lifecycle paths to that collection.
 */
export type ScrubbableTier = typeof TIER.user | typeof TIER.shopOwner

/** The update a scrub is: values overwritten, and paths removed outright. */
export interface IAccountScrub {
	$set: Record<string, unknown>
	$unset: Record<string, ''>
}

/**
 * The members of `login` that describe the person's use of the account rather than the credential.
 *
 * `email` and `password` are absent because they are `required` and are overwritten instead — the two
 * halves of this routine, and the reason it is a `$set` **and** a `$unset` rather than either alone.
 */
const LOGIN_ACTIVITY = [
	'login.firstLogin',
	'login.lastLogin',
	'login.rememberMe',
	'login.onboardingStep',
	'login.onboardingDone'
]

/**
 * What both collections drop whole.
 *
 * `emailVerify` goes with everything in it, `newEmailTmp` included — an address the person was moving
 * to is as personal as the one they arrived with. `resetPwd` is a live credential-reset token and has
 * no business outliving the account. `disabledReason` is free text an operator wrote *about* a named
 * person, which is the single highest-risk field either collection carries; keeping it beside a record
 * whose every other personal value has just been overwritten would defeat the exercise.
 *
 * ⚠️ **`deleted`, `deletedBy`, `disabled`, `disabledBy` and `registeredAt` are NOT here and must not
 * be.** They are the record that a person held an account, which is the thing ADR-041 keeps for ever;
 * `deletedBy` in particular is meaningful by its *absence* (the holder closed it themselves), so a
 * routine that removed it would rewrite history rather than erase data.
 */
const SHARED_UNSET = [...LOGIN_ACTIVITY, 'emailVerify', 'resetPwd', 'disabledReason']

/** `user` alone: the address book, and the pointer into it the `$expr` clause validates. */
const USER_UNSET = [...SHARED_UNSET, 'addresses', 'defaultAddress']

/** `shopOwner` alone: `notes` is the operator's file on this person, and goes for `disabledReason`'s reason. */
const SHOP_OWNER_UNSET = [...SHARED_UNSET, 'notes']

const unsetMap = (paths: readonly string[]): Record<string, ''> => Object.fromEntries(paths.map((path) => [path, '']))

/**
 * `user.personalData` after a scrub — the block's own `required` list is `firstName` and `lastName`, and
 * writing exactly those two removes the date of birth and the contacts by replacing the object that
 * held them.
 */
const scrubbedPersonalDataUser = () => ({
	firstName: SCRUBBED_FIRST_NAME,
	lastName: SCRUBBED_LAST_NAME
})

/**
 * `shopOwner.personalData` after a scrub.
 *
 * ⚠️ **Every member is spelled out because this block is all-or-nothing**: its `required` list names all
 * five, and `address`'s names four of its own, so the two-field shape the customer gets would be a
 * document the validator refuses. That asymmetry is a fact about the two collections rather than a
 * choice made here — `lib/schemas/shopOwner.js` records why.
 */
const scrubbedPersonalDataShopOwner = (accountId: string) => ({
	firstName: SCRUBBED_FIRST_NAME,
	lastName: SCRUBBED_LAST_NAME,
	birth: { date: scrubbedBirthDate() },
	address: {
		street: SCRUBBED_TEXT,
		postalCode: SCRUBBED_POSTAL_CODE,
		city: SCRUBBED_TEXT,
		province: SCRUBBED_PROVINCE
	},
	contacts: {
		mobile: SCRUBBED_TEXT,
		email: scrubbedEmail(accountId)
	}
})

/**
 * Builds the retention scrub for one closed account: the update that overwrites every personal value it
 * holds and removes the rest, leaving the document standing (ADR-041).
 *
 * **Overwrite, not delete, and not `$unset` alone.** The platform owner's decision of 2026-08-29 is that
 * a closed account keeps its document for ever as the record that a person held one — so `registeredAt`,
 * `deleted`, and the two actor stamps survive a scrub untouched, and what goes is the data that says
 * *who* they were. `login.email` is the load-bearing case: it is `required`, it carries a unique index
 * with no partial filter, and moving its value to `deleted-<id>@invalid.local` is what releases the
 * address for a fresh registration without removing anything.
 *
 * ⚠️ **The values handed back are plaintext, and they must reach MongoDB through Mongoose.**
 * `fieldEncryptionPlugin` encrypts `$set` operands on the way past — including a whole-object `$set` on
 * `personalData`, which `encryptUpdate` walks field by field. A caller that reaches for
 * `Model.collection.updateOne` to skip a hook would write readable personal data into `binData` paths
 * and be refused by the collection validator, at best.
 *
 * ⚠️ **`scrubbedAt` is set here and nowhere else**, because it is the sweep's own candidate filter
 * (`{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`). A path that scrubs without stamping
 * it would be re-scrubbed for ever; one that stamps without scrubbing hides an account from the sweep
 * that still holds everything.
 *
 * There are two callers by design and they are the same operation at two different times: the retention
 * sweep at day 30, and the registration confirm that reclaims the address earlier because somebody
 * proved they can read mail at it (ADR-042). Neither may have its own copy of this list — a field added
 * to one collection and forgotten in one of two hand-written scrubs is data that silently survives.
 */
export function buildAccountScrub(tier: ScrubbableTier, accountId: string, at: Date): IAccountScrub {
	const isUser = tier === TIER.user

	return {
		$set: {
			'login.email': scrubbedEmail(accountId),
			'login.password': SCRUBBED_PASSWORD_HASH,
			personalData: isUser ? scrubbedPersonalDataUser() : scrubbedPersonalDataShopOwner(accountId),
			scrubbedAt: at
		},
		$unset: unsetMap(isUser ? USER_UNSET : SHOP_OWNER_UNSET)
	}
}
