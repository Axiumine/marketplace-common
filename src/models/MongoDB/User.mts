import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { ENCRYPTED_FIELDS_USER, KEY_ALT_NAME_USER } from '@encryption/encryptedFields.mjs'
import { fieldEncryptionPlugin } from '@encryption/fieldEncryptionPlugin.mjs'
import { BaseAddressSchema } from '@MongoDB/sub/BaseAddressSchema.mjs'
import { EmailVerifySubDocSchema } from '@MongoDB/sub/EmailVerifySubDocSchema.mjs'
import { LoginSubDocSchema } from '@MongoDB/sub/LoginSubDocSchema.mjs'
import { ResetPwdSubDocSchema } from '@MongoDB/sub/ResetPwdSubDocSchema.mjs'
import { IUserModel } from '@MongoDBInterfaces/IUserModel.mjs'
import { IUserPersonalData } from '@MongoDBInterfaces/IUserPersonalData.mjs'
import bcrypt from '@node-rs/bcrypt'
import { SALT_ROUNDS } from '@others/Constants.mjs'
import { model, Schema, SchemaDefinition } from 'mongoose'

/*
 * The same shape as `ShopOwner.mts`'s `BirthSubDocSchema`, deliberately not shared with it.
 *
 * They are identical today because the two collection validators are identical on this sub-object,
 * and that is the only thing holding them together — `user` and `shopOwner` are separate documents
 * in separate migrations and either may move without the other. Sharing one schema across two
 * validators means a change made for one collection silently rewrites how the other is cast, which
 * is exactly the failure `ShopOwner.mts` records above its own `personalData` block. The address is
 * shared (`BaseAddressSchema`) because a street address genuinely is one concept with one widget in
 * front of it; a date of birth is four lines.
 *
 * `{ _id: false }` for the reason every sub-schema here has it: the validator declares this object
 * `additionalProperties: false`, so the `_id` Mongoose adds by default is on its own enough to make
 * every write fail.
 */
const BirthSubDocSchema = new Schema<NonNullable<IUserPersonalData['birth']>>(
	{
		date: encryptedPath({ plaintext: 'date', required: true })
	},
	{ _id: false }
)

/*
 * ⚠️ Nothing in `contacts` is required, and that is the divergence from
 * `ContactsShopOwnerSubDocSchema`, which requires `mobile` and `email`.
 *
 * The customer's account address is `login.email` and is their credential. This `email` is a
 * *second* address to be reached on, so requiring it would be asking them to retype what they
 * already gave at registration — and requiring `mobile` would put a phone number in the way of an
 * account that only ever needs an inbox.
 */
const ContactsUserSubDocSchema = new Schema<NonNullable<IUserPersonalData['contacts']>>(
	{
		mobile: encryptedPath({ plaintext: 'string' }),
		landline: encryptedPath({ plaintext: 'string' }),
		// Random, unlike `login.email` two blocks down, and for the reason the paragraph above gives:
		// this is a second address to be reached on, not the credential, and nothing looks an account
		// up by it.
		email: encryptedPath({ plaintext: 'string' })
	},
	{ _id: false }
)

/*
 * One element of `addresses`.
 *
 * ⚠️ **This is the one address schema in the package that keeps its `_id`.** Every other one is
 * `{ _id: false }`, because they are embedded single objects under an `additionalProperties: false`
 * validator that never declared an `_id`. This one is an array element that `defaultAddress` names
 * by id, so the `user` validator lists `_id` in the element's `required` and a missing one is
 * refused. `BaseAddressSchema` is `{ _id: false }` and `.clone()` carries that option across, so the
 * path is declared here by hand with `auto: true` — which is what Mongoose would have added itself
 * had the option not been off.
 *
 * `.clone()` and never the shared schema itself: `BaseAddressSchema` is also the shop owner's
 * address and the company's, and `.add()` mutates in place — adding these three paths without
 * cloning would put a `label` and an `_id` on both of them.
 *
 * `position` is optional, as on the shop owner: the point arrives when the address is picked from
 * the geocoder's autocomplete, and one typed by hand has no map until it is re-picked.
 */
const UserAddressSubDocSchema = BaseAddressSchema.clone().add({
	// ⚠️ In the clear, and it must be. The `user` validator is `$and: [ {$jsonSchema}, {$expr} ]` and
	// the `$expr` half `$map`s this `_id` over every element and checks `defaultAddress` is one of
	// them. Encrypt either side of that comparison and the validator becomes unsatisfiable — every
	// write to the collection is refused, not just the ones that set a default. A server-minted
	// ObjectId is not personal data on its own, so nothing is given up.
	_id: {
		type: Schema.Types.ObjectId,
		auto: true
	},
	// Everything else in the element is encrypted, `city` included — unlike the shop owner's address,
	// nothing sorts or searches a customer's, and a customer reads their own document by `_id`.
	label: encryptedPath({ plaintext: 'string' }),
	street: encryptedPath({ plaintext: 'string', required: true }),
	postalCode: encryptedPath({ plaintext: 'string', required: true }),
	city: encryptedPath({ plaintext: 'string', required: true }),
	province: encryptedPath({ plaintext: 'string', required: true }),
	// Encrypted whole and therefore flat, as on the shop owner: random is the only algorithm defined
	// for an object, and a sub-schema under a path that holds a `binData` has nothing to cast.
	// `validateUserAddress` in the user resource service is what still checks the point's shape — it
	// builds `type` itself and validates both coordinates.
	position: encryptedPath({ plaintext: 'object' })
} as SchemaDefinition)

const UserSchema: Schema<IUserModel> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		login: {
			type: LoginSubDocSchema,
			required: true
		},
		// Not required, unlike the shop owner's. Registration on this tier is an email and a
		// password; the name and contacts are filled in after the address is confirmed, and an
		// account that never fills them in still works. Keep this in step with the `user` collection
		// validator field for field — the validator is the source of truth, migrations are immutable,
		// and this is the copy that moves.
		personalData: {
			type: {
				_id: false,
				// Encrypted, unlike the shop owner's two — there is no operator table over this
				// collection, so nothing sorts or prefix-searches a customer's name.
				firstName: encryptedPath({ plaintext: 'string', required: true }),
				lastName: encryptedPath({ plaintext: 'string', required: true }),
				birth: {
					type: BirthSubDocSchema
				},
				contacts: {
					type: ContactsUserSubDocSchema
				}
			}
		},
		addresses: {
			type: [UserAddressSubDocSchema]
		},
		// ⚠️ The `_id` of one element of `addresses`, and the database enforces that — the `user`
		// validator is `$and: [ {$jsonSchema}, {$expr} ]` and the second clause refuses a pointer
		// that names nothing. Two things follow for every write path: setting the default is a
		// single atomic `$set` with no "clear the others first" step, and removing the default
		// address must `$unset` this in the *same* update or Mongo rejects the write.
		//
		// Deliberately not a `default: true` boolean on each element: that shape can represent two
		// defaults, so "at most one" would be a rule somebody has to remember rather than something
		// the document cannot say.
		defaultAddress: {
			type: Schema.Types.ObjectId
		},
		registeredAt: {
			type: Date,
			required: true
		},
		deleted: {
			type: Date
		},
		// Which operator closed this account — an `admin._id`, and **absent when the account holder
		// closed it themselves**. That absence is the whole encoding: no actor *type* sits beside it,
		// because a field naming which collection an id came from is a `role` field by the back door and
		// ADR-002 does not have one. In the clear: an id the server minted is not personal data.
		deletedBy: {
			type: Schema.Types.ObjectId
		},
		disabled: {
			type: Boolean
		},
		// Which operator suspended this account — an `admin._id`, written with `disabled: true` and
		// always present beside it. No self-service counterpart, unlike `deletedBy`: a person closes
		// their own account, they never suspend it.
		disabledBy: {
			type: Schema.Types.ObjectId
		},
		// Why, in the operator's own words. **Mandatory whenever `disabled` is true** — enforced by the
		// collection validator's `dependencies`, which can require the path's *presence* without being
		// able to read what is in it.
		//
		// ⚠️ **The 1000-character cap is not here and cannot be.** The field is encrypted, so the
		// validator sees a `binData` and `maxLength` does not apply. The length is enforced in the
		// service that writes it and nowhere else — ADR-044 records the split, ADR-035 is its mirror
		// image, and a `maxLength` added to the validator refuses every write instead of long ones.
		//
		// Encrypted, and the one field on this model the subject never sees: it is what the platform
		// wrote about a customer, not what the customer declared about themselves.
		disabledReason: encryptedPath({ plaintext: 'string' }),
		// When the retention sweeper overwrote this document's personal data with placeholders.
		//
		// ⚠️ **Its absence is the sweeper's candidate filter**, which is why it stays in the clear: the
		// sweep matches `{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`, a server-side
		// comparison. Deterministic ciphertext answers equality and nothing else — never `$lte` — and
		// random ciphertext answers nothing at all.
		scrubbedAt: {
			type: Date
		},
		// No `waitApprov`: a shop owner waits for an operator to approve the account, a customer
		// self-serves. The only gate between registering and logging in is `emailVerify.valid`,
		// which `loginUser` checks.
		resetPwd: ResetPwdSubDocSchema,
		// Kept strictly disjoint from `resetPwd`, as on the other two models. koa-utils documents why
		// on `IResetPwdPaths`: while the activation token and the password-reset token shared one
		// slot, a hash issued by either flow authenticated the other, and an unauthenticated reset
		// request killed pending activation links.
		emailVerify: EmailVerifySubDocSchema,
		__v: {
			type: Number
		}
	},
	{
		collection: 'user'
	}
)

UserSchema.plugin(fieldEncryptionPlugin, { fields: ENCRYPTED_FIELDS_USER, keyAltName: KEY_ALT_NAME_USER })

UserSchema.methods.generateHashPassword = async function (password: string) {
	return await bcrypt.hash(password, SALT_ROUNDS)
}

const User = model<IUserModel>('User', UserSchema)
export { User }
