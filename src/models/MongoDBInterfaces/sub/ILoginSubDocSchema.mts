import { IOnboarding } from '@MongoDBInterfaces/IOnboarding.mjs'

export interface ILoginSubDocSchema extends IOnboarding {
	_id?: boolean
	email: string
	password: string
	firstLogin?: Date
	lastLogin?: Date
	rememberMe?: boolean
}
