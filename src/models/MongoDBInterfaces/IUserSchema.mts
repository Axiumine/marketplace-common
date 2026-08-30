import { IUserAddress } from '@MongoDBInterfaces/IUserAddress.mjs'
import { IUserPersonalData } from '@MongoDBInterfaces/IUserPersonalData.mjs'
import { IEmailVerifySubDocSchema } from '@MongoDBInterfaces/sub/IEmailVerifySubDocSchema.mjs'
import { ILoginSubDocSchema } from '@MongoDBInterfaces/sub/ILoginSubDocSchema.mjs'
import { IResetPwdSubDocSchema } from '@MongoDBInterfaces/sub/IResetPwdSubDocSchema.mjs'
import { Types } from 'mongoose'

/**
 * The end customer — the third and last thing you authenticate against.
 *
 * It mirrors `IShopOwnerSchema` because role on this platform is which collection you log in
 * against, not a field: same `login`, same `resetPwd`, same `emailVerify`, same `deleted` /
 * `disabled` gates. Four things differ, all deliberate, and `marketplace-db-setup`'s
 * `lib/schemas/user.js` argues each one at length:
 *
 * 1. `personalData` is **optional** — registration is email + password only.
 * 2. `addresses` is an **array**, where a shop owner has one `personalData.address`.
 * 3. `defaultAddress` has no counterpart at all.
 * 4. **No `waitApprov`** — customers self-serve. The only gate between registering and logging in is
 *    the email confirmation, which `loginUser` checks against `emailVerify.valid`.
 *
 * There is also no `notes`: that field is what an admin wrote about a shop owner, and this tier
 * has no admin-facing surface.
 */
export interface IUserSchema {
	_id?: Types.ObjectId
	login: ILoginSubDocSchema
	personalData?: IUserPersonalData
	addresses?: IUserAddress[]
	/**
	 * The `_id` of one element of `addresses`, or absent.
	 *
	 * ⚠️ **A pointer, not a boolean on each address**, and the difference is enforced by MongoDB
	 * rather than by anything in this package. The `user` collection validator is
	 * `$and: [ {$jsonSchema}, {$expr} ]`, and the second clause refuses any document whose
	 * `defaultAddress` is neither missing nor present in `addresses[]._id`. Two consequences for
	 * every caller:
	 *
	 * - Setting the default is a single atomic `$set`. There is no "clear the others first" step,
	 *   so no window in which zero or two addresses are default.
	 * - **Removing the default address must `$unset` this field in the same update.** A `$pull` on
	 *   its own leaves the pointer dangling and the write is rejected by the database — which is the
	 *   point, but it is a rejection you will meet at runtime if the two halves are split.
	 *
	 * "Is this address the default?" is therefore a comparison against a sibling field rather than a
	 * local boolean read, and an API that wants to expose a boolean derives it.
	 */
	defaultAddress?: Types.ObjectId
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
	resetPwd?: IResetPwdSubDocSchema
	emailVerify?: IEmailVerifySubDocSchema
	__v?: number
}
