import { IReuseEventAccount, IReuseEventStore, recordReuseEvent } from '@others/recordReuseEvent.mjs'
import { ReuseEventAction } from '@others/ReuseEventAction.mjs'
import { familyKey } from '@others/sessionKeys.mjs'

/**
 * The Redis commands revocation issues, and nothing else. Parameters rather than an import, for the
 * reason spelled out on `ISessionReadStore` — which extends this interface, so the resolver hands its own
 * store straight through and there is one injection point rather than two.
 *
 * It **extends** `IReuseEventStore` rather than taking a second store: the trail is written by this
 * function, on the same client, on the same request. A second parameter would mean passing one object
 * twice at every call site to buy a segregation nothing consumes.
 */
export interface ISessionFamilyStore extends IReuseEventStore {
	sMembers(key: string): Promise<string[]>
	del(key: string): Promise<unknown>
}

/**
 * Destroys every session key descended from one login, and records why.
 *
 * The set at `family:<familyId>` names **fully-qualified Redis keys** — the digests `sessionKey` built, not
 * the tokens they were built from. That is what lets this walk `del` its members directly: a set of tokens
 * would have to re-hash each one here, and would be a list of live credentials sitting in the store.
 *
 * ⚠️ **One single-key `del` per member (BCON-08), never one `del` with N arguments.** The members hash to
 * different slots, so a multi-key delete works on this single node and fails on a cluster — the kind of
 * change that is invisible until the day the store grows a second node, which is the wrong day to discover
 * that revocation is the thing that broke.
 *
 * ⚠️ **The family key goes last.** It is the only record of what remains to be deleted; removing it first
 * turns a mid-way failure into a lineage nobody can finish revoking. Reversed, the retry has nothing to
 * read.
 *
 * ⚠️ **The event is appended after the revocation, and the revocation does not depend on it.**
 * This is the request that discovered a theft: the sessions must die whatever the trail does. Recording
 * first would let a failed append leave a trail claiming a logout that did not happen — an explanation
 * that is wrong, which is worse for the admin than no explanation at all.
 *
 * ⚠️ **An unattributable revocation still revokes, and writes nothing.** `account` is `undefined` when the
 * tombstone that triggered this was written before the account was put on it. Filing that event anyway
 * would need an account id invented here, and an invented one names a trail key no console reads. The
 * security action never degrades; only its explanation does, and only for tombstones older than the deploy.
 *
 * A member that is already gone is a Redis no-op, so a family whose sessions expired on their own revokes
 * quietly rather than throwing — this runs on the request that discovered a theft, and that request must
 * reach its own `throw` rather than die of a missing key.
 */
export async function revokeSessionFamily({
	store,
	familyId,
	account,
	action
}: {
	store: ISessionFamilyStore
	familyId: string
	/** Whose lineage this was, or `undefined` when the record that named it predates the reuse trail. */
	account: IReuseEventAccount | undefined
	action: ReuseEventAction
}) {
	const key = familyKey(familyId)
	const members = await store.sMembers(key)

	await Promise.all(members.map((member) => store.del(member)))

	await store.del(key)

	if (account === undefined) return

	await recordReuseEvent({
		store,
		event: { familyId, tier: account.tier, accountId: account.accountId, action, at: `${Date.now()}` }
	})
}
