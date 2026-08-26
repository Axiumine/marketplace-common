import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { ILoginSubDocSchema } from '@MongoDBInterfaces/sub/ILoginSubDocSchema.mjs'
import bcrypt from '@node-rs/bcrypt'
import { SALT_ROUNDS } from '@others/Constants.mjs'
import { HydratedDocument, Schema } from 'mongoose'

export const LoginSubDocSchema = new Schema<ILoginSubDocSchema>(
	{
		// Encrypted on all three collections that spread this sub-document, and the one field where
		// that is *not* a free choice: it is the credential every login matches on and the key of
		// `login.email_unique`, so it has to be deterministic. See ADR-029 and
		// `@encryption/encryptedFields.mjs` — the algorithm is declared there, per model, and this
		// path type only says "do not cast the ciphertext back to a string".
		email: encryptedPath({ plaintext: 'string', required: true }),
		// Never encrypted, and adding it to the field map would be a mistake rather than an upgrade:
		// this is a bcrypt hash, it is not personal data, and every login compares against it.
		password: {
			type: String,
			required: true
		},
		firstLogin: {
			type: Date
		},
		lastLogin: {
			type: Date
		},
		rememberMe: {
			type: Boolean
		},
		onboardingStep: {
			type: String
		},
		onboardingDone: {
			type: Boolean
		}
	},
	{
		_id: false
	}
)

// hash user password before saving into database
LoginSubDocSchema.pre('save', async function (this: HydratedDocument<ILoginSubDocSchema>) {
	// Only hash if password has been modified (or is new)
	if (!this.isModified('password')) {
		return
	}

	this.password = await bcrypt.hash(this.password, SALT_ROUNDS)
})
