import { IRedisDataAdminCommon } from '@others/Redis/IRedisDataAdminCommon.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The access-token session hash for an admin, as it is written to and read from Redis — every
 * value a string, which is why `_id` is one here and an ObjectId in the `ForNode` variant.
 *
 * `tier` lives on the concrete Redis shapes rather than on `…Common` on purpose: it describes the
 * *session*, not the account, and it has no meaning once the request is inside the process. The
 * `ForNode` variant, which is what `ctx.state.user` holds, therefore does not carry it — by then the
 * tier has already been asserted at the boundary and re-checking it downstream would only invite
 * somebody to trust it instead of the middleware.
 */
export interface IRedisDataAdmin extends IRedisDataAdminCommon {
	_id: string
	tier: Tier
}
