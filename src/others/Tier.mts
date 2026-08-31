/**
 * Which collection a session authenticated against.
 *
 * The platform has no `role` field and no permission enum — role *is* the collection you log in
 * against, and each tier gets its own service pair. This constant is the one place that fact is
 * written down as data, so a session can be tagged with it and a service can refuse a session
 * minted for somebody else's tier.
 *
 * It is not a permission model and must not grow into one. Three values, one per collection:
 * `admin`, `shopOwner`, `user`. A fourth is added only when a fourth collection is added.
 */
export const TIER = {
	admin: 'admin',
	shopOwner: 'shopOwner',
	user: 'user'
} as const

export type Tier = (typeof TIER)[keyof typeof TIER]

/**
 * Whether a string read back out of Redis is one of the three tiers.
 *
 * ⚠️ **Not a substitute for `assertTier`, and never to be used as one.** That function answers "is this
 * session mine to serve", which is an authorisation decision; this one answers "is this string a tier at
 * all", which is a parsing decision. The one caller is the reuse trail: a tombstone written before
 * the tier was stored there carries none, and an event filed under `undefined` would name a key no console
 * ever reads while claiming an account had been logged out.
 */
export const isTier = (value: string | undefined): value is Tier => Object.values(TIER).some((tier) => tier === value)
