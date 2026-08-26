import { IBaseAddressSchema } from '@MongoDBInterfaces/sub/IBaseAddressSchema.mjs'
import { PositionType } from '@mtypes/PositionType.mjs'

/**
 * The shopOwner's address, with the GeoJSON point the operator app draws a map from.
 *
 * ⚠️ `position` is **optional here and required on the company** (`ICompanyAddress`), and the asymmetry
 * is deliberate. Every shopOwner already in the collection was written before this field existed,
 * so a required position would make each of them fail its own validator on the next save — an
 * operator editing a phone number would be told to pick an address. It fills in the first time the
 * address is chosen from the autocomplete; until then the account simply has no map.
 */
export interface IShopOwnerAddress extends IBaseAddressSchema {
	position?: {
		type: typeof PositionType.Point
		coordinates: number[]
	}
}

export interface IShopOwnerPersonalData {
	_id?: boolean
	firstName: string
	lastName: string
	// `data`, not `date` — the collection validator, the GraphQL type and the seed migration all
	// spell it this way. The Mongoose model was the only place that did not.
	birth: {
		date: Date
	}
	address: IShopOwnerAddress
	contacts: {
		mobile: string
		landline?: string
		email: string
	}
}
