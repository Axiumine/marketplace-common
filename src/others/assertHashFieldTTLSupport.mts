/**
 * The one command this probe issues. `hTTL` and not `hExpire` deliberately: the check runs at boot,
 * against a live keyspace, and a probe that wrote would have to choose a key to write to and then
 * remember to clean it up.
 */
export interface IHashFieldTTLProbeStore {
	hTTL(key: string, fields: string): Promise<unknown>
}

/**
 * The key the probe reads. Nothing is stored under it and nothing needs to be — `hTTL` on a missing key
 * answers rather than throwing, which is exactly what makes it a safe probe.
 */
export const HASH_FIELD_TTL_PROBE_KEY = () => `${process.env.REDIS_KEY}hash-field-ttl-probe`

/**
 * What a Redis older than 7.4.0 says when it is asked for a command it has never had. Matched on the
 * phrase rather than on an error class: the client surfaces server errors as `ErrorReply` whatever the
 * server said, so the phrase is the only thing that distinguishes "this server is too old" from "this
 * server is unreachable" — and the two need very different messages in front of an operator.
 */
const UNKNOWN_COMMAND = /unknown command/i

/**
 * Refuses to boot on a Redis that has no hash-field TTLs (E15-S03).
 *
 * ⚠️ **This exists because Redis does not check commands at startup — it checks them at first use.**
 * Without this, a platform pointed at a 7.2 server boots cleanly, serves every read, and then fails the
 * *first login of the day* with `ERR unknown command 'HEXPIRE'` from inside a rollback, in one service,
 * with the cause three layers below the symptom. The floor is written down in `marketplace-docker-DBs/README.md`
 * §Redis and pinned by `marketplace-docker-DBs/env`, but a pin is one edit away from being lowered and a developer's
 * own Redis was never pinned by anything — so the platform asks the server it actually got.
 *
 * ⚠️ **Anything that is not "unknown command" is rethrown untouched.** A connection refused at boot is a
 * connection refused, and dressing it up as a version problem would send whoever reads the log to the
 * wrong page. Only the one recognisable phrase is translated.
 */
export async function assertHashFieldTTLSupport(store: IHashFieldTTLProbeStore): Promise<void> {
	try {
		await store.hTTL(HASH_FIELD_TTL_PROBE_KEY(), 'probe')
	} catch (e) {
		if (!UNKNOWN_COMMAND.test(`${(e as Error)?.message}`)) throw e

		throw new Error(
			'Redis is older than 7.4.0: hash-field TTLs (HEXPIRE/HTTL) are missing, and the session index cannot prune itself without them. See marketplace-docker-DBs/README.md §Redis.'
		)
	}
}
