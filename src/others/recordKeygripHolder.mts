import { keygripHoldersKey } from '@others/sessionKeys.mjs'

/**
 * How long a holders row outlives the heartbeat that wrote it, in seconds. One hour.
 *
 * ⚠️ **This is what makes the table self-cleaning** (ADR-034). Every row is rewritten on
 * `watchKeygrip`'s five-minute poll, so a live service refreshes its own expiry twelve times over before
 * it lapses. A service that is decommissioned — or renamed, or moved to another port — stops refreshing,
 * and its row leaves the table within the hour instead of sitting there forever as a permanent "has not
 * adopted the current keys", which is a red an admin learns to ignore.
 *
 * Twelve missed polls rather than one or two: a Redis blip, a long GC pause or a redeploy must not erase
 * a service that is perfectly alive, because a *missing* row and a *stale* row mean different things and
 * the admin acts differently on each.
 *
 * ⚠️ **Written out rather than derived from `KEYGRIP_POLL_MS`**, even though it is twelve times it:
 * `watchKeygrip` imports this module, so importing the constant back would be a cycle — and one whose
 * failure is a top-level `undefined`, which reaches Redis as an expiry of `NaN` rather than as an error.
 * If the poll interval ever changes, change this with it.
 */
export const KEYGRIP_HOLDER_TTL_SECONDS = 3_600

/**
 * The two verbs writing a holders row needs.
 *
 * `hExpire` is Redis 7.4's per-field TTL — the platform runs 7.4 (`marketplace-docker-DBs/docker-compose.yml`). Per
 * *field*, not per key: one expiry on the hash would take the whole table with it, including the rows of
 * every service that is still alive.
 */
export interface IKeygripHolderStore {
	hSet(key: string, field: string, value: string): Promise<unknown>
	hExpire(key: string, fields: string, seconds: number): Promise<unknown>
}

/**
 * Says "this service is holding this key set, and it was alive just now" (ADR-034).
 *
 * ⚠️ **Two readers of one string, so the format lives in one place.** `loadKeygrip` writes a row at boot
 * and on every live swap; `watchKeygrip` rewrites it on every poll that finds nothing changed. The second
 * is what makes the timestamp a heartbeat rather than a boot stamp — without it a service that came up in
 * March and never rotated would report "last seen: March", and `keygripStatus` could not tell it apart
 * from one that has been down since March.
 *
 * `<fingerprint>@<ISO-8601>`, one field per service. The fingerprint is over the key *ids* and is safe in
 * the clear — see `keygripFingerprint` — and no part of this row is derived from key material.
 *
 * ⚠️ **The expiry is set after the write and every time**, not once when the field is created: `HSET` on
 * an existing field leaves its TTL alone in some Redis versions and clears it in others, and a row whose
 * expiry was set once at boot would vanish from under a service that is still heartbeating. Refreshing it
 * on each write makes the row's lifetime a property of the last heartbeat, which is the only thing it is
 * supposed to describe.
 */
export const recordKeygripHolder = async (store: IKeygripHolderStore, serviceName: string, fp: string) => {
	await store.hSet(keygripHoldersKey(), serviceName, `${fp}@${new Date().toISOString()}`)

	return store.hExpire(keygripHoldersKey(), serviceName, KEYGRIP_HOLDER_TTL_SECONDS)
}
