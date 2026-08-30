/**
 * What a customer tells the platform about themselves, once they get round to it.
 *
 * ⚠️ **The whole block is optional on `IUserSchema`, where `IShopOwnerPersonalData` is required.**
 * Registration on this tier is an email and a password and nothing else; the name and the contact
 * details are filled in afterwards, and an account that never fills them in still works. A shop
 * owner is onboarded by an admin who collects everything up front, which is why that side can
 * demand it.
 *
 * ⚠️ **No `address` field, unlike the shop owner's.** A customer's addresses are a top-level array —
 * they have a home, an office and a friend's flat, and one of them is the default. See
 * `IUserSchema.addresses` and `IUserAddress`.
 *
 * `contacts` requires none of its members, where the shop owner's requires `mobile` and `email`. The
 * account's address is `login.email` and is the credential; this `email` is a *second* address to be
 * reached on, so demanding it would be asking the customer to retype what they already gave.
 *
 * `birth` is a sub-object rather than a bare date because the collection validator declares it as
 * one — it was the shape `shopOwner` already had, and keeping the two identical means one date
 * widget in the frontends rather than two.
 *
 * The phantom `_id?: boolean` is the same wart `IShopOwnerPersonalData` carries and for the same
 * reason: `User.mts` declares `personalData` as an inline `type: { _id: false, … }` object, and that
 * spelling only type-checks if the data interface has a slot for the flag.
 */
export interface IUserPersonalData {
	_id?: boolean
	firstName: string
	lastName: string
	birth?: {
		date: Date
	}
	contacts?: {
		mobile?: string
		landline?: string
		email?: string
	}
}
