import { IAdminSchema } from '@MongoDBInterfaces/IAdminSchema.mjs'

export interface IAdminModel extends IAdminSchema {
	generateHashPassword: (password: string) => Promise<string>
}
