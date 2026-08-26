/**
 * The two CSFLE algorithms this platform uses, and the only two it may use.
 *
 * Both are AEAD — the ciphertext carries its own MAC, so a tampered value fails to decrypt rather
 * than decrypting to something else. They differ in one property and it decides everything else:
 *
 * - **Deterministic** derives its IV from the plaintext, so the same plaintext under the same key
 *   always produces the same ciphertext. That is exactly enough for `findOne`, `$in`, `$eq` and a
 *   unique index, and nothing more — it is *not* enough for `$gt`, `sort`, `$regex` or a text index,
 *   because equal ciphertexts say nothing about the order of the plaintexts behind them. The cost is
 *   that it leaks equality: two documents holding the same value are visibly holding the same value.
 * - **Random** uses a fresh IV per encryption, so the same plaintext encrypts differently every
 *   time. Nothing can be inferred from the ciphertext, and nothing can be queried on it either — a
 *   filter on a random-encrypted field matches nothing, silently.
 *
 * ⚠️ Deterministic is not defined for every BSON type. `double`, `decimal128`, `bool`, `object`,
 * `array` and `null` are rejected outright by the driver; `string`, `date`, `int`, `long`,
 * `objectId`, `binData`, `regex`, `javascript`, `symbol` and `timestamp` are accepted. Random takes
 * anything, which is why `position` — a sub-document of a string and two doubles — is random and
 * could not have been anything else.
 *
 * Which field gets which is ADR-029 and `encryptedFields.mts`, not a per-call-site decision.
 */
export const ALGORITHM_DETERMINISTIC = 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic'

export const ALGORITHM_RANDOM = 'AEAD_AES_256_CBC_HMAC_SHA_512-Random'

export type EncryptionAlgorithm = typeof ALGORITHM_DETERMINISTIC | typeof ALGORITHM_RANDOM
