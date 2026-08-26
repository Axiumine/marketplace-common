import { Binary } from 'mongodb'

/**
 * A stand-in for `encryptValue` / `decryptValue`, and the reason the walker suites need neither a
 * MongoDB nor a key vault.
 *
 * The real pair goes through `mongodb-client-encryption`, a native addon that fetches a data key out
 * of a key vault collection before it can encrypt one value — so a unit test of the *walkers* would
 * otherwise be an integration test of the driver. What the walkers depend on is narrower than that:
 * a value goes in, a `Binary` of subtype 6 comes out, and the same `Binary` handed back yields the
 * value again.
 *
 * This keeps every plaintext in `vault` and puts its index in the ciphertext, so the round trip is
 * exact for a `Date`, an object and a string alike, and every call stays inspectable — which
 * algorithm and which key each field was encrypted under is what ADR-029 is actually about, and it
 * is asserted directly rather than inferred from a blob.
 *
 * `fieldEncryption.mts` itself is not exercised through this; it has a suite of its own that fakes
 * the driver's `ClientEncryption` one level lower down.
 */
export interface IVaultEntry {
	value: unknown
	algorithm: string
	keyAltName: string
}

export const vault: IVaultEntry[] = []

export async function fakeEncryptValue(value: unknown, algorithm: string, keyAltName: string): Promise<Binary> {
	vault.push({ value: value, algorithm: algorithm, keyAltName: keyAltName })
	return new Binary(Buffer.from(String(vault.length - 1)), Binary.SUBTYPE_ENCRYPTED)
}

export async function fakeDecryptValue(value: Binary): Promise<unknown> {
	return entryOf(value).value
}

export function resetVault(): void {
	vault.length = 0
}

/** The vault entry a piece of ciphertext points at, and a readable failure when it is not one. */
export function entryOf(value: unknown): IVaultEntry {
	if (!(value instanceof Binary) || value.sub_type !== Binary.SUBTYPE_ENCRYPTED) {
		throw new Error(`Expected ciphertext, got ${String(JSON.stringify(value))}`)
	}

	return vault[Number(value.toString())] as IVaultEntry
}

/** The plaintext behind a piece of ciphertext. */
export function plaintextOf(value: unknown): unknown {
	return entryOf(value).value
}
