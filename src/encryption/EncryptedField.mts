import { IEncryptedFieldSpec } from '@encryption/IEncryptedFieldSpec.mjs'
import { isCiphertext } from '@encryption/isCiphertext.mjs'
import { Error as MongooseError, Schema, SchemaType } from 'mongoose'

export const ENCRYPTED_FIELD_TYPE = 'EncryptedField'

interface IEncryptedFieldOptions {
	plaintext?: IEncryptedFieldSpec['plaintext']
}

/**
 * Casts a plaintext value the way the `EncryptedField` path itself does, and the single source of
 * truth both share — a `String`/`Date` path's own cast, restated for the one type each `plaintext`
 * option stands in for.
 *
 * ⚠️ **Extracted so a write that never passes through this path's `cast()` can still get the same
 * guarantee.** `save()` gets it for free: assigning `doc.personalData.birth.date = …` casts through
 * this very path before the field-encryption plugin ever runs. A query-based update does not — the
 * plugin's `pre` hook encrypts the raw filter/update value *before* mongoose's own `_castUpdate` runs
 * against it, so a malformed value would otherwise be encrypted as-is and never raise the `CastError`
 * `save()` would give for the same bad input. `encryptUpdate` calls this directly for exactly that
 * reason — see its own comment.
 */
export function castPlaintext(value: unknown, plaintext: IEncryptedFieldSpec['plaintext'] | undefined, path: string): unknown {
	if (value === null || value === undefined || isCiphertext(value)) {
		return value
	}

	if (plaintext === 'date') {
		const date = value instanceof Date ? value : new Date(value as string)
		if (Number.isNaN(date.getTime())) {
			throw new MongooseError.CastError(ENCRYPTED_FIELD_TYPE, value, path)
		}
		return date
	}

	if (plaintext === 'string') {
		if (typeof value === 'string') {
			return value
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value)
		}
		throw new MongooseError.CastError(ENCRYPTED_FIELD_TYPE, value, path)
	}

	return value
}

/**
 * The Mongoose path type of every encrypted field, and the reason the rest of the platform did not
 * have to change.
 *
 * An encrypted field is two things at once. In the database it is a `binData`; in a resolver, in a
 * GraphQL response and in all three frontends it is the string or date it always was. Something has
 * to hold both, and a `String` path cannot: Mongoose casts on assignment and on query-filter
 * building, so a `Binary` written to a `String` path comes out as the text `Binary.toString()`
 * produces, which is garbage that validates.
 *
 * So this type casts *plaintext* exactly the way the path used to — a string stays a string, a date
 * string becomes a `Date`, and a bad value still raises the same `CastError` at the same place —
 * and passes ciphertext through untouched. `plaintext: 'object'` is the escape hatch for `position`,
 * which is a sub-document encrypted whole and therefore has no scalar cast to perform.
 *
 * ⚠️ It is not `Schema.Types.Mixed`. Mixed would also stop the casting, and would additionally stop
 * change tracking — every `doc.personalData.contacts.email = '…'` would need a matching
 * `markModified()` or be silently dropped on `save()`. A real type keeps `isModified` working the
 * way every other path on these models works.
 */
export class EncryptedField extends SchemaType {
	static schemaName = ENCRYPTED_FIELD_TYPE

	constructor(path: string, options?: IEncryptedFieldOptions) {
		super(path, options, ENCRYPTED_FIELD_TYPE)
	}

	override cast(value: unknown): unknown {
		return castPlaintext(value, (this.options as IEncryptedFieldOptions).plaintext, this.path)
	}
}

/**
 * Mongoose resolves `type:` through its own registry rather than by reading the constructor, so a
 * type it has never been told about is a `TypeError` at schema-build time — i.e. at import, before
 * any test can run. Registering at module load is what makes `{ type: EncryptedField }` legal in the
 * four model files.
 */
;(Schema.Types as unknown as Record<string, unknown>)[ENCRYPTED_FIELD_TYPE] = EncryptedField

export interface IEncryptedPathOptions extends IEncryptedFieldOptions {
	plaintext: IEncryptedFieldSpec['plaintext']
	required?: true
}

/**
 * Declares one encrypted path in a schema definition.
 *
 * A helper rather than an inline `{ type: EncryptedField, … }` for one reason, and it is a type-level
 * one: mongoose's `SchemaDefinition<T>` types each key against the field's declared TypeScript type,
 * and a custom `SchemaType` subclass is not assignable to the `StringSchemaDefinition` it expects for
 * a `string` field. The generic is deliberately unconstrained and inferred from the *call site's*
 * contextual type, so every path resolves to whatever mongoose expects there and no model needs a
 * cast of its own.
 *
 * The interfaces keep saying `string` and `Date`, which is the point — the ciphertext exists between
 * this package and the server, and nowhere else. Resolvers, GraphQL types and all three frontends
 * are untouched by this change.
 */
export function encryptedPath<T>(options: IEncryptedPathOptions): T {
	return { type: EncryptedField, ...options } as unknown as T
}
