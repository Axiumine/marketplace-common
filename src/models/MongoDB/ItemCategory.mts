import { IItemCategorySchema } from '@MongoDBInterfaces/IItemCategorySchema.mjs'
import { model, Schema } from 'mongoose'

/*
 * The platform-wide item taxonomy, two levels deep. See `IItemCategorySchema` for what each field
 * means and `marketplace-db-setup/lib/schemas/itemCategory.js` for the validator this mirrors.
 *
 * ⚠️ **The two-level cap is not here and cannot be.** `idParent` is a plain optional ObjectId at
 * every layer that can see one document — this model, the collection validator — because "my parent
 * must itself be top-level" reads a *second* document. `itemCategoryAdd` / `itemCategoryUpdate` in
 * the Admin resource service are the only place it is enforced, so do not add a third level on the
 * strength of this file looking permissive.
 *
 * Bounds (name at most 100, the slug pattern, `position` at least 0) live in the collection
 * validator and deliberately not here, exactly as on `Company.mts`: the model states shape and
 * requiredness, `$jsonSchema` states limits, and two copies of a length are two places to disagree.
 */
const ItemCategorySchema: Schema<IItemCategorySchema> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		name: {
			type: String,
			required: true
		},
		slug: {
			type: String,
			required: true
		},
		// Self-reference, and optional: absent is what makes a category top-level. `ref` is this model's
		// own name, which Mongoose resolves lazily, so the cycle is fine.
		idParent: {
			type: Schema.Types.ObjectId,
			ref: 'ItemCategory'
		},
		// ⚠️ A sort ordinal, NOT the GeoJSON point that `Company.address.position` and
		// `User.addresses[].position` carry. Same name, unrelated meaning; this collection stores no
		// coordinates.
		position: {
			type: Number,
			required: true
		},
		// Soft delete. A category is never removed outright: `item.idCategory` is required and nothing
		// enforces the reference, so a hard delete would strand every item filed under it.
		deleted: {
			type: Date
		},
		__v: {
			type: Number
		}
	},
	{
		collection: 'itemCategory'
	}
)

const ItemCategory = model<IItemCategorySchema>('ItemCategory', ItemCategorySchema)
export { ItemCategory }
