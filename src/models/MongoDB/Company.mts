import { encryptedPath } from '@encryption/EncryptedField.mjs'
import { ENCRYPTED_FIELDS_COMPANY, KEY_ALT_NAME_COMPANY } from '@encryption/encryptedFields.mjs'
import { fieldEncryptionPlugin } from '@encryption/fieldEncryptionPlugin.mjs'
import { BaseAddressSchema } from '@MongoDB/sub/BaseAddressSchema.mjs'
import { ICompanySchema } from '@MongoDBInterfaces/ICompanySchema.mjs'
import { model, Schema, SchemaDefinition } from 'mongoose'

/*
 * An shopOwner's company, one document per company. One shopOwner owns N companies. There is no
 * shop collection and there is no shop reference on this model — Company stands on its own,
 * unreferenced by anything downstream in this repo.
 *
 * Field bounds (vatNumber exactly 11, registryExtract at most 1000, …) live in the collection validator and
 * deliberately not here — no model in this package restates them, and two copies of a length would
 * be two places to disagree. The model states shape and requiredness; `$jsonSchema` states limits.
 */
const CompanySchema: Schema<ICompanySchema> = new Schema(
	{
		_id: {
			type: Schema.Types.ObjectId
		},
		idShopOwner: {
			type: Schema.Types.ObjectId,
			required: true,
			ref: 'ShopOwner'
		},
		legalName: {
			type: String,
			required: true
		},
		vatNumber: {
			type: String,
			required: true
		},
		// Optional, and it has to be: the collection carried no such field before, and `collMod` does
		// not re-validate stored documents — a required path here would make every existing company
		// unsaveable through this model.
		taxCode: {
			type: String
		},
		// ⚠️ The only two encrypted fields on this collection, and the only two that name a natural
		// person rather than the entity. Everything around them stays in the clear on purpose:
		// `legalName`, `vatNumber`, `taxCode` (the 11-character company form, not the 16-character
		// personal one), `uniqueCode`, `certifiedEmail` and `registryExtract` describe a registered
		// company, and `publicName`, `slug`, `description` and the whole of `address` are what the
		// storefront hands to anonymous visitors — encrypting any of those would cost the map, the
		// city listing and the text search to protect data the platform publishes anyway.
		contactPerson: encryptedPath({ plaintext: 'string', required: true }),
		administrator: encryptedPath({ plaintext: 'string', required: true }),
		uniqueCode: {
			type: String
		},
		certifiedEmail: {
			type: String,
			required: true
		},
		// `.clone()`, never the shared schema itself: `BaseAddressSchema` is the address of several
		// other things too and `.add()` mutates in place, so adding the point without cloning would
		// put it on every one of them.
		//
		// The point IS required here, unlike the shopOwner's: the collection is created empty, so
		// there is no stored document for the requirement to strand.
		address: {
			type: BaseAddressSchema.clone().add({
				position: {
					type: new Schema(
						{
							type: { type: String, enum: ['Point'], required: true },
							coordinates: { type: [Number], required: true }
						},
						{ _id: false }
					),
					required: true
				}
			} as SchemaDefinition),
			required: true
		},
		registryExtract: {
			type: String,
			required: true
		},
		// The four fields `20260804010000-alter-company-public` added, which turn a legal record into
		// a shop listing. A company IS the shop here — there is no `shop` collection and there is not
		// going to be one — so everything a storefront renders about a shop hangs off this model.
		//
		// `legalName` is the registered legal name and wrong on a customer-facing card twice over: it is
		// not what the shop is called, and it carries a corporate form nobody searches for. This is the
		// trading name over the door.
		publicName: {
			type: String
		},
		// URL segment of `/shop/:slug`, globally unique — the index is in the migration, and it is
		// **partial** (`slug: { $type: 'string' }`) because a plain unique index stores one null key
		// per slugless document and would refuse the second company that has no slug.
		slug: {
			type: String
		},
		// The shop page's body text and the target of the text index.
		description: {
			type: String
		},
		// ⚠️ The three optional fields above are optional for the usual reason — `collMod` does not
		// re-validate stored documents, and no slug can be derived from a registered legal name without
		// inventing one — but `published` is required, and it is the one field on this model whose
		// requiredness was *earned*: the migration widened the validator, backfilled every stored document
		// with `false`, then narrowed. Nothing is stranded, so the model may demand it too.
		//
		// `published: true` additionally implies a `slug` and a `publicName`, and that is enforced by
		// the database rather than here: the `company` validator is `$and: [ {$jsonSchema}, {$expr} ]`
		// and the second clause refuses an unlinkable published company. `companyUpdate` therefore
		// cannot set the flag and the slug in two calls — an update that passes *through* an invalid
		// state is refused, since a validator is a constraint and not a create-time check.
		published: {
			type: Boolean,
			required: true
		},
		// Soft delete. `companyDel` stamps this instead of removing the document — a stamp rather than a
		// removal, in case something ever comes to reference a company by `_id` again. Every read
		// path filters `{ $exists: false }`.
		deleted: {
			type: Date
		},
		__v: {
			type: Number
		}
	},
	{
		collection: 'company'
	}
)

CompanySchema.plugin(fieldEncryptionPlugin, { fields: ENCRYPTED_FIELDS_COMPANY, keyAltName: KEY_ALT_NAME_COMPANY })

const Company = model<ICompanySchema>('Company', CompanySchema)
export { Company }
