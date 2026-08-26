import { decryptDocument } from '@encryption/decryptDocument.mjs'
import { encryptAtNode } from '@encryption/encryptAtNode.mjs'
import { buildEncryptedFieldTrie } from '@encryption/encryptedFieldTrie.mjs'
import { encryptFilter } from '@encryption/encryptFilter.mjs'
import { encryptUpdate } from '@encryption/encryptUpdate.mjs'
import { encryptValue } from '@encryption/fieldEncryption.mjs'
import { IEncryptedFieldSpec } from '@encryption/IEncryptedFieldSpec.mjs'
import { isCiphertext } from '@encryption/isCiphertext.mjs'
import { Document, MongooseDefaultQueryMiddleware, Query, Schema } from 'mongoose'

export interface IFieldEncryptionPluginOptions {
	fields: IEncryptedFieldSpec[]
	keyAltName: string
}

/**
 * Query kinds that carry a filter. Every one of them can name an encrypted field, so every one of
 * them has its filter rewritten before it leaves the process.
 *
 * `estimatedDocumentCount` is absent because it takes no filter at all.
 */
const FILTER_HOOKS: MongooseDefaultQueryMiddleware[] = [
	'find',
	'findOne',
	'findOneAndDelete',
	'findOneAndReplace',
	'findOneAndUpdate',
	'replaceOne',
	'updateOne',
	'updateMany',
	'deleteOne',
	'deleteMany',
	'countDocuments',
	'distinct'
]

const UPDATE_HOOKS: MongooseDefaultQueryMiddleware[] = [
	'findOneAndUpdate',
	'findOneAndReplace',
	'replaceOne',
	'updateOne',
	'updateMany'
]

/**
 * Query kinds that return documents. `countDocuments` and the `update*` pair are absent on purpose —
 * they return counts, and walking a number is wasted work on the hottest path there is.
 */
const RESULT_HOOKS: MongooseDefaultQueryMiddleware[] = [
	'find',
	'findOne',
	'findOneAndDelete',
	'findOneAndReplace',
	'findOneAndUpdate'
]

/**
 * Expands one declared path into the concrete paths a *given document* has.
 *
 * `addresses.[].street` is not a path Mongoose can `get`; `addresses.0.street` and
 * `addresses.1.street` are, and which of them exist depends on the document in hand. A customer with
 * no addresses yields nothing here and is written untouched, which is correct.
 */
function* documentPaths(document: Document, path: string): Generator<string> {
	const marker = path.indexOf('.[].')

	if (marker === -1) {
		yield path
		return
	}

	const head = path.slice(0, marker)
	const tail = path.slice(marker + '.[].'.length)
	const array: unknown = document.get(head)

	if (!Array.isArray(array)) {
		return
	}

	for (let index = 0; index < array.length; index += 1) {
		yield* documentPaths(document, `${head}.${index}.${tail}`)
	}
}

/**
 * Turns every personal field of a model into ciphertext on the way out and back into plaintext on
 * the way in, for every query shape Mongoose offers.
 *
 * ⚠️ **This lives in the schema rather than at the call sites, and it had to.** Twenty-one of the
 * database operations that touch these collections are inside `@axiumine/koa-utils` — the login,
 * the password reset, the email verification and the email change — and that is a published package
 * whose source is not in this workspace. It is handed our models and calls `findOne` and `updateOne`
 * on them. A plugin on the schema is the only layer that sits under those calls, and it is also what
 * keeps nine services and three frontends from each needing to know which fields are encrypted.
 *
 * The write side is driven by the declared field map, because plaintext is indistinguishable from
 * any other value and something has to say which fields are personal. The read side is not: it
 * decrypts every `binData` subtype 6 it finds, so a projection, a partial document or a field nobody
 * declared all come back readable.
 */
export function fieldEncryptionPlugin(schema: Schema, options: IFieldEncryptionPluginOptions): void {
	const root = buildEncryptedFieldTrie(options.fields)
	const keyAltName = options.keyAltName

	schema.pre(FILTER_HOOKS, async function (this: Query<unknown, unknown>) {
		await encryptFilter(this.getFilter(), root, keyAltName)
	})

	schema.pre(UPDATE_HOOKS, async function (this: Query<unknown, unknown>) {
		await encryptUpdate(this.getUpdate(), root, keyAltName)
	})

	schema.post(RESULT_HOOKS, async function (result: unknown) {
		await decryptDocument(result)
	})

	// `Model.create()` routes through `save()`, so this one hook covers both. Paths are set through
	// `document.set` rather than written into `_doc`, so the ciphertext is recorded as a change and
	// actually reaches the server; `EncryptedField` is what stops the `set` casting it back.
	schema.pre('save', async function (this: Document) {
		for (const spec of options.fields) {
			for (const path of documentPaths(this, spec.path)) {
				const current: unknown = this.get(path)

				if (current === null || current === undefined || isCiphertext(current)) {
					continue
				}

				this.set(path, await encryptValue(current, spec.algorithm, keyAltName))
			}
		}
	})

	// Puts the plaintext back into the document the caller is still holding. `save()` leaves it full
	// of the ciphertext the pre-hook set, so a resolver that saves an account and then reads
	// `account.login.email` off the same object — which `registerNewUser` does — would answer a
	// `Binary`. Written through `_doc`, so nothing is marked modified and the next `save()` does not
	// send the plaintext back.
	schema.post('save', async function (document: unknown) {
		await decryptDocument(document)
	})

	// Nothing on the platform calls `insertMany` today. The hook is here because the day something
	// does, the alternative is a batch of plaintext personal data written into a collection whose
	// every other document is encrypted — silently, and with no way to tell afterwards which
	// documents went in which way.
	//
	// The hook takes the documents as its *first* argument and no `next`: mongoose's hook runner
	// stopped passing a callback, and a first parameter named `next` would be handed the array.
	schema.pre('insertMany', async function (documents: unknown) {
		if (!Array.isArray(documents)) {
			return
		}

		for (let index = 0; index < documents.length; index += 1) {
			documents[index] = await encryptAtNode(documents[index], root, keyAltName)
		}
	})
}
