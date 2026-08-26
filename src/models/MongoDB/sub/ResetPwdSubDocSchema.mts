import { IResetPwdSubDocSchema } from '@MongoDBInterfaces/sub/IResetPwdSubDocSchema.mjs'
import { Schema } from 'mongoose'

export const ResetPwdSubDocSchema = new Schema<IResetPwdSubDocSchema>(
	{
		resetDateReq: {
			type: Date
		},
		resetHash: {
			type: String
		}
	},
	{
		_id: false
	}
)
