import { IUserSchema } from '@MongoDBInterfaces/IUserSchema.mjs'

export interface IUserModel extends IUserSchema {
	generateHashPassword: (password: string) => Promise<string>
}
