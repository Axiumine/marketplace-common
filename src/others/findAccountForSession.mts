import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { checkUserAuthorizationDisDel } from '@others/checkUserAuthorizationDisDel.mjs'
import { Types } from 'mongoose'

/**
 * The one thing this helper needs a model to do, expressed structurally rather than as
 * `Model<TAccount>`.
 *
 * `Model<T>` is **invariant** in `T` — the three tiers' document types are unrelated, so a single
 * generic typed against it would take none of them without a cast at every call site. A structural
 * interface takes all three, because a method parameter is bivariant and the return position only
 * has to be assignable. `PromiseLike`, not `Promise`: mongoose hands back a `Query`, which is a
 * thenable with no `[Symbol.toStringTag]` and therefore not assignable to `Promise`.
 */
export interface ISessionAccountModel<TAccount> {
	findById(filter: { _id: Types.ObjectId }, projection: string): { lean(): PromiseLike<TAccount | null> }
}

/**
 * Re-reads the account behind a refresh session, so the access token about to be minted carries
 * current data rather than whatever was true at login.
 *
 * The three authorization services each had their own copy of this — `tokenInfoShopOwner`,
 * `tokenInfoAdmin`, `tokenInfoUser` — differing only in the model, the projection and the return
 * type. What was triplicated was not the query but the **order of the two guards**, and that order
 * is the whole security content: a missing document is refused before anything reads its fields,
 * and `checkUserAuthorizationDisDel` runs on *every* refresh rather than at login only, which is
 * what makes disabling an account take effect within one access-token lifetime instead of one
 * refresh-token lifetime.
 *
 * ⚠️ The projection stays at the call site, deliberately. It is the one part that genuinely differs
 * per tier — a shop owner's session carries onboarding fields a customer has no equivalent of — and
 * hoisting it here would either force the union of all three or invent a fourth shape none of them
 * wants. A caller asking for too few fields gets a type error at its own `TAccount`, which is where
 * the mistake is.
 */
export async function findAccountForSession<TAccount extends IAuthorizationDisDel>(
	model: ISessionAccountModel<TAccount>,
	_id: Types.ObjectId,
	projection: string
): Promise<TAccount> {
	const account = await model.findById({ _id: _id }, projection).lean()

	if (account === null) {
		throw throwUnauthorizedError()
	}
	checkUserAuthorizationDisDel(account)
	return account
}
