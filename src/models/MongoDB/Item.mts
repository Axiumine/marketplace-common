import { IItemSchema } from '@MongoDBInterfaces/IItemSchema.mjs'
import { model, Schema } from 'mongoose'

/*
 * What a shop sells — the bottom of `shopOwner ──idShopOwner──> company ──idCompany──> item`.
 *
 * ⚠️ **This is the extension seam, and it is domain-neutral on purpose.** A new product type is an
 * `itemCategory` document rather than a model, a migration and a set of resolvers. Nothing here may
 * presume what is sold, and do not reintroduce a per-type model.
 *
 * ⚠️ **No `price`.** Cart, order, delivery and payment have no model on this platform yet, so a
 * price would be a guess at a currency, a precision, a VAT treatment and a discount model at once.
 * It lands with the ordering tier.
 *
 * `required` here matches the collection validator field for field, which it can afford to do
 * because the collection was created empty by `20260804030000-create-item` — `collMod` does not
 * re-validate stored documents, so a required path on a *populated* collection strands every document
 * that predates it. That is why `Company.taxCode` is optional and why nothing here is.
 *
 * Bounds (name at most 150, description at most 2000, the slug pattern) live in the validator and
 * not here, as on every other model in this package.
 */
const ItemSchema: Schema<IItemSchema> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		// Neither reference is enforced by the database, so the resolvers check both exist before
		// writing, the way `companyAdd` checks `idShopOwner`.
		idCompany: {
			type: Schema.Types.ObjectId,
			required: true,
			ref: 'Company'
		},
		idCategory: {
			type: Schema.Types.ObjectId,
			required: true,
			ref: 'ItemCategory'
		},
		name: {
			type: String,
			required: true
		},
		description: {
			type: String,
			required: true
		},
		// Unique per company, not globally — the uniqueness is an index in the migration, not a flag
		// here, because it is compound (`{ idCompany, slug }`) and a `unique: true` on this path would
		// declare the wrong one.
		slug: {
			type: String,
			required: true
		},
		// Composes with `company.published`: an item shows publicly only if both are true. That AND is
		// a resolver filter — no validator and no model can read the other document.
		published: {
			type: Boolean,
			required: true
		},
		// The picture's file name, `<_id>.webp` — not a path and not a URL, because the directory it
		// sits in is `STATIC_FOLDER/item/<idCompany>/` and both segments are already on the document.
		// Optional: an item may have none, and that is exactly what a card needs to know before it can
		// choose between a picture and a placeholder. The 24-hex-plus-extension shape is the
		// validator's, like every other bound on this model.
		image: {
			type: String
		},
		// Soft delete, like `company.deleted`: a date rather than a flag, so it answers *when* as well
		// as *whether*, and every read path filters on `{ $exists: false }`.
		deleted: {
			type: Date
		},
		__v: {
			type: Number
		}
	},
	{
		collection: 'item'
	}
)

const Item = model<IItemSchema>('Item', ItemSchema)
export { Item }
