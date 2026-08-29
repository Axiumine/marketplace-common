import { describe, expectTypeOf, test } from 'vitest'

import type { IAdminModel } from '../../src/models/MongoDBInterfaces/IAdminModel.mts'
import type { IAdminSchema } from '../../src/models/MongoDBInterfaces/IAdminSchema.mts'
import type { ICompanyAddress, ICompanySchema } from '../../src/models/MongoDBInterfaces/ICompanySchema.mts'
import type { IShopOwnerModel } from '../../src/models/MongoDBInterfaces/IShopOwnerModel.mts'
import type { IShopOwnerAddress, IShopOwnerPersonalData } from '../../src/models/MongoDBInterfaces/IShopOwnerPersonalData.mts'
import type { IShopOwnerSchema } from '../../src/models/MongoDBInterfaces/IShopOwnerSchema.mts'
import type { IBaseAddressSchema } from '../../src/models/MongoDBInterfaces/sub/IBaseAddressSchema.mts'
import type { IEmailVerifySubDocSchema } from '../../src/models/MongoDBInterfaces/sub/IEmailVerifySubDocSchema.mts'
import type { IResetPwdSubDocSchema } from '../../src/models/MongoDBInterfaces/sub/IResetPwdSubDocSchema.mts'
import type { IRedisDataAdmin } from '../../src/others/Redis/IRedisDataAdmin.mts'
import type { IRedisDataAdminCommon } from '../../src/others/Redis/IRedisDataAdminCommon.mts'
import type { IRedisDataAdminForNode } from '../../src/others/Redis/IRedisDataAdminForNode.mts'
import type { IRedisDataShopOwner } from '../../src/others/Redis/IRedisDataShopOwner.mts'
import type { IRedisDataShopOwnerCommon } from '../../src/others/Redis/IRedisDataShopOwnerCommon.mts'
import type { IRedisDataShopOwnerForNode } from '../../src/others/Redis/IRedisDataShopOwnerForNode.mts'
import type { ILoginInput } from '../../src/schema/interfaces/ILoginInput.mts'

describe('IAdminModel / IShopOwnerModel: generateHashPassword contract', () => {
	test('IAdminModel.generateHashPassword is (password: string) => Promise<string>', () => {
		expectTypeOf<IAdminModel>().toHaveProperty('generateHashPassword')
		expectTypeOf<IAdminModel['generateHashPassword']>().parameter(0).toEqualTypeOf<string>()
		expectTypeOf<IAdminModel['generateHashPassword']>().returns.toEqualTypeOf<Promise<string>>()
	})

	test('IShopOwnerModel.generateHashPassword is (password: string) => Promise<string>', () => {
		expectTypeOf<IShopOwnerModel>().toHaveProperty('generateHashPassword')
		expectTypeOf<IShopOwnerModel['generateHashPassword']>().parameter(0).toEqualTypeOf<string>()
		expectTypeOf<IShopOwnerModel['generateHashPassword']>().returns.toEqualTypeOf<Promise<string>>()
	})

	test('IAdminModel/IShopOwnerModel extend their respective *Schema shapes', () => {
		expectTypeOf<IAdminModel>().toExtend<IAdminSchema>()
		expectTypeOf<IShopOwnerModel>().toExtend<IShopOwnerSchema>()
	})

	test('negative: generateHashPassword does not accept a numeric password', () => {
		expectTypeOf<IAdminModel['generateHashPassword']>().parameter(0).not.toEqualTypeOf<number>()
	})
})

describe('IShopOwnerSchema.emailVerify', () => {
	// Optionality is the contract, not an oversight: an shopOwner that has never requested a
	// verification link carries no `emailVerify` at all, and the flow `$unset`s the members again once
	// a link is honoured. Making it mandatory would force every caller that builds an ShopOwner to
	// invent a value the collection validator does not ask for.
	test('emailVerify is IEmailVerifySubDocSchema | undefined', () => {
		expectTypeOf<IShopOwnerSchema>().toHaveProperty('emailVerify').toEqualTypeOf<IEmailVerifySubDocSchema | undefined>()
	})

	// Same reason the schema marks no member required, one level down: `setEmailHash` writes
	// hash/requestTimes/dateLastReq without `valid`, `enableEmailAccess` writes `valid` and unsets the
	// rest, so no single member is ever guaranteed present. `toEqualTypeOf<T | undefined>` rather than
	// `toExtend<T>` — the latter passes on a mandatory field too, which is the mistake being pinned.
	test('every member is optional and carries its own type', () => {
		expectTypeOf<IEmailVerifySubDocSchema>().toHaveProperty('valid').toEqualTypeOf<boolean | undefined>()
		expectTypeOf<IEmailVerifySubDocSchema>().toHaveProperty('hash').toEqualTypeOf<string | undefined>()
		expectTypeOf<IEmailVerifySubDocSchema>().toHaveProperty('dateLastReq').toEqualTypeOf<Date | undefined>()
		expectTypeOf<IEmailVerifySubDocSchema>().toHaveProperty('requestTimes').toEqualTypeOf<number | undefined>()
		expectTypeOf<IEmailVerifySubDocSchema>().toHaveProperty('newEmailTmp').toEqualTypeOf<string | undefined>()
	})

	// The two token slots must stay separate types — a shared one is exactly the shape that let a hash
	// issued by either flow authenticate the other. This is what fails if someone folds them into one.
	test('negative: emailVerify is not the reset-password shape, and declares no _id', () => {
		expectTypeOf<IEmailVerifySubDocSchema>().not.toEqualTypeOf<IResetPwdSubDocSchema>()
		expectTypeOf<IEmailVerifySubDocSchema>().not.toHaveProperty('_id')
	})
})

describe('the admin-only fields on the shopOwner', () => {
	// Optional both ways round: every shopOwner in the collection predates the field, and most
	// accounts never get a note at all. A mandatory one would force every caller that builds an
	// ShopOwner to invent a value the validator does not ask for.
	test('note is string | undefined, at the top level and not in personalData', () => {
		expectTypeOf<IShopOwnerSchema>().toHaveProperty('notes').toEqualTypeOf<string | undefined>()
		expectTypeOf<IShopOwnerPersonalData>().not.toHaveProperty('notes')
	})

	// The shopOwner's address point is optional: every shopOwner in the collection was written
	// before this path existed, so a required one would fail every existing document on its next save.
	test('the address point is optional', () => {
		expectTypeOf<IShopOwnerAddress>().toExtend<IBaseAddressSchema>()
		expectTypeOf<IShopOwnerAddress>()
			.toHaveProperty('position')
			.toEqualTypeOf<{ type: string; coordinates: number[] } | undefined>()
	})

	test('personalData.address is the shape that carries the point', () => {
		expectTypeOf<IShopOwnerPersonalData>().toHaveProperty('address').toEqualTypeOf<IShopOwnerAddress>()
	})
})

describe('the company schema', () => {
	test('idShopOwner is required on the company, taxCode, uniqueCode and deleted are not', () => {
		expectTypeOf<ICompanySchema>().toHaveProperty('idShopOwner').toEqualTypeOf<IShopOwnerSchema['_id']>()
		expectTypeOf<ICompanySchema>().toHaveProperty('taxCode').toEqualTypeOf<string | undefined>()
		expectTypeOf<ICompanySchema>().toHaveProperty('uniqueCode').toEqualTypeOf<string | undefined>()
		expectTypeOf<ICompanySchema>().toHaveProperty('legalName').toEqualTypeOf<string>()
		// Soft delete, and a Date — `boolean | undefined` is the shape this would most plausibly have
		// been given, and it would lose the instant the company went.
		expectTypeOf<ICompanySchema>().toHaveProperty('deleted').toEqualTypeOf<Date | undefined>()
	})

	test('the company address carries a required point', () => {
		expectTypeOf<ICompanyAddress>().toExtend<IBaseAddressSchema>()
		expectTypeOf<ICompanyAddress>().toHaveProperty('position').toEqualTypeOf<{ type: string; coordinates: number[] }>()
	})
})

describe('ILoginInput exact shape', () => {
	test('ILoginInput equals { email: string; password: string }', () => {
		expectTypeOf<ILoginInput>().toEqualTypeOf<{ email: string; password: string }>()
	})

	test('negative: ILoginInput is not equal to a shape missing password', () => {
		expectTypeOf<ILoginInput>().not.toEqualTypeOf<{ email: string }>()
	})
})

describe('Redis DTO inheritance: Admin', () => {
	test('IRedisDataAdmin adds _id:string on top of IRedisDataAdminCommon', () => {
		expectTypeOf<IRedisDataAdmin>().toHaveProperty('_id').toEqualTypeOf<string>()
		expectTypeOf<IRedisDataAdmin>().toExtend<IRedisDataAdminCommon>()
		// carries the base-layer field too (3-layer inheritance: Common -> concrete)
		expectTypeOf<IRedisDataAdmin>().toHaveProperty('email').toEqualTypeOf<string>()
	})

	test('IRedisDataAdminForNode adds _id:Types.ObjectId on top of IRedisDataAdminCommon', () => {
		expectTypeOf<IRedisDataAdminForNode>().toExtend<IRedisDataAdminCommon>()
		expectTypeOf<IRedisDataAdminForNode>().not.toEqualTypeOf<IRedisDataAdmin>()
	})
})

describe('Redis DTO inheritance: ShopOwner', () => {
	test('IRedisDataShopOwner adds _id:string on top of IRedisDataShopOwnerCommon', () => {
		expectTypeOf<IRedisDataShopOwner>().toHaveProperty('_id').toEqualTypeOf<string>()
		expectTypeOf<IRedisDataShopOwner>().toExtend<IRedisDataShopOwnerCommon>()
		// carries the base-layer field too (3-layer inheritance: Common -> concrete)
		expectTypeOf<IRedisDataShopOwner>().toHaveProperty('email').toEqualTypeOf<string>()
	})

	test('IRedisDataShopOwnerForNode adds _id:Types.ObjectId on top of IRedisDataShopOwnerCommon', () => {
		expectTypeOf<IRedisDataShopOwnerForNode>().toExtend<IRedisDataShopOwnerCommon>()
		expectTypeOf<IRedisDataShopOwnerForNode>().not.toEqualTypeOf<IRedisDataShopOwner>()
	})
})

describe('IAdminSchema plain-data shape', () => {
	test('has required login field of type ILoginSubDocSchema (structural)', () => {
		expectTypeOf<IAdminSchema>().toHaveProperty('login')
		expectTypeOf<IAdminSchema['login']>().not.toBeUndefined()
	})

	test('negative: IAdminSchema is not assignable from an object missing login', () => {
		expectTypeOf<{ _id: IAdminSchema['_id']; personalData: IAdminSchema['personalData'] }>().not.toEqualTypeOf<IAdminSchema>()
	})
})
