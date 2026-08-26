import { IRedisDataUserCommon } from '@others/Redis/IRedisDataUserCommon.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The access-token session hash for a customer, as it is written to and read from Redis — every
 * value a string, which is why `_id` is one here and an ObjectId in the `ForNode` variant.
 *
 * See `IRedisDataAdmin` for why `tier` sits on this shape and not on `…Common`.
 */
export interface IRedisDataUser extends IRedisDataUserCommon {
	_id: string
	tier: Tier
}
