import { Binary } from 'mongodb'

/**
 * `true` for a value that is already CSFLE ciphertext.
 *
 * Subtype 6 is the driver's own marker for an encrypted value and nothing else on this platform
 * stores a `binData` at all, so this is both the necessary and the sufficient test.
 *
 * Two things depend on it. **Encrypting is idempotent**: a document that came back from a read, was
 * handed to a second query and passed the write walker again is not double-encrypted, because every
 * value it holds already answers `true` here. And **decrypting needs no field map**: the read walker
 * decrypts whatever answers `true`, wherever it finds it, so a field added to the collection without
 * being added to `encryptedFields.mts` still comes back readable — it simply never gets encrypted in
 * the first place, which is the failure this cannot fix and the field map's own comment warns about.
 */
export function isCiphertext(value: unknown): value is Binary {
	return value instanceof Binary && value.sub_type === Binary.SUBTYPE_ENCRYPTED
}
