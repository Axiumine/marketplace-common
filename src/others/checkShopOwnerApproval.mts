import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'

/**
 * The only part of a `shopOwner` this gate looks at. Declared here rather than taking
 * `IShopOwnerSchema`, so the two callers can pass their own narrow projection result — a login check
 * shape and a session shape — without either growing a field it has no other use for.
 */
export interface IShopOwnerApprovalGated {
	waitApprov?: boolean
}

/**
 * BC-03's manual-approval gate, enforced. `waitApprov` is raised by an operator to park an account
 * pending review; while it is up, the account has no way into the platform.
 *
 * Both BC-01 services call this: `tryLoginShopOwner` (4028) so a parked account cannot start a
 * session, and `tokenInfoShopOwner` (4029) so parking an account ends the session it already holds
 * within one access-token lifetime instead of one refresh-token lifetime. Refusing at login only
 * would leave a shop owner working for the rest of a refresh-token lifetime after an operator parked
 * them, which is exactly the gap `findAccountForSession` documents for `disabled`/`deleted` and
 * solves the same way.
 *
 * ⚠️ **Order matters at the login call site: this runs *after* the password check.** The error is the
 * generic `throwUnauthorizedError` every other failure on that path returns, but running the gate
 * before the password was verified would still turn a timing difference into an oracle for which
 * addresses belong to parked accounts. `tryLoginUser` places its email-verification gate after the
 * password check for the same reason, and says so.
 *
 * ⚠️ **The flag is truthy-or-absent, never `false`.** `funShopOwnerUpdateStatus` `$unset`s it rather
 * than writing `false`, precisely so the operator queue can be `{ waitApprov: { $exists: true } }`.
 * `if (waitApprov)` is therefore the whole check — an approved account has no such key at all.
 *
 * @param shopOwner the projection result, which must have asked for `waitApprov`
 */
export function checkShopOwnerApproval(shopOwner: IShopOwnerApprovalGated) {
	if (shopOwner.waitApprov) {
		// Same reasoning as the deleted/disabled branches in `checkUserAuthorizationDisDel`: no message
		// that would tell a caller which accounts exist and are awaiting approval.
		throw throwUnauthorizedError() // fixme email: 'Account awaiting approval.'
	}
}
