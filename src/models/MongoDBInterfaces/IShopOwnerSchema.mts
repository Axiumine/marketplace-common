import { IShopOwnerPersonalData } from '@MongoDBInterfaces/IShopOwnerPersonalData.mjs'
import { IEmailVerifySubDocSchema } from '@MongoDBInterfaces/sub/IEmailVerifySubDocSchema.mjs'
import { ILoginSubDocSchema } from '@MongoDBInterfaces/sub/ILoginSubDocSchema.mjs'
import { IResetPwdSubDocSchema } from '@MongoDBInterfaces/sub/IResetPwdSubDocSchema.mjs'
import { Types } from 'mongoose'

export interface IShopOwnerSchema {
	_id?: Types.ObjectId
	login: ILoginSubDocSchema
	/**
	 * **Optional**, like the customer's, and for the same reason since `shopOwnerRegister` shipped: a
	 * shop owner who signed themselves up has an address and a password and nothing else until they
	 * are approved and walked through onboarding. Admin-provisioned accounts still arrive complete.
	 *
	 * ⚠️ Every consumer that renders this block has to answer for its absence. `shopOwnersActiveTbl`
	 * is the one that already does — its GraphQL row makes the whole block nullable rather than each
	 * member, because a document has either declared all of it or none of it.
	 */
	personalData?: IShopOwnerPersonalData
	registeredAt: Date
	deleted?: Date
	/**
	 * Which admin closed this account — an `admin._id` — and **absent when the account holder closed
	 * it themselves**. That absence is the whole encoding: there is no actor *type* beside it, because a
	 * field naming which collection an id came from is a `role` field by the back door, and ADR-002 does
	 * not have one. ADR-044.
	 */
	deletedBy?: Types.ObjectId
	disabled?: boolean
	/**
	 * Which admin suspended this account — an `admin._id`, written with `disabled: true` and always
	 * present beside it. No self-service counterpart, unlike `deletedBy`: a person closes their own
	 * account, they never suspend it.
	 */
	disabledBy?: Types.ObjectId
	/**
	 * Why, in the admin's own words. **Mandatory whenever `disabled` is true**, which the collection
	 * validator enforces through `dependencies` — presence, without being able to read the value.
	 *
	 * ⚠️ **The 1000-character cap lives in the service and nowhere else.** The field is encrypted, so
	 * the validator sees a `binData` and `maxLength` does not apply to it. ADR-044 records the split;
	 * ADR-035 is its mirror image. Adding a `maxLength` to the validator refuses every write.
	 */
	disabledReason?: string
	/**
	 * When the retention sweeper overwrote this document's personal data with placeholders. ADR-041.
	 *
	 * ⚠️ **Its absence is the sweeper's own candidate filter**, so it stays in the clear: the sweep
	 * matches `{ deleted: { $lte: cutoff }, scrubbedAt: { $exists: false } }`, a server-side comparison
	 * that deterministic ciphertext cannot answer — deterministic supports equality only — and that
	 * random ciphertext cannot answer at all.
	 */
	scrubbedAt?: Date
	waitApprov?: boolean
	/**
	 * Free text an admin keeps about this account. **Admin-only.**
	 *
	 * Top level rather than inside `personalData`: it is not something the shopOwner declared about
	 * themselves, it is what the platform wrote about them. Nothing on the ShopOwner tier can read
	 * it — `marketplace-dev-authenticated-*` never loads this model at all — so keep it that way and do
	 * not add it to a selection on that side.
	 */
	notes?: string
	resetPwd?: IResetPwdSubDocSchema
	emailVerify?: IEmailVerifySubDocSchema
	__v?: number
}
