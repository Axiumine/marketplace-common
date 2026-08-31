import { retireAccessSession, sessionIndexKey, sessionKeyFromIndexField } from '@others/sessionKeys.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The four commands a revocation issues, and nothing else. A parameter rather than an import, for the
 * reason spelled out on `ISessionReadStore`: importing the client would make a Redis install a
 * precondition for importing a Mongoose model.
 *
 * ⚠️ **`hKeys` and never `SCAN` or `KEYS`** (BCON-08). One account's sessions are one hash — one key, one
 * round trip, one slot on a cluster. A keyspace scan would be O(keyspace) here and simply wrong there.
 *
 * ⚠️ **`hGet` reads exactly one field of one session hash and nothing else** (R54). It is what lets a
 * revocation end the access half of a session it holds no token for, and it is deliberately not `hGetAll`:
 * a routine that only has to retire a key has no business reading an account id, a lineage or anything
 * else out of a session on its way past.
 */
export interface ISessionRevokeStore {
	hKeys(key: string): Promise<string[]>
	hGet(key: string, field: string): Promise<string | null>
	del(key: string): Promise<unknown>
	hDel(key: string, field: string): Promise<unknown>
}

/**
 * How many times the routine will re-read the index and revoke what appeared while it was working.
 *
 * Three, and the number matters less than the fact that there is one: each round is a full revoke of
 * whatever the previous round did not know about, so a login has to land inside the round *and* the round
 * after it *and* the one after that to survive — against a window that is one `hKeys` plus N `del`s wide.
 * Unbounded would be worse than three: an account being logged into in a loop would keep this routine
 * spinning inside a request, and a caller waiting forever to be told an account is closed is a caller that
 * eventually gives up believing it.
 */
export const REVOKE_INDEX_REREAD_ATTEMPTS = 3

/**
 * Which account is being logged out. **Both halves, always** — ids come from three separate collections
 * and nothing stops two of them minting the same `ObjectId` string, so a revocation by id alone could end
 * a stranger's sessions.
 */
export interface IRevokeTarget {
	tier: Tier
	accountId: string
}

/**
 * Ends every session an account holds, and answers how many there were.
 *
 * The one routine the platform revokes through: a password change, a disable, a status change and an
 * admin's console call are four callers, and four hand-written versions of this would be four chances
 * to get the command shape subtly wrong in a way that fails open.
 *
 * ⚠️ **The index key is deleted last, after every session it names.** The other order is the one that
 * fails badly: a process death between the two would leave live refresh tokens with nothing naming them —
 * unrevocable, unlistable, and alive until their own cap. This order leaves at worst an index naming keys
 * that are already gone, which the next call cleans up and which grants nobody anything. A revocation
 * that is interrupted is therefore safe to simply run again.
 *
 * ⚠️ **The index is re-read before it is deleted, and deleted only if nothing appeared.** A login
 * landing between the `hKeys` and the `del` would otherwise have its index field destroyed while its session
 * stayed live: an **invisible session** — not listable, not revocable, and alive until its own cap, which is
 * the one outcome strictly worse than not revoking at all. When the re-read finds newcomers, the routine
 * `hDel`s exactly the fields it revoked and goes round again on the rest, so the index is only ever narrowed
 * to what is genuinely still open.
 *
 * ⚠️ **On exhaustion the index key is left in place**, holding the fields this routine did not revoke. An
 * index naming a live session is recoverable — the next call revokes it — and a deleted index is not. The
 * count returned is what was actually revoked across every round, so a caller that reports "N sessions
 * ended" is never reporting a session that is still open.
 *
 * ⚠️ **One single-key `del` per session, never one `del` with many keys** (BCON-08). The digests of one
 * account's sessions land in different slots on a cluster, where a multi-key `del` across slots is refused
 * outright — and it would be refused *after* the caller had been told the account was logged out.
 *
 * ⚠️ **Both halves of every session go, and the access half goes first** (R54, 2026-08-13). Only the
 * refresh session is indexed (see `indexSession`), and an access session key is the digest of a different
 * string — unreachable from the field this reads, and reachable from the session hash that field names,
 * which is why `retireAccessSession` runs while that hash is still there. Until this call read it, a
 * password change, a disable and an admin's "end session" all left a usable access token behind for up
 * to 91 minutes.
 *
 * ⚠️ **A session whose access half cannot be retired is still revoked.** A hash minted before `accessKey`
 * existed carries none and one that expired on its own is gone entirely; both answer `null` and neither
 * stops the `del` that follows. The old behaviour is therefore the floor, never the outcome of a failure
 * to read.
 *
 * An empty or missing index issues no command at all and answers `0` — the account had nothing open, and
 * Redis drops a hash the moment its last field goes, so there is no empty key left to tidy.
 */
export async function revokeAllSessionsForAccount({
	store,
	tier,
	accountId
}: IRevokeTarget & { store: ISessionRevokeStore }): Promise<number> {
	const indexKey = sessionIndexKey(tier, accountId)
	const revoked = new Set<string>()
	let pending = await store.hKeys(indexKey)

	for (let attempt = 0; attempt < REVOKE_INDEX_REREAD_ATTEMPTS && pending.length > 0; attempt++) {
		const batch = pending

		await Promise.all(
			batch.map(async (field) => {
				const key = sessionKeyFromIndexField(field)

				// The access half before the refresh half, because the name of the first is stored inside the
				// second — see `retireAccessSession`, which is also where the crash-order argument lives.
				await retireAccessSession(store, key)
				await store.del(key)
			})
		)
		batch.forEach((field) => revoked.add(field))

		pending = (await store.hKeys(indexKey)).filter((field) => !revoked.has(field))

		if (pending.length === 0) {
			await store.del(indexKey)

			return revoked.size
		}

		// Newcomers exist, so the key must survive — but the sessions just ended must stop being listed as
		// open. One `hDel` per field, for the reason the `del`s above are one per key, and only this round's
		// batch: earlier rounds already pruned theirs.
		await Promise.all(batch.map((field) => store.hDel(indexKey, field)))
	}

	return revoked.size
}
