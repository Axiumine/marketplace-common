import { EncryptionAlgorithm } from '@encryption/EncryptionAlgorithm.mjs'

/**
 * One encrypted field, declared once and read by everything.
 *
 * `path` is dotted, and `[]` is an array element — `addresses.[].street` is the street of every
 * element of `addresses`. That single token is the whole of the array support and it is enough,
 * because MongoDB spells the same position four different ways depending on how it is being written
 * (`addresses.0`, `addresses.$`, `addresses.$[]`, `addresses.$[elem]`) and all four have to resolve
 * to the same rule.
 *
 * `plaintext` is what the *application* holds — the shape a resolver puts in and expects back.
 * It exists because the value in the database is a `binData` that Mongoose must not try to cast to a
 * `String`, while the value the caller assigns still has to be cast the way it always was. See
 * `EncryptedField.mts`.
 */
export interface IEncryptedFieldSpec {
	path: string
	algorithm: EncryptionAlgorithm
	plaintext: 'string' | 'date' | 'object'
}
