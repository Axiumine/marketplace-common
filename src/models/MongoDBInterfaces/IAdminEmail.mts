import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { Types } from 'mongoose'

/**
 * What the `admin` collection answers to the session projection `_id login.email deleted disabled`
 * — the shape the admin authorization service re-reads on every refresh, not the whole document.
 *
 * ⚠️ It used to be declared inline in `tokenInfoAdmin.mts` inside
 * `marketplace-dev-admin-authenticated-authorization`, and it declared **only** `_id` and
 * `login.email`. The projection has always asked for `deleted` and `disabled` too, and the reader
 * has always handed the result to `checkUserAuthorizationDisDel` — so the two fields the guard
 * exists to read were the two the type said were not there. That worked because the value flowing
 * through was mongoose's own lean type and the narrow interface was only applied on the way out; it
 * stops working the moment a shared reader is typed against this shape, which is why it is declared
 * here and why it extends `IAuthorizationDisDel` rather than restating the pair.
 *
 * The `ShopOwner` and `User` tiers have no equivalent because their readers return the full
 * `IShopOwnerModel` / `IUserModel`; only `admin` projects down to a shape with no interface of its
 * own.
 */
export interface IAdminEmail extends IAuthorizationDisDel {
	_id: Types.ObjectId
	login: {
		email: string
	}
}
