/**
 * What a customer's session carries, in both the Redis and the in-process shapes.
 *
 * ⚠️ **No `onboardingStep`**, which `IRedisDataShopOwnerCommon` has. A shop owner is walked through a
 * multi-step onboarding whose position has to survive a page reload, so the step rides in the
 * session; a customer registers, confirms an address and is done. Adding a step field here to make
 * the two symmetrical would be inventing a flow that does not exist.
 */
export interface IRedisDataUserCommon {
	email: string
}
