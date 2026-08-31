import { keygripKey } from '@others/sessionKeys.mjs'

/**
 * The one Redis verb this probe needs, as a parameter (ADR-034).
 *
 * ⚠️ **The client is a parameter, not an import**, for the reason `readKeygrip` states at length:
 * importing `redisClient` here would pull the `redis` types into this package, and `redis` is a
 * dependency of the *services*, not of this library.
 */
export interface IRedisNamespaceProbeStore {
	hGetAll(key: string): Promise<Record<string, string>>
}

/**
 * Refuses to boot when `REDIS_KEY` does not name the namespace this platform was seeded into.
 *
 * ⚠️ **This is the resource tier's half of a check the signing tier already has.** The five services that
 * sign or read a session cookie call `loadKeygrip`, which reads the fleet's key record at
 * `<REDIS_KEY>keygrip` and refuses the boot when it is not there — so a wrong `REDIS_KEY` costs those five
 * a startup failure and nothing else. The four **resource** services read no such record, and a wrong
 * prefix cost them nothing at all: every session lookup simply missed in a namespace nobody writes, every
 * request answered 401, and the service reported itself healthy the whole time. `REDIS_KEY` is a prefix,
 * so there is no wrong value that Redis itself will refuse.
 *
 * ⚠️ **Presence only — this never reads the KEK and never unwraps anything.** Three of the four callers
 * hold no `KEYGRIP_KEK` at all: they verify access tokens rather than cookies, and giving them the key
 * material to answer a question about a *prefix* would widen what a resource service holds for no reason.
 * `readKeygrip` owns the record's well-formedness, on behalf of the services that actually open it; this
 * asks the one question those services cannot be asked, which is whether the record is *here*.
 *
 * ⚠️ **It cannot see a fleet-wide wrong prefix, and is not meant to.** If the seed ran under the same
 * wrong `REDIS_KEY` as the services, the record is exactly where they look for it and every one of them
 * agrees — which is the provisioning failure `RISK_REGISTER` R04 names, and no check that compares the
 * platform against itself can catch it. What this catches is one service out of step with the rest, which
 * is the shape R02 fired in twice before the keygrip record existed.
 *
 * The error code is `readKeygrip`'s, deliberately: an admin greps one string, and the remedy line names
 * both causes because at this point the two are indistinguishable from inside the process.
 */
export async function assertRedisNamespace(store: IRedisNamespaceProbeStore): Promise<void> {
	const record = await store.hGetAll(keygripKey())

	if (!record?.wrapped)
		throw new Error(
			`KEYGRIP_RECORD_MISSING: no keygrip key set at "${keygripKey()}". Either REDIS_KEY names a namespace this platform was never seeded into, or "yarn seed:keygrip" has not been run in marketplace-db-setup.`
		)
}
