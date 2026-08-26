import { ICompanySchema } from '@MongoDBInterfaces/ICompanySchema.mjs'
import { IItemCategorySchema } from '@MongoDBInterfaces/IItemCategorySchema.mjs'
import { Types } from 'mongoose'

/**
 * The `item` collection — what a shop sells, and the bottom of the catalogue chain
 * `shopOwner ──idShopOwner──> company ──idCompany──> item`.
 *
 * ⚠️ **Deliberately domain-neutral.** Nothing here may presume what is sold: one collection plus
 * `itemCategory` covers every product type, and a new type is an `itemCategory` document, never a
 * collection name. **Do not reintroduce a per-type model** — that is exactly the duplication this
 * pair exists to avoid.
 *
 * ⚠️ **There is no `price`.** Cart, order, delivery and payment have no model anywhere on this
 * platform and no design decision behind them yet, so a price would be a guess at a currency, a
 * precision, a VAT treatment and a discount model at once. It arrives with the ordering tier.
 *
 * Neither `idCompany` nor `idCategory` is enforced by the database, so nothing stops an item
 * pointing at a company that was never created. The resolvers check both before writing, the same
 * arrangement `ICompanySchema.idShopOwner` has.
 */
export interface IItemSchema {
	_id: Types.ObjectId
	/** The company that sells this — the shop, since a company IS the shop on this platform. */
	idCompany: ICompanySchema['_id']
	/** An `itemCategory` document, at either of its two levels. */
	idCategory: IItemCategorySchema['_id']
	name: string
	description: string
	/**
	 * URL segment of `/shop/:slug/item/:itemSlug`, unique **per company** rather than globally — the
	 * one place this collection's URL rules differ from `company`'s and `itemCategory`'s. The company
	 * segment already disambiguates, so two shops may both sell a "blue shirt" and neither has its URL
	 * at the mercy of the other's catalogue.
	 */
	slug: string
	/**
	 * False while a draft. It composes with the company's own flag: an item is publicly visible only
	 * if this is true AND its company is published, which the public resolvers filter for — no
	 * validator can state a rule that reads another document.
	 */
	published: boolean
	/**
	 * File name of the item's picture — `<_id>.webp` — and never a path or a URL. The bytes live
	 * under `STATIC_FOLDER/item/<idCompany>/`, so both directory segments are already fields of this
	 * document and storing them again would only give them a second place to go stale.
	 *
	 * Optional, and the optionality is the whole reason the field exists: the name is derivable from
	 * `_id`, but *whether there is a file at all* is not, and a catalogue card has to pick between a
	 * picture and a placeholder before it renders. The validator pins the shape to 24 hex characters
	 * plus a short extension, which is what keeps a traversal segment out of a value three frontends
	 * interpolate into a URL.
	 */
	image?: string
	/** Soft delete: the instant the item was withdrawn, absent while it is live. */
	deleted?: Date
	__v?: number
}
