import { ReuseEventAction } from '@others/ReuseEventAction.mjs'
import { reuseEventsKey, SESSION_INDEX_TTL_SECONDS } from '@others/sessionKeys.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The three commands the reuse trail is written with, and nothing else. Parameters rather than an import,
 * for the reason spelled out on `ISessionReadStore`.
 *
 * ⚠️ **Three single-key commands** (BCON-08). A list, not a stream and not a sorted set: the trail is read
 * whole, newest first, by one console screen, and a structure with range semantics would buy queries nobody
 * issues at the cost of a second thing to bound.
 */
export interface IReuseEventStore {
	lPush(key: string, element: string): Promise<unknown>
	lTrim(key: string, start: number, stop: number): Promise<unknown>
	expire(key: string, seconds: number): Promise<unknown>
}

/**
 * How many events one account's trail keeps. The list is trimmed to this on every append, so the bound
 * holds by construction rather than by a sweep that has to be scheduled and could be skipped.
 *
 * Fifty, because the trail exists to explain a mass logout to an admin reading it now, and the fifty
 * most recent events cover every investigation this platform can currently ask for. An account generating
 * more than fifty in a retention window is telling the admin something on its own.
 */
export const REUSE_EVENTS_MAX = 50

/**
 * How long a trail survives its last event.
 *
 * ⚠️ **Thirty days from the last append, not from the first** — `expire` is reissued on every event, so a
 * trail that is still being written to does not age out mid-incident. E17's open question 2 asked for a
 * retention long enough to investigate and short enough not to become its own data-protection surface;
 * thirty days is E15's own session-index figure, reused rather than reinvented so that a trail cannot
 * outlive the sessions it describes by an interval nobody chose.
 */
export const REUSE_EVENTS_TTL_SECONDS = SESSION_INDEX_TTL_SECONDS

/** The account a trail belongs to. Both halves, for the reason `sessionIndexKey` gives: ids collide across tiers. */
export interface IReuseEventAccount {
	tier: Tier
	accountId: string
}

/**
 * One line of the trail, as it is stored and as the console reads it.
 *
 * ⚠️ **No token, no digest of one, no prefix of one, and nothing network-derived.** The four fields are the
 * whole contract: a lineage id that grants nothing, the action from the shared vocabulary, when it happened,
 * and — through the key it is filed under — whose it was. A dump of this store must stay useless to whoever
 * reads it, which is the same rule E13 imposed on session keys and E14-S04 on tombstones.
 *
 * `at` is epoch millis written out as a string, because a Redis value is a string and a number here would
 * be a number in this process and a string in the next one.
 */
export interface IReuseEvent {
	familyId: string
	tier: Tier
	accountId: string
	action: ReuseEventAction
	at: string
}

/**
 * Appends one event to an account's trail (E17-S05).
 *
 * Three commands, in the only order that keeps the bound true at every instant: push, trim, then re-arm the
 * expiry. Trimming before pushing would leave the list one over its bound for the width of a round trip,
 * and setting the TTL first would leave a trail that was appended to after its own deadline was fixed.
 *
 * ⚠️ **A revocation is never conditional on this landing.** The caller records *after* revoking, so a store
 * that refuses the append leaves sessions ended and an admin without an explanation — the survivable
 * failure. The other order would let a failed write leave a trail claiming a logout that never happened,
 * which is worse than silence: it is an explanation that is wrong.
 */
export async function recordReuseEvent({ store, event }: { store: IReuseEventStore; event: IReuseEvent }): Promise<void> {
	const key = reuseEventsKey(event.tier, event.accountId)

	await store.lPush(key, JSON.stringify(event))
	await store.lTrim(key, 0, REUSE_EVENTS_MAX - 1)
	await store.expire(key, REUSE_EVENTS_TTL_SECONDS)
}
