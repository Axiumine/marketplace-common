import { ILoginSubDocSchema } from '@MongoDBInterfaces/sub/ILoginSubDocSchema.mjs'
import { IResetPwdSubDocSchema } from '@MongoDBInterfaces/sub/IResetPwdSubDocSchema.mjs'
import { Types } from 'mongoose'

interface IPersonalData {
	_id?: boolean
	firstName: string
	lastName: string
}

export interface IAdminSchema {
	_id: Types.ObjectId
	login: ILoginSubDocSchema
	personalData: IPersonalData
	deleted?: Date
	disabled?: boolean
	resetPwd?: IResetPwdSubDocSchema
	__v?: number
}
