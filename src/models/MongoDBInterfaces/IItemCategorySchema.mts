import { Types } from 'mongoose'

/**
 * The `itemCategory` collection — the platform-wide taxonomy items are filed under, two levels deep.
 *
 * A document with no `idParent` is a category; one whose `idParent` names a category is a subcategory;
 * one whose `idParent` names a *subcategory* is the thing the collection must not contain. ⚠️ That
 * last rule is enforced **nowhere near this file**: the parent's own `idParent` lives in a different
 * document, and a MongoDB validator sees exactly one document at a time, so the depth cap lives in
 * `itemCategoryAdd` / `itemCategoryUpdate` in the Admin resource service. A reader who finds
 * `idParent` unconstrained here should not conclude the depth is arbitrary.
 *
 * The taxonomy is platform-wide rather than per shop owner — two shops selling the same kind of
 * thing have to land in the same category or the customer-facing filter means nothing — which is why
 * there is no `idShopOwner` on it and why writes are Admin-only. Nothing here may presume what is
 * sold.
 */
export interface IItemCategorySchema {
	_id: Types.ObjectId
	name: string
	/**
	 * URL segment of `/category/:slug` and of `/category/:slug/:subSlug` — globally unique across
	 * *both* levels rather than within a parent, because two subcategories called "drinks" under two
	 * different parents would be two URLs that cannot both exist.
	 */
	slug: string
	/** Absent = top-level category; present = subcategory. Nothing below that second level is legal. */
	idParent?: Types.ObjectId
	/**
	 * ⚠️ A SORT ORDINAL, not the GeoJSON `position` that `IUserAddress` and `ICompanyAddress` carry.
	 * The two share a name and nothing else — this collection stores no coordinates. Required, because
	 * the alternative is a listing whose order changes between two reads of the same data.
	 */
	position: number
	/**
	 * Soft delete, spelled the way `company` and `shopOwner` spell it. A category cannot be hard
	 * deleted: `item.idCategory` is required and nothing enforces the reference, so removing the
	 * document would leave every item filed under it pointing at nothing.
	 */
	deleted?: Date
	__v?: number
}
