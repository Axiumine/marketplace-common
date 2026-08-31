import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'

/**
 * The two refusals, as codes a caller can branch on.
 *
 * They lead the thrown messages the way `KEYGRIP_ROTATE_CAP` does, and they are exported because the two
 * refusals are not the same answer: the admin service reports an unknown id as a 404 and a current key as a
 * 409, and matching on a prefix it spelled out itself would be a cross-repo string agreement no test on
 * this platform can span.
 */
export const KEYGRIP_RETIRE_CURRENT = 'KEYGRIP_RETIRE_CURRENT'
export const KEYGRIP_RETIRE_UNKNOWN = 'KEYGRIP_RETIRE_UNKNOWN'

/**
 * The key array with one named key removed (ADR-034).
 *
 * This is the operation for a *suspected compromise*, and it is the only one on this platform that drops a
 * key before its age says it may go. `rotateKeygripKeys` retires from the old end and only once
 * `SESSION_CAP_DAYS_REMEMBERED` has passed **since the key was demoted**, because nobody should be logged
 * out by routine maintenance;
 * here the admin is asking for the opposite trade deliberately, and every cookie the retired key signed
 * stops verifying the moment the last process picks the change up.
 *
 * ⚠️ **Retiring `keys[0]` is refused, and the refusal names rotation.** `Keygrip` signs with index 0, so
 * removing it without minting a replacement would leave the platform signing with a key an admin has
 * just declared untrustworthy — for one instant if they rotate next, forever if they do not. Rotation
 * already does both halves in one compare-and-set: it mints a fresh signer and pushes the suspect key down
 * the array, from where this operation can take it. The guard is on the *whole* operation rather than on a
 * prior read, so there is no window between the check and the removal.
 *
 * ⚠️ **An id nothing matches throws instead of answering the array unchanged.** A retire that silently
 * succeeds is the failure mode this story exists to stop: the admin reads a success and believes a
 * compromised key is gone, while every process still verifies with it. The same argument as the
 * `matchedCount === 0` refusal at `funShopOwnerUpdateStatus.mts:39`.
 *
 * There is no lower bound on the result. Two survivors is what a *rotation* leaves, because a rotation is
 * routine and a one-key array has no grace period left; a retire is an incident response, and refusing to
 * remove a compromised key because the array would get short answers the wrong question. A single-key array
 * still signs and verifies — `keys[0]` cannot be the one removed — and the next rotation restores the
 * grace period.
 */
export function retireKeygripKey(keys: readonly IKeygripKeyMaterial[], id: string): IKeygripKeyMaterial[] {
	if (keys[0]?.id === id)
		throw new Error(
			`${KEYGRIP_RETIRE_CURRENT}: ${id} is the key the platform is signing with and cannot be retired on its own. Rotate instead: that mints a fresh signer and moves this key down the array, and it can be retired from there.`
		)

	const next = keys.filter((key) => key.id !== id)

	if (next.length === keys.length)
		throw new Error(
			`${KEYGRIP_RETIRE_UNKNOWN}: no key in the current set is called ${id}. Nothing was retired — read the key set again before assuming this key is gone.`
		)

	return next
}
