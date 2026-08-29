import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER } from '@encryption/encryptedFields.mjs'
import { fieldEncryptionPlugin } from '@encryption/fieldEncryptionPlugin.mjs'
import { BaseAddressSchema } from '@MongoDB/sub/BaseAddressSchema.mjs'
import { EmailVerifySubDocSchema } from '@MongoDB/sub/EmailVerifySubDocSchema.mjs'
import { LoginSubDocSchema } from '@MongoDB/sub/LoginSubDocSchema.mjs'
import { ResetPwdSubDocSchema } from '@MongoDB/sub/ResetPwdSubDocSchema.mjs'
import { IShopOwnerModel } from '@MongoDBInterfaces/IShopOwnerModel.mjs'
import { IShopOwnerPersonalData } from '@MongoDBInterfaces/IShopOwnerPersonalData.mjs'
import bcrypt from '@node-rs/bcrypt'
import { SALT_ROUNDS } from '@others/Constants.mjs'
import { model, Schema, SchemaDefinition } from 'mongoose'

/*
 * `birth` and `contacts` are real sub-schemas rather than inline `type: { _id: false, … }` objects
 * like `personalData` above them. Both spellings turn off the _id; this one keeps it where it belongs,
 * as a Schema option, so the data interface does not have to carry a phantom `_id?: boolean` field
 * just to make the inline form type-check (which is the only reason IShopOwnerPersonalData has one).
 *
 * Turning it off is not cosmetic. The collection validator declares both sub-objects with
 * `additionalProperties: false`, so the _id Mongoose adds by default is on its own enough to make
 * every write of them fail.
 */
const BirthSubDocSchema = new Schema<IShopOwnerPersonalData['birth']>(
	{
		date: encryptedPath({ plaintext: 'date', required: true })
	},
	{ _id: false }
)

const ContactsShopOwnerSubDocSchema = new Schema<IShopOwnerPersonalData['contacts']>(
	{
		mobile: encryptedPath({ plaintext: 'string', required: true }),
		// The one optional contact — the validator requires only `mobile` and `email`.
		landline: encryptedPath({ plaintext: 'string' }),
		// ⚠️ Not the credential. `login.email` is what this person logs in with and is deterministic
		// because a login matches on it; this is a second address to be reached on, nothing queries
		// it, and it is random.
		email: encryptedPath({ plaintext: 'string', required: true })
	},
	{ _id: false }
)

const ShopOwnerSchema: Schema<IShopOwnerModel> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		login: {
			type: LoginSubDocSchema,
			required: true
		},
		// Mirrors the `shopOwner` collection validator field for field. It did not, and the
		// divergence was silent: `birth` was spelled `date` here and `data` everywhere else
		// (validator, GraphQL type, seed migration), `contacts` was missing outright, and the two
		// inline sub-objects picked up the implicit `_id` Mongoose adds by default. Every one of
		// those breaks a write under the validator's `additionalProperties: false` — a cast through
		// this model dropped `contacts` and rewrote `birth` to a bare `{ _id }`, so the document
		// Mongo saw no longer resembled the one that was handed in. Keep the two in step: the
		// validator is the source of truth, migrations are immutable, and this is the copy that moves.
		personalData: {
			type: {
				_id: false,
				// ⚠️ **`firstName`, `lastName` and `address.city` below are the three personal fields
				// on this platform that stay in the clear, and it is a decision rather than an
				// omission.** `shopOwnersActiveTbl` sorts on all three — `tbl_active_firstName`,
				// `tbl_active_lastName_firstName`, `tbl_active_city` — and prefix-searches them with
				// `/^term/i`. No CSFLE algorithm answers a sort or a regex, so encrypting them would
				// not slow the operator table down, it would falsify it: the rows would still render,
				// ordered by ciphertext, and every search would return nothing. ADR-029 records the
				// trade and what would have to change to reverse it. The same two names on `user` and
				// `admin` ARE encrypted, because nothing sorts those.
				firstName: {
					type: String,
					required: true
				},
				lastName: {
					type: String,
					required: true
				},
				birth: {
					type: BirthSubDocSchema,
					required: true
				},
				// `.clone()`, never the shared schema itself: `BaseAddressSchema` is the address of
				// several other things too, and `.add()` mutates in place — adding the point here
				// without cloning would put it on every one of them.
				//
				// The point is **not** required, unlike the company's. Every shopOwner in
				// the collection predates the field, and a required path here would make each of
				// them unsaveable through this model until someone re-picked their address from the
				// autocomplete — an operator fixing a phone number would be stopped by the address.
				//
				// The clone also re-declares three of the four inherited paths as encrypted.
				// `BaseAddressSchema` itself must stay a plain-string schema: `company` spreads
				// the same one, and a company's registered seat is a public storefront address
				// indexed by `published_city_publicName` and `address.position_2dsphere`.
				// `city` is re-declared by *not* being listed — it is the `tbl_active_city` sort
				// key, see the block above `firstName`.
				address: {
					type: BaseAddressSchema.clone().add({
						street: encryptedPath({ plaintext: 'string', required: true }),
						postalCode: encryptedPath({ plaintext: 'string', required: true }),
						province: encryptedPath({ plaintext: 'string', required: true }),
						// A flat encrypted path rather than the nested GeoJSON schema it used to
						// be. The value is encrypted whole — random, because deterministic is
						// undefined for `object` — so a sub-schema underneath it would have
						// nothing left to cast: what reaches the path on the way out is a
						// `binData`, and what comes back on the way in is the object again.
						// The point's shape is still checked, by `validateShopOwnerPersonalData`
						// in the admin resource service, which builds `type` itself and validates
						// both coordinates before this model ever sees them.
						position: encryptedPath({ plaintext: 'object' })
					} as SchemaDefinition),
					required: true
				},
				contacts: {
					type: ContactsShopOwnerSubDocSchema,
					required: true
				}
			}
			// ⚠️ **Not `required`, since 2026-08-12, and the collection validator agrees** — see the
			// `required` list in `marketplace-db-setup/lib/schemas/shopOwner.js`. `shopOwnerRegister`
			// creates a shop owner from an address and a password, exactly as `userRegister` creates a
			// customer, and everything here arrives later through onboarding. A required path would
			// make that document unsaveable through this model, which is the failure mode this comment
			// exists to prevent someone re-introducing.
			//
			// Every path *inside* the block stays required, so the block is all-or-nothing: a shop
			// owner has either declared who they are or has not, never half of it.
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
		// Encrypted like `notes` below, and for the same reason: it is what the platform wrote about a
		// person, rather than what that person declared about themselves.
		disabledReason: encryptedPath({ plaintext: 'string' }),
		waitApprov: {
			type: Boolean
		},
		// When the retention sweeper overwrote this document's personal data with placeholders.
		//
		// ⚠️ **Its absence is the sweeper's candidate filter**, which is why it stays in the clear: the
		// sweep matches `{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`, a server-side
		// comparison. Deterministic ciphertext answers equality and nothing else — never `$lte` — and
		// random ciphertext answers nothing at all.
		scrubbedAt: {
			type: Date
		},
		// What an operator wrote about this account, not what the account declared about itself —
		// which is why it sits here and not in `personalData`. Only the Admin tier ever selects it;
		// the ShopOwner-tier services do not load this model at all.
		// Encrypted, and the one encrypted field here the subject never sees — the ShopOwner tier does
		// not load this model at all.
		notes: encryptedPath({ plaintext: 'string' }),
		resetPwd: ResetPwdSubDocSchema,
		// Kept strictly disjoint from `resetPwd`. koa-utils documents why on `IResetPwdPaths`: while
		// the activation token and the password-reset token shared one slot, a hash issued by either
		// flow authenticated the other, and an unauthenticated reset request killed pending
		// activation links.
		emailVerify: EmailVerifySubDocSchema,
		__v: {
			type: Number
		}
	},
	{
		collection: 'shopOwner'
	}
)

ShopOwnerSchema.plugin(fieldEncryptionPlugin, {
	fields: ENCRYPTED_FIELDS_SHOP_OWNER,
	keyAltName: KEY_ALT_NAME_SHOP_OWNER
})

ShopOwnerSchema.methods.generateHashPassword = async function (password: string) {
	return await bcrypt.hash(password, SALT_ROUNDS)
}

const ShopOwner = model<IShopOwnerModel>('ShopOwner', ShopOwnerSchema)
export { ShopOwner }
