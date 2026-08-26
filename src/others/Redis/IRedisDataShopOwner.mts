import { IRedisDataShopOwnerCommon } from '@others/Redis/IRedisDataShopOwnerCommon.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The access-token session hash for a shop owner, as it is written to and read from Redis — every
 * value a string, which is why `_id` is one here and an ObjectId in the `ForNode` variant.
 *
 * See `IRedisDataAdmin` for why `tier` sits on this shape and not on `…Common`.
 */
export interface IRedisDataShopOwner extends IRedisDataShopOwnerCommon {
	_id: string
	tier: Tier
}
