import { IKeygripReadStore, IKeygripRecord, readKeygrip } from '@others/readKeygrip.mjs'
import { IKeygripHolderStore, recordKeygripHolder } from '@others/recordKeygripHolder.mjs'

/**
 * The Redis verbs this needs, as a parameter (ADR-034) — the read `readKeygrip` asks for, plus the two
 * the holders row is written and given a lifetime with.
 */
export interface IKeygripLoadStore extends IKeygripReadStore, IKeygripHolderStore {}

/** Re-exported so the five signing services keep importing the record shape from the function they call. */
export type { IKeygripRecord }

/**
 * Reads the fleet's cookie-signing keys out of Redis, records this service as a holder, or throws
 * (ADR-034).
 *
 * ⚠️ **A throw here must stop the boot.** Every caller runs this immediately after its Redis connect and
 * lets the failure reach `start()`'s catch, which exits non-zero. A service that could not read the
 * record and started anyway is the exact failure this whole design exists to remove: it would sign
 * cookies with keys no sibling can verify, and the symptom — some requests authenticate, some do not,
 * depending on which service the edge picked — is one the platform has already paid for twice. The two
 * refusals, and what each one asks the admin to fix, are on `readKeygrip`.
 *
 * The holders write is not wrapped in a try: it goes to the client that answered the read one line
 * earlier, so a failure means Redis died between the two calls, and booting on a dead Redis is not
 * better than not booting.
 */
export async function loadKeygrip(store: IKeygripLoadStore, serviceName: string): Promise<IKeygripRecord> {
	const record = await readKeygrip(store)

	await recordKeygripHolder(store, serviceName, record.fp)

	return record
}
