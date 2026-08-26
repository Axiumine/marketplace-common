import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'

/**
 * The only part of a `shopOwner` this gate looks at. Declared here rather than taking
 * `IShopOwnerSchema` for the reason `IShopOwnerApprovalGated` gives next door: the caller passes its
 * own narrow projection result and grows no field it has no other use for.
 */
export interface IShopOwnerEmailVerifyGated {
	emailVerify?: { valid?: boolean }
}

/**
 * Refuses a shop owner whose email verification was started and never finished.
 *
 * `shopOwnerRegister` (4027) lets a stranger create a `shopOwner` from an address and a password, so
 * from that mutation onwards the platform holds accounts whose address nobody has proved they can
 * read. An activation link that gates nothing is the same bug `waitApprov` was — a control that
 * exists, is displayed, and refuses no request — so the link gates the login, exactly as it does for
 * the customer in `tryLoginUser`.
 *
 * ⚠️ **`=== false`, not `!== true`, and the difference is the whole design of this function.** The
 * three states are distinct and only two of them are a failure:
 *
 * | `emailVerify` | means | this gate |
 * |---|---|---|
 * | absent | Admin-provisioned by `shopOwnerAdd`, no verification was ever asked for | passes |
 * | `valid: false` | a self-registration whose link has not been opened | **refuses** |
 * | `valid: true` | the link was opened | passes |
 *
 * `!== true` would collapse the first row into the second and lock out every shop owner created
 * before this shipped — none of them has an `emailVerify` block at all, because nothing ever wrote
 * one. There is no backfill that would fix that either: marking them verified would be a lie about
 * addresses nobody has confirmed, and marking them unverified would lock out live accounts. Absent
 * genuinely means "not applicable", and it has to keep meaning that.
 *
 * ⚠️ Call it **after** the password check, like every other account-state gate on that path. Ordering
 * it before turns it into an oracle for which addresses have a pending registration. The error is the
 * generic `throwUnauthorizedError`, so even a caller holding the password learns nothing — which is
 * why the frontend's login screen has to offer a resend unconditionally rather than on this failure.
 *
 * @param shopOwner the projection result, which must have asked for `emailVerify.valid`
 */
export function checkShopOwnerEmailVerified(shopOwner: IShopOwnerEmailVerifyGated) {
	if (shopOwner.emailVerify?.valid === false) {
		throw throwUnauthorizedError() // fixme email: 'Confirm your email address first.'
	}
}
