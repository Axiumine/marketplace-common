import { randomUUID } from 'node:crypto'

import { IRefreshData } from '@others/IRefreshData.mjs'
import { resolveSessionCapDays } from '@others/sessionLifetime.mjs'

/**
 * The lineage a login stamps on the session it is about to mint (E14-S01, E14-S07) — the three fields
 * every later rotation carries forward unchanged and every later refresh is checked against.
 *
 * One helper rather than three copies, because the three tier writers in
 * `marketplace-dev-public-authorization` differ only in which `IRedisData…` they were handed: a lineage
 * stamped differently in one of them would be a session capped differently from the other two, and
 * nothing downstream could tell.
 *
 * - **`familyId` is a fresh `randomUUID()` per login**, and never derived from either token. It is an
 *   opaque identifier, not a credential — presenting one grants nothing — which is exactly what lets a
 *   tombstone name it in the clear. Deriving it from a token would put a token back into a key name that
 *   is not a digest, undoing E13-S01 through the side door.
 * - **`originalLogin` is stamped once, here, and no rotation ever moves it.** That is the whole
 *   difference between an absolute cap and a long idle timeout: a session that could restamp it would
 *   live for ever one refresh at a time.
 * - **`sessionCapDays` is resolved once, at login, from the checkbox** — see `resolveSessionCapDays` for
 *   why only the boolean `true` buys the long one. It is fixed for the life of the session: the stored
 *   `login.rememberMe` preference an Admin can toggle later is a login-form default and touches no live
 *   session.
 *
 * ⚠️ **Every value is a string, because every Redis hash value is.** Numbers written here come back out
 * of `hGetAll` as strings whatever they went in as, and `assertRefreshLineage` refuses anything that is
 * not a non-negative integer written as one.
 */
export const newSessionLineage = (rememberMe: unknown): Pick<IRefreshData, 'familyId' | 'originalLogin' | 'sessionCapDays'> => ({
	familyId: randomUUID(),
	originalLogin: `${Date.now()}`,
	sessionCapDays: `${resolveSessionCapDays(rememberMe)}`
})
