import { IRedisDataShopOwnerCommon } from '@others/Redis/IRedisDataShopOwnerCommon.mjs'
import { Types } from 'mongoose'

export interface IRedisDataShopOwnerForNode extends IRedisDataShopOwnerCommon {
	_id: Types.ObjectId
}
