import { IRedisDataUserCommon } from '@others/Redis/IRedisDataUserCommon.mjs'
import { Types } from 'mongoose'

export interface IRedisDataUserForNode extends IRedisDataUserCommon {
	_id: Types.ObjectId
}
