import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { ENCRYPTED_FIELDS_ADMIN, KEY_ALT_NAME_ADMIN } from '@encryption/encryptedFields.mjs'
import { fieldEncryptionPlugin } from '@encryption/fieldEncryptionPlugin.mjs'
import { LoginSubDocSchema } from '@MongoDB/sub/LoginSubDocSchema.mjs'
import { ResetPwdSubDocSchema } from '@MongoDB/sub/ResetPwdSubDocSchema.mjs'
import { IAdminModel } from '@MongoDBInterfaces/IAdminModel.mjs'
import bcrypt from '@node-rs/bcrypt'
import { SALT_ROUNDS } from '@others/Constants.mjs'
import { model, Schema } from 'mongoose'

const AdminSchema: Schema<IAdminModel> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		login: {
			type: LoginSubDocSchema,
			required: true
		},
		// Both names are encrypted, and here that costs nothing: there is no operator table over this
		// collection, so nothing sorts or prefix-searches them the way `shopOwnersActiveTbl` does on
		// the shop owner. Random, because nothing looks an operator up by name either.
		personalData: {
			type: {
				_id: false,
				firstName: encryptedPath({ plaintext: 'string' }),
				lastName: encryptedPath({ plaintext: 'string' })
			},
			required: true
		},
		deleted: {
			type: Date
		},
		disabled: {
			type: Boolean
		},
		resetPwd: ResetPwdSubDocSchema,
		__v: {
			type: Number
		}
	},
	{
		collection: 'admin'
	}
)

AdminSchema.plugin(fieldEncryptionPlugin, { fields: ENCRYPTED_FIELDS_ADMIN, keyAltName: KEY_ALT_NAME_ADMIN })

AdminSchema.methods.generateHashPassword = async function (password: string) {
	return await bcrypt.hash(password, SALT_ROUNDS)
}

const Admin = model<IAdminModel>('Admin', AdminSchema)
export { Admin }
