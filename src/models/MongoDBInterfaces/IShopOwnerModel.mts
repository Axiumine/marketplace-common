import { IShopOwnerSchema } from '@MongoDBInterfaces/IShopOwnerSchema.mjs'

export interface IShopOwnerModel extends IShopOwnerSchema {
	generateHashPassword: (password: string) => Promise<string>
}
