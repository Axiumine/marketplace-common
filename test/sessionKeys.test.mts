import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashSessionToken } from '../src/others/hashSessionToken.mts'
import { IRefreshData } from '../src/others/IRefreshData.mts'
import {
	deleteSession,
	familyKey,
	graceHitsKey,
	indexSession,
	ISessionIndexPruneStore,
	ISessionIndexStore,
	ISessionKeyStore,
	keygripChannel,
	keygripHoldersKey,
	keygripKey,
	readSessionField,
	readSessionHash,
	retireAccessSession,
	reuseEventsKey,
	SESSION_INDEX_TTL_SECONDS,
	sessionIndexKey,
	sessionKey,
	sessionKeyFromIndexField,
	tombstoneKey,
	unindexSession
} from '../src/others/sessionKeys.mts'
import { TIER } from '../src/others/Tier.mts'

const REDIS_KEY = 'test:'

// The prefixed token, which is what every reader presents and therefore what gets hashed. Its digest is
// written out as a literal, computed elsewhere: a test that hashed the token with the same call the
// implementation makes would agree with it about any algorithm, including a mutated one.
const TOKEN = 'refresh:refresh-token-1'
const DIGEST = '75f795d1820581753bbd527fcaca37ff850fa290cdb00bc81bab995b93931a11'

const ACCOUNT_ID = '68b0f2c1a2b3c4d5e6f70819'

const store = (
	over: Partial<ISessionKeyStore> = {}
): ISessionKeyStore & { [K in keyof ISessionKeyStore]: ReturnType<typeof vi.fn> } => ({
	hGetAll: vi.fn(async () => ({})),
	hGet: vi.fn(async () => null),
	del: vi.fn(async () => 1),
	...over
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('hashSessionToken', () => {
	// ⚠️ The whole point of the hashed namespace, as an assertion: the key body is a digest, and the token
	// does not
	// appear in it. A dump, an AOF file or a MONITOR transcript used to be a list of live credentials in
	// plain text.
	it('digests the prefixed token to the known SHA-256, and never carries it through', () => {
		expect(hashSessionToken(TOKEN)).toBe(DIGEST)
		expect(hashSessionToken(TOKEN)).not.toContain('refresh-token-1')
	})

	// Lower-case hex, 64 characters of it. The encoding is part of the key format: a base64 digest would
	// still be a digest while silently changing every key on the platform.
	it('returns 64 lower-case hex characters', () => {
		expect(hashSessionToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
	})

	// ⚠️ The prefix is part of the input, not decoration around it. Hashing the bare uuid would mint keys
	// no reader can ever find, and the platform would authenticate nobody — a failure that looks like
	// "Redis lost the sessions" rather than like a bug here.
	it('is a different key for the same uuid under a different prefix', () => {
		expect(hashSessionToken('refresh:refresh-token-1')).not.toBe(hashSessionToken('refresh-token-1'))
		expect(hashSessionToken('access:refresh-token-1')).not.toBe(hashSessionToken('refresh:refresh-token-1'))
	})
})

describe('the session key builders', () => {
	// The prefix stays shared by all nine services (CON-04): the single logout service finds a session by
	// token content alone, so a per-service prefix would leave it unable to revoke what it did not mint.
	it('builds the written key from the shared prefix and the digest', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(sessionKey(TOKEN)).toBe(`${REDIS_KEY}${DIGEST}`)
	})

	/*
	 * ⚠️ **The digest is the only shape a session key has.** There is no builder for the raw-token
	 * shape any more, and this asserts the property that made removing it safe: nothing this module can
	 * build ever contains the credential the caller presented.
	 *
	 * Asserted over the builders rather than over the deleted export, because a deleted export cannot be
	 * tested and a reintroduced one — under any name — would fail here.
	 */
	it('never puts the token itself into any key it builds', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		for (const key of [sessionKey(TOKEN), tombstoneKey(TOKEN), sessionKeyFromIndexField(hashSessionToken(TOKEN))])
			expect(key).not.toContain('refresh-token-1')
	})

	/*
	 * ⚠️ The counter is a count and nothing else — no key, no token, no identifier. Putting a session key in
	 * its name would undo the hashed namespace: the raw key *is* the credential, and a diagnostic that
	 * recorded it would
	 * put back into Redis exactly what hashing took out.
	 *
	 * It is also not confusable with a session: a digest is 64 hex characters and this is a word.
	 */
	it('names the grace counter with a word, not with anything a session key could be', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(graceHitsKey()).toBe(`${REDIS_KEY}grace-hits`)
		expect(graceHitsKey()).not.toMatch(/[0-9a-f]{64}/)
	})

	/*
	 * ⚠️ The three keygrip names share one prefix on purpose: the record, the holders table and the
	 * rotation channel are one namespace an admin can list, delete and reason about together (ADR-034).
	 * Asserted as literals because a service that read a *different* key from the one the seed script wrote
	 * would report the record missing and refuse to boot — with nothing in the message hinting that the two
	 * halves simply disagree about the name.
	 */
	it('names the keygrip record, its holders table and its rotation channel under one prefix', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(keygripKey()).toBe(`${REDIS_KEY}keygrip`)
		expect(keygripHoldersKey()).toBe(`${REDIS_KEY}keygrip:holders`)
		expect(keygripChannel()).toBe(`${REDIS_KEY}keygrip:rotated`)
	})

	// Three distinct names, none of them a digest: a hash, a hash and a pub/sub channel, never the same key.
	it('keeps the three keygrip names distinct and free of any digest', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(new Set([keygripKey(), keygripHoldersKey(), keygripChannel()]).size).toBe(3)
		expect(keygripKey()).not.toMatch(/[0-9a-f]{64}/)
		expect(keygripHoldersKey()).not.toMatch(/[0-9a-f]{64}/)
		expect(keygripChannel()).not.toMatch(/[0-9a-f]{64}/)
	})

	/*
	 * ⚠️ The tombstone is keyed by the same digest as the session it replaces, under its own namespace. The
	 * digest is asserted twice — once as the literal, once as the shape after the prefix — because the hashed
	 * namespace is undone the moment a *new* key shape carries a token in the clear, and this is the first new
	 * shape added since it landed.
	 */
	it('builds the tombstone key from the prefix, the word and the digest', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(tombstoneKey(TOKEN)).toBe(`${REDIS_KEY}used:${DIGEST}`)
		expect(tombstoneKey(TOKEN).slice(`${REDIS_KEY}used:`.length)).toMatch(/^[0-9a-f]{64}$/)
		expect(tombstoneKey(TOKEN)).not.toContain('refresh-token-1')
	})

	// Distinct namespaces for the same token: the live session and its tombstone coexist for the width of
	// the rotation, and one key serving both would delete the marker with the session it marks.
	it('never collides with the session key for the same token', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(tombstoneKey(TOKEN)).not.toBe(sessionKey(TOKEN))
	})

	// The lineage id goes in as it is — see the note on the builder. Asserting the token does not appear is
	// the half that matters: a familyId derived from a token would read as a plain uuid here and would not.
	it('builds the family key from the prefix, the word and the lineage id', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(familyKey('4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d')).toBe(`${REDIS_KEY}family:4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d`)
	})

	/*
	 * ⚠️ Tier-segmented for the same reason `sessionIndexKey` is: the three collections mint ids
	 * independently, so an `admin` and a `user` whose ids collided would share one trail — and the console
	 * would show one account another account's revocations.
	 */
	it('names one reuse trail per account, per tier', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(reuseEventsKey(TIER.user, ACCOUNT_ID)).toBe(`${REDIS_KEY}reuse:user:${ACCOUNT_ID}`)
		expect(reuseEventsKey(TIER.admin, ACCOUNT_ID)).toBe(`${REDIS_KEY}reuse:admin:${ACCOUNT_ID}`)
		expect(reuseEventsKey(TIER.user, ACCOUNT_ID)).not.toBe(reuseEventsKey(TIER.admin, ACCOUNT_ID))
	})

	// A trail and an index for the same account are two different structures — a list and a hash — and Redis
	// refuses the second command outright if one key were to serve both, which is a runtime failure on the
	// request that discovered a theft.
	it('never collides with the session index for the same account', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(reuseEventsKey(TIER.shopOwner, ACCOUNT_ID)).not.toBe(sessionIndexKey(TIER.shopOwner, ACCOUNT_ID))
	})
})

describe('readSessionHash', () => {
	const hash = { _id: '68b0f2c1a2b3c4d5e6f70819', tier: 'shopOwner' }

	// The only state there is: one round trip, to the hashed key, and the raw key is never
	// named at all.
	it('reads the hashed key, once, and stops there', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGetAll: vi.fn(async () => hash) })

		await expect(readSessionHash(s, TOKEN)).resolves.toBe(hash)

		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${DIGEST}`)
	})

	/*
	 * ⚠️ **The inverted dual-read test.** It used to seed an old-shape session and prove it still
	 * authenticated across the cutover; the same fixture now proves the opposite, which is the whole
	 * behavioural change removing the fallback made. A store that answers on the raw key and nowhere else is a
	 * pre-cutover session, and it must read as no session at all.
	 *
	 * Kept rather than deleted because the assertion that matters is not "the fallback is gone from the
	 * source" — grep says that — but "the raw key is not reachable through this helper by any path".
	 */
	it('does not read the raw key, so an old-shape session no longer authenticates', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGetAll: vi.fn(async (key: string) => (key === `${REDIS_KEY}${TOKEN}` ? hash : {})) })

		await expect(readSessionHash(s, TOKEN)).resolves.toEqual({})

		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${DIGEST}`)
	})

	// A missing digest is "no session", answered on one round trip. Two would mean a second shape is still
	// being consulted.
	it('answers an empty hash on a miss, without a second read', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await expect(readSessionHash(s, TOKEN)).resolves.toEqual({})

		expect(s.hGetAll).toHaveBeenCalledOnce()
	})

	/*
	 * ⚠️ **The empty hash is minted here, never the reply handed back.** `Object.keys(hash).length !== 0`
	 * is the only thing deciding that, and no shape assertion can see it — the reply and the hash this
	 * returns are both empty — so the assertion is identity.
	 *
	 * The fixture is the *odd* half of this helper's doc comment rather than a plain `{}`: an empty array
	 * has no keys either, so it takes the same exit, and a caller handed it back would be branching on
	 * `Array.isArray` where the signature promises a record. That is the difference between "your session
	 * expired" and an incident, which is the whole reason the two answers are made to converge here.
	 */
	it('mints the empty hash rather than passing an odd empty reply through', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const odd = [] as unknown as Record<string, string>
		const s = store({ hGetAll: vi.fn(async () => odd) })

		const read = await readSessionHash(s, TOKEN)

		expect(read).not.toBe(odd)
		expect(Array.isArray(read)).toBe(false)
		expect(read).toEqual({})
	})

	/*
	 * ⚠️ A nullish reply is a miss, not a crash. `Object.keys(null)` throws a `TypeError`, which the
	 * GraphQL layer answers with a 500 — so without the guard the difference between "your session
	 * expired" and "the platform is broken" would be decided by what the client handed back. The caller
	 * turns the empty hash into the 498 the client can act on by logging in again.
	 */
	it('treats a nullish reply as a miss rather than throwing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGetAll: vi.fn(async () => null) as unknown as ISessionKeyStore['hGetAll'] })

		await expect(readSessionHash(s, TOKEN)).resolves.toEqual({})
	})
})

describe('readSessionField', () => {
	// Same single read, one field at a time: the logout service reads `id` off a refresh hash and `_id`
	// off an access one rather than pulling either whole.
	it('reads the hashed key, once, and stops there', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async () => 'the-id') })

		await expect(readSessionField(s, TOKEN, '_id')).resolves.toBe('the-id')

		expect(s.hGet).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${DIGEST}`, '_id')
	})

	// The field-level half of the inverted dual-read test: a store holding the field under the raw key and
	// nothing under the digest answers `null`, because the raw key is never asked.
	it('does not read the raw key, so an old-shape field no longer resolves', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async (key: string) => (key === `${REDIS_KEY}${TOKEN}` ? 'the-id' : null)) })

		await expect(readSessionField(s, TOKEN, '_id')).resolves.toBeNull()

		expect(s.hGet).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${DIGEST}`, '_id')
	})

	// ⚠️ An empty string is a stored value, not a miss, and the helper must hand it back unchanged rather
	// than normalising it to `null` — a field written as `''` belongs to a live session.
	it('treats an empty stored field as a value, not as a miss', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async () => '') })

		await expect(readSessionField(s, TOKEN, '_id')).resolves.toBe('')

		expect(s.hGet).toHaveBeenCalledOnce()
	})
})

describe('deleteSession', () => {
	/*
	 * ⚠️ **One key, one command.** The second `del` this used to issue named the raw-token shape, which
	 * nothing has written since the cutover and nothing can read since the fallback went; issuing it now would
	 * be a round trip per logout and per rotation against a key that cannot exist.
	 *
	 * The call is still asserted as a single-key `del` rather than a multi-key one (BCON-08) — the shape
	 * that keeps working on a cluster, and the shape a second key would have to be added back as.
	 */
	it('deletes the digest, and only the digest', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await deleteSession(s, TOKEN)

		expect(s.del).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}${DIGEST}`)
	})
})

describe('retireAccessSession', () => {
	// A session key, as a revocation holds it: the prefix and an index field, with no token anywhere near it.
	const SESSION = `${REDIS_KEY}${DIGEST}`
	// The access key the hash records — a digest of a *different* string, which is the whole reason it has to
	// be read rather than derived.
	const ACCESS = `${REDIS_KEY}${'f'.repeat(64)}`

	/*
	 * ⚠️ The field name is asserted, not just the call: `hGet` on any other field answers `null` for every
	 * session on the platform, and the routine would then retire nothing while reporting nothing wrong.
	 *
	 * ⚠️ The stored value is deleted **verbatim**. It is already a full key; digesting it again would name a
	 * key that has never existed, and the failure would be silent in exactly the way a revocation must not be.
	 */
	it('reads accessKey off the session it is given and deletes that key, unhashed', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async () => ACCESS) })

		await retireAccessSession(s, SESSION)

		expect(s.hGet).toHaveBeenCalledExactlyOnceWith(SESSION, 'accessKey')
		expect(s.del).toHaveBeenCalledExactlyOnceWith(ACCESS)
	})

	/*
	 * ⚠️ `null` is two ordinary cases at once: a session minted before the field existed, and a session that
	 * expired between the index read and this call. Neither may issue a `del`, and a `del` of the bare prefix
	 * is what the unguarded version would issue — one key, wrong for every account on the platform.
	 */
	it('deletes nothing when the session carries no bound access key', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await retireAccessSession(s, SESSION)

		expect(s.hGet).toHaveBeenCalledOnce()
		expect(s.del).not.toHaveBeenCalled()
	})

	// An empty stored value names no key either — the same guard, and the case that separates `!accessKey`
	// from a `!= null` test that would send `''` to `del`.
	it('deletes nothing when the bound key is stored empty', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ hGet: vi.fn(async () => '') })

		await retireAccessSession(s, SESSION)

		expect(s.del).not.toHaveBeenCalled()
	})
})

describe('the session index', () => {
	const ID = '68b0f2c1a2b3c4d5e6f70819'
	const refreshData: IRefreshData = {
		_id: ID,
		tier: TIER.user,
		familyId: '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d',
		originalLogin: '1754784000000',
		sessionCapDays: '30'
	}

	const indexStore = (): ISessionIndexStore & { [K in keyof ISessionIndexStore]: ReturnType<typeof vi.fn> } => ({
		hSet: vi.fn(async () => 1),
		expire: vi.fn(async () => 1),
		hExpire: vi.fn(async () => [1])
	})

	/*
	 * The clock is pinned for every field-TTL assertion below. The remaining cap is a difference between
	 * `Date.now()` and a stored login, so a test that let the real clock run would assert a number that is
	 * one second different depending on when the suite happens to execute — and the usual fix, asserting a
	 * range, is exactly the assertion a mutated `Math.ceil` or a flipped sign survives.
	 */
	const NOW = 1_754_784_000_000
	/** `originalLogin` a day before `NOW`, so a 30-day cap has 29 days left and a 1-day cap has none. */
	const DAY_OLD_LOGIN = `${NOW - 24 * 60 * 60 * 1000}`
	/** Twenty-nine days in seconds. A literal, so a mutated constant moves one side of the assertion only. */
	const TWENTY_NINE_DAYS = 2_505_600

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	/*
	 * ⚠️ The tier is part of the key name, not decoration. The three collections mint ids independently and
	 * nothing stops two of them producing the same string; without the segment, an `admin` and a `user` who
	 * collided would share one index and a revocation would take a stranger's sessions with it.
	 */
	it('names one hash per account, per tier', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(sessionIndexKey(TIER.user, ID)).toBe(`${REDIS_KEY}idx:user:${ID}`)
		expect(sessionIndexKey(TIER.admin, ID)).toBe(`${REDIS_KEY}idx:admin:${ID}`)
		expect(sessionIndexKey(TIER.user, ID)).not.toBe(sessionIndexKey(TIER.admin, ID))
	})

	/*
	 * ⚠️ **The inverse of the field name, and it must stay exactly that.** `sessionKeyFromIndexField`
	 * is what a revocation rebuilds a key with, so the round trip is the contract: the field `indexSession`
	 * writes, prefixed, is the key `sessionKey` built for the same token. Anything applied to the field on the
	 * way back out — a second digest, a namespace word — names a key that has never existed, and the
	 * revocation reports success having deleted nothing.
	 */
	it('rebuilds the session key from the field it filed, exactly', () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		expect(sessionKeyFromIndexField(DIGEST)).toBe(`${REDIS_KEY}${DIGEST}`)
		expect(sessionKeyFromIndexField(hashSessionToken(TOKEN))).toBe(sessionKey(TOKEN))
	})

	/*
	 * ⚠️ **The field is the digest of the session key body, and that is the whole contract with revocation.**
	 * Revocation rebuilds the key to delete as `${REDIS_KEY}${field}` and never sees a token; a field hashed
	 * from the bare uuid would still be 64 hex characters, still pass a shape check, and name a key that
	 * does not exist — an index of sessions nothing can revoke, failing silently at the one moment it
	 * matters.
	 */
	it('files the session under the digest of its own key, and stores no token', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = indexStore()

		await indexSession(s, TOKEN, refreshData)

		expect(s.hSet).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, {
			[DIGEST]: JSON.stringify({ tier: TIER.user, mintedAt: '1754784000000' })
		})
		expect(`${sessionKey(TOKEN)}`).toBe(`${REDIS_KEY}${DIGEST}`)
		expect(JSON.stringify(s.hSet.mock.calls[0])).not.toContain('refresh-token-1')
	})

	/*
	 * ⚠️ The value describes the session to a human and carries nothing that could be presented as one.
	 * `Object.keys` is asserted whole so a fourth field cannot arrive without this failing — the admin session
	 * console renders this list, and the difference between a row and a credential is exactly this key set.
	 */
	it('stores the tier and the original login, and nothing else', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = indexStore()

		await indexSession(s, TOKEN, refreshData)

		const value = JSON.parse((s.hSet.mock.calls[0][1] as Record<string, string>)[DIGEST]!) as object

		expect(value).toEqual({ tier: TIER.user, mintedAt: '1754784000000' })
		expect(Object.keys(value)).toEqual(['tier', 'mintedAt'])
	})

	/*
	 * ⚠️ **The longer cap, unconditionally, and reissued on every write.** The session written here carries
	 * `sessionCapDays: '1'` and the key still gets thirty days: a one-day login landing after a remembered
	 * one must not pull the key's TTL down and orphan the thirty-day session, which would then be live and
	 * listed nowhere — silently missed by any revocation. The seconds are a literal for the same
	 * reason every other window in these suites is: computing it from the constant the implementation
	 * multiplies would move both sides of the assertion at once.
	 */
	it('gives the key the longer cap even when the session it files carries the shorter one', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = indexStore()

		await indexSession(s, TOKEN, { ...refreshData, sessionCapDays: '1' })

		expect(s.expire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, 2_592_000)
		expect(SESSION_INDEX_TTL_SECONDS).toBe(2_592_000)
	})

	// The hash exists before it is given a TTL, never the other way round: an `expire` on a key that does
	// not exist yet is a no-op, and the index would then be the one key on the platform that never expires.
	// The field TTL comes last for the same reason — `hExpire` on a field that does not exist yet answers
	// -2 and sets nothing, so the row would be the one row that outlives its session.
	it('writes the field before it arms either TTL', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const calls: string[] = []
		const s: ISessionIndexStore = {
			hSet: async () => void calls.push('hSet'),
			expire: async () => void calls.push('expire'),
			hExpire: async () => void calls.push('hExpire')
		}

		await indexSession(s, TOKEN, refreshData)

		expect(calls).toEqual(['hSet', 'expire', 'hExpire'])
	})

	/*
	 * **The field's TTL is the session's cap, and the key's is thirty days — two different numbers
	 * on the same write, and swapping them breaks the index in one direction each.** Give the field the
	 * key's thirty days and a one-day session is listed for twenty-nine days after it stopped working;
	 * give the key the field's cap and one short-lived login takes the whole account's index down with it.
	 *
	 * The session written here logged in a day ago with a thirty-day cap, so twenty-nine days remain — a
	 * number the mutant that reads `Date.now()` as the login, or the one that drops the subtraction, cannot
	 * also produce.
	 */
	it('gives the field the remaining cap, counted from the original login', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = indexStore()

		await indexSession(s, TOKEN, { ...refreshData, originalLogin: DAY_OLD_LOGIN })

		expect(s.hExpire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, DIGEST, TWENTY_NINE_DAYS)
		expect(s.expire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, 2_592_000)
	})

	/*
	 * ⚠️ **A rotation must not re-base the field's TTL, and this is that assertion at the helper.** Both
	 * calls below are the same session — a login and the rotation that succeeds it an hour later — and the
	 * lineage rotation carries forward is the predecessor's, unchanged. The successor's field therefore
	 * expires an hour earlier than the original's did, not thirty days after the rotation. Were it
	 * otherwise, a client refreshing every fifteen minutes would hold a row that never ages out, and the
	 * absolute cap would be listed as if it were a sliding one.
	 */
	it('does not extend the field TTL when the same lineage is re-filed', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const login = indexStore()
		const rotation = indexStore()

		await indexSession(login, TOKEN, { ...refreshData, originalLogin: `${NOW}` })
		vi.setSystemTime(NOW + 60 * 60 * 1000)
		await indexSession(rotation, TOKEN, { ...refreshData, originalLogin: `${NOW}` })

		expect(login.hExpire.mock.calls[0]![2]).toBe(2_592_000)
		expect(rotation.hExpire.mock.calls[0]![2]).toBe(2_592_000 - 3_600)
	})

	/*
	 * The floor, and the only caller that can reach it is a direct one: a login stamps `originalLogin` as
	 * it writes and a rotation past the cap is refused before it mints anything. One second rather than
	 * zero because Redis reads a non-positive field TTL as "delete now" — correct for a dead session, but
	 * a shape no caller should have to reason about — and the row is gone within that second either way.
	 */
	it('never asks for a non-positive field TTL, even for a session already past its cap', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = indexStore()

		await indexSession(s, TOKEN, { ...refreshData, originalLogin: DAY_OLD_LOGIN, sessionCapDays: '1' })

		expect(s.hExpire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, DIGEST, 1)
	})

	/*
	 * ⚠️ **The field removed is the digest of the same prefixed string the write hashed.** `hDel` answers a
	 * count nobody checks, so a prune aimed at the wrong field name is indistinguishable from one that
	 * worked — the index would keep a row per rotation, growing for the life of every session that never
	 * logs out, and the admin session console would show one login as several.
	 */
	it('prunes exactly the field the write created, from the key the write used', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s: ISessionIndexPruneStore & { hDel: ReturnType<typeof vi.fn> } = { hDel: vi.fn(async () => 1) }

		await unindexSession(s, TOKEN, refreshData)

		expect(s.hDel).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}idx:user:${ID}`, DIGEST)
		expect(JSON.stringify(s.hDel.mock.calls[0])).not.toContain('refresh-token-1')
	})
})
