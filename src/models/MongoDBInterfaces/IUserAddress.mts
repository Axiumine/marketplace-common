import { IBaseAddressSchema } from '@MongoDBInterfaces/sub/IBaseAddressSchema.mjs'
import { PositionType } from '@mtypes/PositionType.mjs'
import { Types } from 'mongoose'

/**
 * One saved address of a customer — an element of `user.addresses`.
 *
 * ⚠️ **`_id` is required here and absent from every other address shape in this package.**
 * `IShopOwnerAddress` and `ICompanyAddress` are embedded single objects and are written with
 * `{ _id: false }`, because the collection validators declare them `additionalProperties: false` and
 * an unasked-for `_id` fails the write outright. This one is the opposite case: it is an array
 * element that `user.defaultAddress` names by id, so the id is the whole point. The `user` validator
 * lists `_id` in the element's `required`, and the sub-schema behind this interface therefore keeps
 * Mongoose's auto-minted ObjectId instead of turning it off.
 *
 * `label` is free text the customer chooses — "home", "office". Optional, capped at 50 characters by
 * the validator, and never used as a key: two addresses may carry the same label, and the default is
 * named by `defaultAddress`, not by a magic label value.
 *
 * `position` is optional for the same reason as on the shop owner: the point arrives when the
 * address is picked from the geocoder's autocomplete, and an address typed by hand has no map until
 * it is re-picked. Requiring it would make every other write path unable to save an address at all.
 */
export interface IUserAddress extends IBaseAddressSchema {
	_id?: Types.ObjectId
	label?: string
	position?: {
		type: typeof PositionType.Point
		coordinates: number[]
	}
}
