import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	ISessionRevokeStore,
	REVOKE_INDEX_REREAD_ATTEMPTS,
	revokeAllSessionsForAccount
} from '../src/others/revokeAllSessionsForAccount.mts'
import { TIER } from '../src/others/Tier.mts'

const REDIS_KEY = 'test:'
const ACCOUNT_ID = '68a1c2d3e4f5a6b7c8d9e0f1'
const INDEX_KEY = `${REDIS_KEY}idx:shopOwner:${ACCOUNT_ID}`

// What the index actually holds: the *body* of each session key, which is the digest of the prefixed
// refresh token. Three of them, so "one del per field" cannot pass by accident on a single-element array.
const FIELDS = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
const SESSION_KEYS = FIELDS.map((field) => `${REDIS_KEY}${field}`)

/*
 * The access key a session hash records (R54). Uppercase, so it is unmistakably *not* derivable from the
 * field the routine holds: the only way to name it is to read it, which is the whole mechanism.
 */
const accessKeyOf = (sessionKey: string) => sessionKey.toUpperCase()
const ACCESS_KEYS = SESSION_KEYS.map(accessKeyOf)

/*
 * ⚠️ The stub carries `hKeys`, `hGet`, `del` and `hDel` and nothing else — no `hGetAll`, no `sMembers`. The
 * routine is reachable with a store that cannot read a session *whole*, which is what keeps a caller from
 * being handed capabilities it has no business holding just to log an account out: one named field of one
 * hash is the entire read surface. `hDel` prunes; it cannot read either.
 */
const store = (
	over: Partial<ISessionRevokeStore> = {}
): ISessionRevokeStore & { [K in keyof ISessionRevokeStore]: ReturnType<typeof vi.fn> } => ({
	hKeys: vi.fn(async () => FIELDS),
	hGet: vi.fn(async (key: string) => accessKeyOf(key)),
	del: vi.fn(async () => 1),
	hDel: vi.fn(async () => 1),
	...over
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('revokeAllSessionsForAccount', () => {
	/*
	 * ⚠️ One `del` per field, each with exactly one key (BCON-08). The argument *count* is asserted and not
	 * only the key set: `del(...keys)` would satisfy a laxer test, work on this single node, and fail the
	 * day the store becomes a cluster — where an account's digests land in different slots and a cross-slot
	 * delete is refused after the caller has already been told the account is logged out.
	 */
	it('deletes every session with its own single-key del, and the index key last', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(
			FIELDS.length
		)

		// Twice, both on the same key: once to learn what to revoke, once to confirm nothing appeared while it
		// was revoking. The second read is what licenses the `del` of the index key at the end.
		expect(s.hKeys.mock.calls).toEqual([[INDEX_KEY], [INDEX_KEY]])
		expect(s.del.mock.calls).toEqual([
			[ACCESS_KEYS[0]],
			[ACCESS_KEYS[1]],
			[ACCESS_KEYS[2]],
			[SESSION_KEYS[0]],
			[SESSION_KEYS[1]],
			[SESSION_KEYS[2]],
			[INDEX_KEY]
		])
		expect(s.del.mock.calls.every((call) => call.length === 1)).toBe(true)
		expect(s.hDel).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Both halves of every session, and the access half first (R54). The order is the assertion and not a
	 * detail: `accessKey` lives inside the refresh hash, so a routine that deleted the session first would
	 * have nothing left to read and would leave the access token answering 200 for up to 91 minutes — the
	 * residual this loop carried until 2026-08-13.
	 */
	it('retires the access token of every session it revokes, before the session itself', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })

		expect(s.hGet.mock.calls).toEqual(SESSION_KEYS.map((key) => [key, 'accessKey']))

		const keys = s.del.mock.calls.map(([key]) => key)

		ACCESS_KEYS.forEach((access, i) => {
			expect(keys.indexOf(access)).toBeLessThan(keys.indexOf(SESSION_KEYS[i]))
		})
	})

	/*
	 * A session that carries no bound key is revoked exactly as it always was. Two ordinary shapes answer
	 * `null` here — a hash minted before the field existed, and one that expired between the index read and
	 * the delete — and neither may cost the session its revocation or turn into a `del` of the bare prefix.
	 */
	it('revokes sessions that carry no bound access key, deleting only the sessions', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async () => null) })

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(
			FIELDS.length
		)

		expect(s.del.mock.calls).toEqual([[SESSION_KEYS[0]], [SESSION_KEYS[1]], [SESSION_KEYS[2]], [INDEX_KEY]])
	})

	/*
	 * ⚠️ The order is what makes an interrupted revocation safe to retry. The index is the only record of
	 * what is left to delete: removing it first turns a process death mid-walk into live refresh tokens that
	 * nothing names — unlistable, unrevocable, and alive until their own cap.
	 */
	it('never deletes the index key before a session it names', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })

		const keys = s.del.mock.calls.map(([key]) => key)

		expect(keys.indexOf(INDEX_KEY)).toBe(keys.length - 1)
	})

	/*
	 * ⚠️ The field *is* the session key body, so the key to delete is the prefix and the field verbatim.
	 * Hashing it again would digest a digest and name a key that has never existed — a revocation that
	 * answers success having deleted nothing, which is the one failure mode this routine must not have.
	 */
	it('rebuilds the session key from the field, hashing nothing again', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })

		// The session `del`s follow the access-key ones, so the slice starts where those end.
		expect(s.del.mock.calls.slice(FIELDS.length, FIELDS.length * 2).flat()).toEqual(SESSION_KEYS)
	})

	/*
	 * ⚠️ The tier is half the index key, not decoration. Three collections mint `_id`s independently and
	 * nothing stops two of them producing the same string, so a revocation keyed by id alone would end a
	 * stranger's sessions — which is why the same account id under a different tier must read a different
	 * key.
	 */
	it('scopes the index key by tier as well as by account', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revokeAllSessionsForAccount({ store: s, tier: TIER.user, accountId: ACCOUNT_ID })

		expect(s.hKeys.mock.calls).toEqual([[`${REDIS_KEY}idx:user:${ACCOUNT_ID}`], [`${REDIS_KEY}idx:user:${ACCOUNT_ID}`]])
	})

	/*
	 * ⚠️ An empty index issues no command at all — **unlike `revokeSessionFamily`, which deletes its set key
	 * regardless**, and the difference is deliberate. A family set has no per-field TTL and would otherwise
	 * accumulate one dead set per login; an index hash has one on every field and Redis drops the
	 * hash itself the moment the last one goes. There is nothing left to tidy, so tidying it would be a
	 * write issued on the strength of a guess.
	 *
	 * A missing index and an empty one are the same answer here: `hKeys` on a key that does not exist
	 * returns an empty array rather than throwing, which is why one branch covers both.
	 */
	it('issues no del at all for an account with no live sessions', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hKeys: vi.fn(async () => []) })

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.admin, accountId: ACCOUNT_ID })).resolves.toBe(0)

		expect(s.del).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ Idempotent, because every caller of this is allowed to retry. A password change that failed after
	 * the revocation and before its own write will run this again, and the second run must be a quiet no-op
	 * rather than an error the user sees.
	 */
	it('is idempotent — the second call revokes nothing and throws nothing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const remaining = [FIELDS, []]
		const s = store({ hKeys: vi.fn(async () => remaining.shift() ?? []) })

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(
			FIELDS.length
		)
		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(0)

		// Two `del`s per session — the access half and the refresh half — plus the index key, once.
		expect(s.del).toHaveBeenCalledTimes(FIELDS.length * 2 + 1)
	})

	/*
	 * A session that expired on its own between the index read and the delete is a Redis no-op, not a
	 * failure. This runs inside a credential write — a password change, a disable — and dying on a key that
	 * was already gone would fail the very operation whose whole point was to end those sessions.
	 */
	it('revokes sessions that are already gone, without throwing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ del: vi.fn(async () => 0) })

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(
			FIELDS.length
		)

		expect(s.del).toHaveBeenCalledTimes(FIELDS.length * 2 + 1)
	})

	/*
	 * ⚠️ The race the re-read exists for, simulated directly: a login lands between the first `hKeys` and the
	 * delete of the index key. Deleting the index there would destroy the only record naming a session that is
	 * genuinely still open — an **invisible session**, live until its own cap, listable by nobody and
	 * revocable by nobody. Strictly worse than not having revoked at all, which is why the index key is
	 * deleted only against an unchanged read.
	 */
	it('does not delete the index key while a newcomer is in it, and revokes the newcomer on the next round', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const NEWCOMER = 'd'.repeat(64)
		const reads = [FIELDS, [...FIELDS, NEWCOMER], [...FIELDS, NEWCOMER]]
		const s = store({ hKeys: vi.fn(async () => reads.shift() ?? []) })

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(
			FIELDS.length + 1
		)

		// The order is the assertion: three sessions, then the newcomer's, and only then the index key. Had the
		// index key been deleted on the first round it would sit at position 3, before the newcomer was reached.
		expect(s.del.mock.calls).toEqual([
			[ACCESS_KEYS[0]],
			[ACCESS_KEYS[1]],
			[ACCESS_KEYS[2]],
			[SESSION_KEYS[0]],
			[SESSION_KEYS[1]],
			[SESSION_KEYS[2]],
			[accessKeyOf(`${REDIS_KEY}${NEWCOMER}`)],
			[`${REDIS_KEY}${NEWCOMER}`],
			[INDEX_KEY]
		])
		// Exactly the fields this round revoked are pruned — the newcomer's is left listed, because at that
		// moment its session is still open and the index is the only thing that can name it.
		expect(s.hDel.mock.calls).toEqual(FIELDS.map((field) => [INDEX_KEY, field]))
	})

	/*
	 * ⚠️ On exhaustion the index key survives, holding what was not reached. An index naming a live session is
	 * recoverable — the next caller revokes it, and the per-field TTL expires it regardless — while a
	 * destroyed index is recoverable by nothing. The count answered is what was actually revoked, so a caller
	 * reporting "N sessions ended" never names a session that is still open.
	 *
	 * The bound itself is asserted twice over: on the constant's value, and on the number of reads the routine
	 * is willing to make against an index that never settles.
	 */
	it("leaves the index key in place when the bound is exhausted, and prunes only each round's own batch", async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		// A login lands before every single read, so the index never settles and the loop can only end on its
		// bound.
		let born = 0
		const live = [...FIELDS]
		const s = store({
			hKeys: vi.fn(async () => {
				const snapshot = [...live]

				live.push(String(born++).padEnd(64, 'z'))

				return snapshot
			})
		})

		await expect(revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })).resolves.toBe(5)

		expect(REVOKE_INDEX_REREAD_ATTEMPTS).toBe(3)
		expect(s.hKeys).toHaveBeenCalledTimes(REVOKE_INDEX_REREAD_ATTEMPTS + 1)
		expect(s.del.mock.calls.flat()).not.toContain(INDEX_KEY)
		expect(s.del.mock.calls).toEqual([
			[ACCESS_KEYS[0]],
			[ACCESS_KEYS[1]],
			[ACCESS_KEYS[2]],
			[SESSION_KEYS[0]],
			[SESSION_KEYS[1]],
			[SESSION_KEYS[2]],
			[accessKeyOf(`${REDIS_KEY}${'0'.padEnd(64, 'z')}`)],
			[`${REDIS_KEY}${'0'.padEnd(64, 'z')}`],
			[accessKeyOf(`${REDIS_KEY}${'1'.padEnd(64, 'z')}`)],
			[`${REDIS_KEY}${'1'.padEnd(64, 'z')}`]
		])
		// Five prunes and not twelve: each round `hDel`s the batch it just revoked, never the whole revoked set
		// again. Re-pruning is harmless in Redis and dishonest in a log — it claims work that was already done.
		expect(s.hDel.mock.calls).toEqual([
			[INDEX_KEY, FIELDS[0]],
			[INDEX_KEY, FIELDS[1]],
			[INDEX_KEY, FIELDS[2]],
			[INDEX_KEY, '0'.padEnd(64, 'z')],
			[INDEX_KEY, '1'.padEnd(64, 'z')]
		])
	})

	// BCON-08 asserted on the diff rather than trusted: no command this routine issues names more than one
	// key, and `hKeys` reads one hash rather than scanning a keyspace. `hDel` takes two arguments and one of
	// them is a field, so it is asserted on its key argument rather than on its arity.
	it('never issues a command with more than one key', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const NEWCOMER = 'd'.repeat(64)
		const reads = [FIELDS, [...FIELDS, NEWCOMER], [...FIELDS, NEWCOMER]]
		const s = store({ hKeys: vi.fn(async () => reads.shift() ?? []) })

		await revokeAllSessionsForAccount({ store: s, tier: TIER.shopOwner, accountId: ACCOUNT_ID })

		expect([...s.hKeys.mock.calls, ...s.del.mock.calls].every((call) => call.length === 1)).toBe(true)
		expect(s.hDel.mock.calls.every((call) => call.length === 2 && call[0] === INDEX_KEY)).toBe(true)
		// `hGet` is the same shape as `hDel`: one key, one field, and the field is always the same one.
		expect(s.hGet.mock.calls.every((call) => call.length === 2 && call[1] === 'accessKey')).toBe(true)
	})
})
