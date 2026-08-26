import { IKeygripLoadStore, IKeygripRecord, loadKeygrip } from '@others/loadKeygrip.mjs'
import { recordKeygripHolder } from '@others/recordKeygripHolder.mjs'
import { keygripChannel, keygripKey } from '@others/sessionKeys.mjs'

/**
 * How often the version is re-read when no message has arrived, in milliseconds.
 *
 * Five minutes is the bound on how long one service can keep signing with a retired-from-index-0 key
 * after a rotation it did not hear about. That window costs nothing on its own — every sibling still
 * verifies the older key for `SESSION_CAP_DAYS_REMEMBERED` days — so the poll is a safety net for a
 * subscription that died quietly, not the mechanism. Shorter would buy nothing; much longer would let a
 * silently dead subscription look healthy for the length of an incident.
 */
export const KEYGRIP_POLL_MS = 300_000

/** The one extra verb the poll needs on top of what `loadKeygrip` already asks for. */
export interface IKeygripWatchStore extends IKeygripLoadStore {
	hGet(key: string, field: string): Promise<string | null | undefined>
}

/**
 * The subscribing half of the connection, as a parameter (ADR-034).
 *
 * ⚠️ **It must not be the client the rest of the service uses.** node-redis v6 refuses ordinary commands
 * on a connection in subscriber mode, so a service that subscribed on its main client would lose every
 * session read it makes — the caller passes `redisClient.duplicate()`, already connected.
 */
export interface IKeygripSubscriber {
	subscribe(channel: string, listener: (message: string) => void): Promise<unknown>
}

export interface IKeygripWatchOptions {
	store: IKeygripWatchStore
	subscriber: IKeygripSubscriber
	/** This service's own name, written into the holders row on every adoption. */
	serviceName: string
	/** The version this process is already signing with — what both paths compare against. */
	version: number
	/** The fingerprint of that key set, so a poll that finds nothing changed can still say "still here". */
	fp: string
	/** Hand the freshly unwrapped record to the caller, which rebuilds its `Keygrip` from it. */
	onKeys: (record: IKeygripRecord) => void
	/**
	 * Where a failed re-read goes. A parameter rather than a Sentry import, for the reason
	 * `refreshSessionTokens` takes `captureException`: this package must not put a telemetry client behind
	 * every consumer of a Mongoose model.
	 */
	onError: (error: unknown) => void
	/** Poll interval; the default is the only value production uses. */
	pollMs?: number
}

/**
 * Keeps one service's signing keys in step with the record, without a restart (ADR-034).
 *
 * ⚠️ **The pub/sub message is a nudge, never the key.** A subscriber re-reads and unwraps the record
 * itself, so nothing a publisher sends can hand this process key material it did not already hold the KEK
 * to read — which is what makes the channel safe to leave unauthenticated inside Redis. It also means a
 * lost message costs a delay rather than a wrong key, and that is why the same read runs on a timer.
 *
 * Both paths converge on `loadKeygrip`: the same unwrap, the same refusals, the same holders row. A live
 * swap that took a different route from the boot read would be a second implementation of the one thing
 * this design exists to make single.
 *
 * ⚠️ **A failed re-read is reported and dropped, never thrown.** This runs on a timer and on a socket
 * callback, where a throw is an unhandled rejection that kills the process — and killing a *serving*
 * service because it could not read a key it already has is strictly worse than serving on with the old
 * one, which every sibling still verifies. The boot read is where a bad record must be fatal.
 *
 * ⚠️ **The version comparison is what makes both paths idempotent.** Redis delivers a message to every
 * subscriber and the poll fires regardless, so without it a service would rebuild its `Keygrip` — and
 * hand the caller a new one to install — every five minutes forever, on a record nobody had touched.
 * Rebuilding is not free and, more to the point, "the keys changed" is an event this platform reports;
 * an event that fires on its own schedule is one nobody can read.
 *
 * Returns the poll timer, `unref`'d so it never holds the process open: the caller keeps it only to stop
 * the watch, and nothing in a service's lifetime needs to.
 */
export async function watchKeygrip(options: IKeygripWatchOptions): Promise<NodeJS.Timeout> {
	const { store, subscriber, serviceName, onKeys, onError } = options
	let version = options.version
	let fp = options.fp

	const adopt = async () => {
		const record = await loadKeygrip(store, serviceName)

		if (record.version === version) return

		version = record.version
		fp = record.fp
		onKeys(record)
	}

	const reread = () => {
		adopt().catch(onError)
	}

	await subscriber.subscribe(keygripChannel(), reread)

	/*
	 * `HGET` first, and the full read only when the number moved: the poll runs for the lifetime of the
	 * process on five services, and unwrapping a record nobody rotated would be five AES operations every
	 * five minutes forever to reach the answer "nothing changed" — which one small field already gives.
	 *
	 * ⚠️ **The unchanged branch is not a no-op**: it restamps this service's holders row, and that is what
	 * makes the row a heartbeat. Without it the timestamp would say when the service last *adopted*, so a
	 * process that booted in March and never rotated would be indistinguishable from one that has been
	 * dead since March — and telling those two apart is the entire job of the table.
	 */
	const timer = setInterval(() => {
		store
			.hGet(keygripKey(), 'version')
			.then((current) => (Number(current) === version ? recordKeygripHolder(store, serviceName, fp) : reread()))
			.catch(onError)
	}, options.pollMs ?? KEYGRIP_POLL_MS)

	return timer.unref()
}
