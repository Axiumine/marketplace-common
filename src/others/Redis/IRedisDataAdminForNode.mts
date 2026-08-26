import { IRedisDataAdminCommon } from '@others/Redis/IRedisDataAdminCommon.mjs'
import { Types } from 'mongoose'

export interface IRedisDataAdminForNode extends IRedisDataAdminCommon {
	_id: Types.ObjectId
}
