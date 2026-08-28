/** Bytes a decoded `KEYGRIP_KEK` must be — AES-256 takes a 256-bit key and nothing else. */
const KEK_BYTES = 32

/**
 * Decodes `KEYGRIP_KEK` into the raw AES-256 key, or throws (ADR-034, ADR-040).
 *
 * ⚠️ **The single decode site for the whole fleet.** Every place that needs the KEK as bytes calls this —
 * `readKeygrip` on the boot and read paths, and the two admin-resource mutations that reseal the record.
 * That is the point: an adopter swapping `KEYGRIP_KEK` for a secrets manager (`docs/PRODUCTION_HARDENING.md`
 * §1) has one place in TypeScript to look at, not three, and the length check below cannot be present in one
 * of them and missing in the others.
 *
 * ⚠️ **This does not make the value agree across processes.** Two reads of `process.env` in one process
 * always return the same string; three *processes* resolving a manager independently need not. The hardening
 * page's rule — resolve once per process, before start, and pass the result in — is what covers that, and
 * this function neither replaces it nor weakens the need for it.
 *
 * ⚠️ **The message names no part of the KEK, only the length it decoded to.** It is printed to a boot log,
 * which is the least protected place on the platform — see `readKeygrip` for the rest of that reasoning.
 *
 * A raw `process.env.KEYGRIP_KEK` read anywhere under `src/` is a regression. `ADR-040` §Compliance greps
 * for exactly that.
 */
export function readKek(): Buffer {
	const kek = Buffer.from(process.env.KEYGRIP_KEK ?? '', 'base64')

	if (kek.length !== KEK_BYTES)
		throw new Error(`KEYGRIP_KEK_MISMATCH: KEYGRIP_KEK must be base64 of ${KEK_BYTES} bytes, this one decodes to ${kek.length}.`)

	return kek
}
