import { IShopOwnerSchema } from '@MongoDBInterfaces/IShopOwnerSchema.mjs'
import { IBaseAddressSchema } from '@MongoDBInterfaces/sub/IBaseAddressSchema.mjs'
import { PositionType } from '@mtypes/PositionType.mjs'
import { Types } from 'mongoose'

/**
 * The company's legal seat: a base address plus a required GeoJSON point, built from the same
 * `IBaseAddressSchema` base every address on the platform uses.
 */
export interface ICompanyAddress extends IBaseAddressSchema {
	position: {
		type: typeof PositionType.Point
		coordinates: number[]
	}
}

/**
 * The `company` collection — an shopOwner's company, one document per company, keyed by
 * `idShopOwner`. `company` stands on its own: nothing about being a company depends on anything
 * else referencing it.
 */
export interface ICompanySchema {
	_id: Types.ObjectId
	/** Required: an company with no owner is unreachable — every read path lists by shopOwner. */
	idShopOwner: IShopOwnerSchema['_id']
	legalName: string
	vatNumber: string
	/**
	 * Tax code of the legal entity — the 11-digit company form, not the 16-character personal
	 * one. Optional: no stored company carries it, and `collMod` does not re-validate what is already
	 * stored, so requiring it would strand every existing document.
	 */
	taxCode?: string
	contactPerson: string
	administrator: string
	uniqueCode?: string
	certifiedEmail: string
	address: ICompanyAddress
	/** The uploaded registryExtract's path, not the document itself. */
	registryExtract: string
	/**
	 * The trading name shown to customers. `legalName` is the registered legal name and belongs on an
	 * invoice, not on a card: it is not what the shop is called and it carries a corporate form
	 * nobody searches for.
	 *
	 * Optional here and required in practice for a published company — see `published`.
	 */
	publicName?: string
	/** URL segment of `/shop/:slug`, globally unique. Optional for the same reason `publicName` is. */
	slug?: string
	/** The shop page's body text, and what the platform-wide text search matches on. */
	description?: string
	/**
	 * False until the owner puts the shop live; nothing public reads an unpublished company.
	 *
	 * ⚠️ **Required, and it implies `slug` and `publicName`** — the `company` validator is
	 * `$and: [ {$jsonSchema}, {$expr} ]` and the second clause refuses `published: true` without
	 * both, because a shop with no URL and a card with no heading are states the storefront cannot
	 * draw. It runs on updates as well as inserts, so setting the flag and the slug in two calls is
	 * a rejected write, not a transient one.
	 *
	 * It says nothing about `deleted`: a soft-deleted company may stay published, because every
	 * public read already filters on both.
	 */
	published: boolean
	/**
	 * Soft delete: the instant the company was deleted, absent while it is live. A date rather than a
	 * bool for the same reason `shopOwner` uses one — it answers *when* as well as *whether* — and
	 * every read path filters on `{ $exists: false }` rather than on a value.
	 */
	deleted?: Date
	__v?: number
}
