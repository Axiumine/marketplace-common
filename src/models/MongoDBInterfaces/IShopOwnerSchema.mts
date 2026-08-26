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
	disabled?: boolean
	waitApprov?: boolean
	/**
	 * Free text an operator keeps about this account. **Operator-only.**
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
