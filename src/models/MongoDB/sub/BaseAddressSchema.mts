import { IBaseAddressSchema } from '@MongoDBInterfaces/sub/IBaseAddressSchema.mjs'
import { Schema } from 'mongoose'

export const BaseAddressSchema = new Schema<IBaseAddressSchema>(
	{
		street: {
			type: String,
			required: true
		},
		postalCode: {
			type: String,
			required: true
		},
		city: {
			type: String,
			required: true
		},
		province: {
			type: String,
			required: true
		}
	},
	{ _id: false }
)
