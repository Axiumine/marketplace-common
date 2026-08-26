import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { IEmailVerifySubDocSchema } from '@MongoDBInterfaces/sub/IEmailVerifySubDocSchema.mjs'
import { Schema } from 'mongoose'

/**
 * Mirrors the `emailVerify` block of the `shopOwner` collection validator field for field, and
 * the paths map handed to `createVerifyEmailFlow` in the public-resource service.
 *
 * Nothing is `required`, matching the validator. The verify-email flow writes the members
 * independently — `setEmailHash` sets `hash`/`requestTimes`/`dateLastReq` without `valid`,
 * `enableEmailAccess` sets `valid` and `$unset`s the rest — so every partial combination has to be a
 * legal document. Marking any member required would reject one of the states the flow itself
 * produces, on the very next write.
 *
 * `_id: false` for the same reason as `birth` / `contacts` on ShopOwner: the validator declares
 * this object with `additionalProperties: false`, so the `_id` Mongoose adds by default is on its own
 * enough to make every write of it fail.
 */
export const EmailVerifySubDocSchema = new Schema<IEmailVerifySubDocSchema>(
	{
		valid: {
			type: Boolean
		},
		hash: {
			type: String
		},
		dateLastReq: {
			type: Date
		},
		// Number, not a plain int: the driver serializes an integral JS number inside int32 range as
		// BSON int, which is what the validator's `bsonType: 'int'` accepts, and `$inc` keeps the type.
		requestTimes: {
			type: Number
		},
		// The second of the two deterministic fields on the platform. `emailChangeHashVerify` in
		// koa-utils confirms an email change with `findOne({ [paths.newEmailTmp]: uEmail })` — it
		// looks the account up *by the pending address* — so this one is matched by value and could
		// not be random. `hash`, `dateLastReq`, `requestTimes` and `valid` above are flow state, not
		// personal data, and stay in the clear.
		newEmailTmp: encryptedPath({ plaintext: 'string' })
	},
	{
		_id: false
	}
)
