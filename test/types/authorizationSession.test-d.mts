import type { Types } from 'mongoose'
import { describe, expectTypeOf, test } from 'vitest'

import type { Admin } from '../../src/models/MongoDB/Admin.mts'
import type { ShopOwner } from '../../src/models/MongoDB/ShopOwner.mts'
import type { User } from '../../src/models/MongoDB/User.mts'
import type { IAdminEmail } from '../../src/models/MongoDBInterfaces/IAdminEmail.mts'
import type { IShopOwnerModel } from '../../src/models/MongoDBInterfaces/IShopOwnerModel.mts'
import type { IUserModel } from '../../src/models/MongoDBInterfaces/IUserModel.mts'
import type { ISessionAccountModel } from '../../src/others/findAccountForSession.mts'
import type { TAuthorizationSession } from '../../src/others/resolveAuthorizationSession.mts'
import type { TIER } from '../../src/others/Tier.mts'

/*
 * ⚠️ The one thing about the shared session helpers that cannot be checked by running them.
 *
 * `findAccountForSession` takes a **structural** `ISessionAccountModel<TAccount>` rather than
 * mongoose's `Model<TAccount>`, and the reason is assignability: `Model<T>` is invariant in `T`, the
 * three tiers' document types are unrelated, and a helper typed against it would take none of the
 * three models without a cast at every call site. The structural interface is supposed to take all
 * three — a method parameter is bivariant and the return position only has to be assignable — and
 * "supposed to" is exactly the kind of claim that stops being true after a mongoose bump.
 *
 * A unit test cannot notice: the suites hand it a hand-rolled stub that satisfies the interface by
 * construction. These three assertions are the only place the real models meet it.
 */
describe('ISessionAccountModel accepts the three tenant models', () => {
	// Full document. The shop-owner session carries the onboarding fields, so its projection asks for
	// more than the other two and the reader hands the whole model shape back.
	test('ShopOwner, read as IShopOwnerModel', () => {
		expectTypeOf<typeof ShopOwner>().toExtend<ISessionAccountModel<IShopOwnerModel>>()
	})

	// Full document, same shape as the shop owner minus the approval gate.
	test('User, read as IUserModel', () => {
		expectTypeOf<typeof User>().toExtend<ISessionAccountModel<IUserModel>>()
	})

	/*
	 * The operator tier is the one that projects down to a shape with no model interface of its own —
	 * `_id login.email deleted disabled` — which is why `IAdminEmail` exists as a declared type instead
	 * of an inline one in the service. It must satisfy the same structural contract as the other two.
	 */
	test('Admin, read as the projected IAdminEmail', () => {
		expectTypeOf<typeof Admin>().toExtend<ISessionAccountModel<IAdminEmail>>()
	})

	// The one part of the contract that is not about models: `lean()` is what the helper calls, and the
	// projection is a plain string — a caller passing mongoose's object projection form would compile
	// against `Model` and not against this.
	test('the query it needs is findById(filter, projection).lean()', () => {
		expectTypeOf<ISessionAccountModel<IAdminEmail>['findById']>().parameter(0).toEqualTypeOf<{ _id: Types.ObjectId }>()
		expectTypeOf<ISessionAccountModel<IAdminEmail>['findById']>().parameter(1).toEqualTypeOf<string>()
	})
})

/*
 * The session an authorization service puts on `ctx.state.user`. Its three fixed members are what
 * every tier has in common, and the tier-specific half arrives as the generic parameter — so a
 * service cannot forget the discriminator by declaring a narrower state type.
 */
describe('TAuthorizationSession', () => {
	type TShopOwnerSession = TAuthorizationSession<{ email: string; onboardingStep?: string }>

	test('carries the id as the hex string Redis stored, not an ObjectId', () => {
		expectTypeOf<TShopOwnerSession>().toHaveProperty('_id').toEqualTypeOf<string>()
		expectTypeOf<TShopOwnerSession>().toHaveProperty('_id').not.toEqualTypeOf<Types.ObjectId>()
	})

	// Not `string`: the tier is the discriminator every resource service asserts against, and widening
	// it here would let a service store a value `assertTier` can never match.
	test('carries the tier as the tier union', () => {
		expectTypeOf<TShopOwnerSession>().toHaveProperty('tier').toEqualTypeOf<(typeof TIER)[keyof typeof TIER]>()
	})

	test('carries the refresh token it was resolved from, plus the tier-specific half', () => {
		expectTypeOf<TShopOwnerSession>().toHaveProperty('refreshToken').toEqualTypeOf<string>()
		expectTypeOf<TShopOwnerSession>().toHaveProperty('email').toEqualTypeOf<string>()
		expectTypeOf<TShopOwnerSession>().toHaveProperty('onboardingStep').toEqualTypeOf<string | undefined>()
	})
})
