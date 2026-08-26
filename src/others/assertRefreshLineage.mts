import { throwRefreshTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwRefreshTokenExpiredOrDeleted'
import { IRefreshData } from '@others/IRefreshData.mjs'

/**
 * Whether a stored field is a non-negative integer written as a string.
 *
 * ⚠️ **The anchors and the `+` are the guard, not decoration.** `originalLogin` and `sessionCapDays` are
 * read back with `Number()` and compared, and `Number('')` is `0` while `Number('later')` is `NaN` — and
 * **every comparison against `NaN` is false**, so a malformed field would make the age check answer "not
 * expired" for ever. A session whose cap can never be reached is the one failure this whole story exists
 * to prevent, so the shape is refused here rather than defaulted downstream.
 *
 * ⚠️ **A missing field goes through the same regex as a malformed one**, via the template literal, rather
 * than through a `!== undefined` arm of its own. `${undefined}` is `'undefined'`, which the anchors refuse
 * like any other non-numeric string — so the two cases share one exit and there is no second branch that
 * could be made to disagree with the first.
 */
const isStoredInteger = (value: string | undefined) => /^\d+$/.test(`${value}`)

/**
 * Refuses a refresh session that does not carry its lineage (E14-S01).
 *
 * ⚠️ **A missing field is invalid, not a default.** Sessions minted before E14 landed carry none of these
 * three. Defaulting `familyId` would file every one of them into a single shared `family:undefined` set,
 * and the first reuse event anywhere on the platform would then revoke unrelated accounts across every
 * tier at once. Refusing structurally turns that into a one-time forced re-login for sessions older than
 * the deploy — loud, bounded, and something a user can act on.
 *
 * 498 rather than the 403 `assertTier` answers: the caller did nothing wrong and its session is simply
 * older than the fields. 498 is the status that tells a client to log in again, which is exactly the
 * correct move here — a 403 tells it the opposite, that trying again is pointless.
 */
export function assertRefreshLineage({
	familyId,
	originalLogin,
	sessionCapDays
}: Partial<Pick<IRefreshData, 'familyId' | 'originalLogin' | 'sessionCapDays'>>): void {
	if (!familyId || !isStoredInteger(originalLogin) || !isStoredInteger(sessionCapDays)) {
		throw throwRefreshTokenExpiredOrDeleted()
	}
}
