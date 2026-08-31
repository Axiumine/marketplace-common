import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'
import { ICookies } from '@axiumine/koa-utils/lib/ICookies'
import { REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { Types } from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findAccountForSession, ISessionAccountModel } from '../src/others/findAccountForSession.mts'
import { hashSessionToken } from '../src/others/hashSessionToken.mts'
import { IRefreshData } from '../src/others/IRefreshData.mts'
import { ITombstoneData } from '../src/others/ITombstoneData.mts'
import { ISessionWriteStore, refreshSessionTokens } from '../src/others/refreshSessionTokens.mts'
import {
	ISessionReadStore,
	resolveAuthorizationSession,
	TAuthorizationSession
} from '../src/others/resolveAuthorizationSession.mts'
import { TIER } from '../src/others/Tier.mts'
import { expectStatus, rejection } from './graphQLErrors.mts'

const REDIS_KEY = 'test:'
const ID = '68b0f2c1a2b3c4d5e6f70819'
const FAMILY_ID = '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d'

/**
 * The key a session lives under: the shared prefix plus the digest of the token. The digest
 * itself is pinned against known SHA-256 literals in `sessionKeys.test.mts`; here it is computed, because
 * what these suites are about is *which* value gets hashed and *when*, not the algorithm.
 */
const hashedKey = (token: string) => `${REDIS_KEY}${hashSessionToken(token)}`
const tombstoneKeyFor = (token: string) => `${REDIS_KEY}used:${hashSessionToken(token)}`
const familyKeyFor = (familyId: string) => `${REDIS_KEY}family:${familyId}`
const indexKeyFor = (tier: string, accountId: string) => `${REDIS_KEY}idx:${tier}:${accountId}`

/**
 * A fixed clock, so the two windows these suites turn on — the grace window and the absolute age cap —
 * are asserted at their exact boundaries rather than near them.
 *
 * ⚠️ **Both windows are written out as literals here, deliberately.** Computing either from the constant
 * the implementation multiplies by would make every arithmetic mutant in `MILLISECONDS_PER_DAY` or
 * `GRACE_SECONDS` move both sides of the comparison at once, and survive.
 */
const NOW = 1_754_784_000_000
const DAY_MS = 86_400_000
const GRACE_MS = 10_000

/*
 * The three halves of a refresh, in the order an authorization service runs them: read the session
 * the refresh cookie names, re-read the account behind it, mint a new pair. All nine services share
 * one Redis prefix and one logout service, so what is asserted here is mostly *ordering* — which
 * guard runs before which query — because that ordering is the only thing separating one tier's
 * session from another's.
 */

describe('resolveAuthorizationSession', () => {
	const TOKEN = 'refresh-token-1'
	const SESSION_KEY = hashedKey(TOKEN)
	const TOMBSTONE_KEY = tombstoneKeyFor(TOKEN)
	const FAMILY_KEY = familyKeyFor(FAMILY_ID)
	const MEMBERS = [`${REDIS_KEY}${'a'.repeat(64)}`, `${REDIS_KEY}${'b'.repeat(64)}`]

	/** The lineage a session carries. One day old by default, well inside every cap. */
	const LINEAGE = { familyId: FAMILY_ID, originalLogin: `${NOW - 1000}`, sessionCapDays: '1' }

	/** The smallest hash that resolves: identity, tier, lineage. Anything less is refused on purpose. */
	const live = (over: Record<string, string> = {}) => ({ _id: ID, tier: TIER.shopOwner, ...LINEAGE, ...over })

	const readStore = (
		hash: Record<string, string>,
		tombstone: Record<string, string> = {}
	): ISessionReadStore & { [K in keyof ISessionReadStore]: ReturnType<typeof vi.fn> } => ({
		hGetAll: vi.fn(async (key: string) => (key === TOMBSTONE_KEY ? tombstone : hash)),
		incr: vi.fn(async () => 1),
		sMembers: vi.fn(async () => MEMBERS),
		del: vi.fn(async () => 1),
		lPush: vi.fn(async () => 1),
		lTrim: vi.fn(async () => 'OK'),
		expire: vi.fn(async () => 1)
	})

	/** The reuse trail a revocation on this path writes to, once it knows whose lineage it just ended. */
	const trailKeyFor = (tier: string, accountId: string) => `${REDIS_KEY}reuse:${tier}:${accountId}`

	/** A tombstone of the shape a rotation writes: the lineage, when it was consumed, and whose it was. */
	const TOMBSTONE = { familyId: FAMILY_ID, consumedAt: `${NOW - GRACE_MS - 1}`, _id: ID, tier: TIER.shopOwner }

	const readSessionData = vi.fn<(_id: Types.ObjectId) => Promise<{ email: string }>>(async () => ({
		email: 'mark@rivers.test'
	}))

	const resolve = (store: ISessionReadStore) =>
		resolveAuthorizationSession({
			store,
			refreshToken: TOKEN,
			tier: TIER.shopOwner,
			readSessionData
		})

	// Only the clock is faked. Faking timers wholesale would replace the microtask queue too, and every
	// assertion in here awaits a promise chain that has to keep draining on its own.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
		readSessionData.mockClear()
	})

	/*
	 * The prefix comes from the environment and is shared by all nine services — the single logout service
	 * finds a session by exactly this key, so a service that built the key differently would mint sessions
	 * nothing could ever revoke.
	 *
	 * ⚠️ The key **body is the digest of the token, never the token**, and the second assertion
	 * is the one worth keeping: it fails on any reconstruction of the old shape, including a hash of the
	 * wrong value that happens to be prefixed correctly.
	 */
	it('reads the session under the shared prefix, keyed by the digest and not by the token', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live())

		await resolve(s)

		expect(s.hGetAll).toHaveBeenCalledExactlyOnceWith(SESSION_KEY)
		expect(SESSION_KEY).not.toContain(TOKEN)
	})

	/*
	 * ⚠️ **The resolving path still costs one command**, and this is the assertion that keeps it that way.
	 * Everything the lineage added — the tombstone read, the family walk, the grace counter — hangs off a
	 * miss, so a
	 * refactor that hoisted any of it above the hit would multiply the whole platform's auth traffic by
	 * three without failing a single behavioural test.
	 */
	it('pays for none of the reuse machinery when the session is simply there', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live())

		await resolve(s)

		expect(s.hGetAll.mock.calls).toEqual([[SESSION_KEY]])
		expect(s.sMembers).not.toHaveBeenCalled()
		expect(s.del).not.toHaveBeenCalled()
		expect(s.incr).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **The inverted dual-read test, at the site that carries the whole platform's traffic.**
	 * The fixture is unchanged — a Redis holding a perfectly valid session under the old raw-token key —
	 * and the expected answer is now the opposite one: 498, because nothing on this path names that key
	 * any more. Both preconditions for flipping it are recorded in the commit; the short version is that
	 * the cutover was never deployed, so no session of this shape has ever existed outside a fixture.
	 *
	 * The two calls are asserted in order because the second one is the tombstone, not a second session
	 * shape: a miss now goes straight to reuse detection, which is what makes the raw key unreachable
	 * rather than merely unused.
	 */
	it('refuses a session written under the raw key, and never names that key', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({})
		s.hGetAll.mockImplementation(async (key: string) => (key === `${REDIS_KEY}${TOKEN}` ? live() : {}))

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')

		expect(s.hGetAll.mock.calls).toEqual([[SESSION_KEY], [TOMBSTONE_KEY]])
		expect(JSON.stringify(s.hGetAll.mock.calls)).not.toContain(TOKEN)
	})

	// 498, the token-specific status: the cookie's signature was valid, the session behind it is not.
	it('refuses a session that is no longer there, and never asks the database about it', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({})

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(readSessionData).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ The reason this function exists. A session minted by the Admin authorization service is
	 * findable under this very key, and the per-tier account lookup that follows is not a substitute
	 * for the check: it only fails by accident, when the foreign id happens not to exist in this
	 * tier's collection too. Asserting that the reader was never called is what pins the order.
	 */
	it.each([TIER.admin, TIER.user])('refuses a %s session before it looks the account up', async (foreign) => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({ _id: ID, tier: foreign })

		expectStatus(await rejection(() => resolve(s)), 403, 'Forbidden')
		expect(readSessionData).not.toHaveBeenCalled()
	})

	// Fail closed. A hash written before the discriminator existed carries no tier, and it is refused
	// like any other mismatch — the alternative kept the hole open for a full 90-day refresh lifetime.
	it('refuses a session minted before the tier field existed', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({ _id: ID })

		expectStatus(await rejection(() => resolve(s)), 403, 'Forbidden')
		expect(readSessionData).not.toHaveBeenCalled()
	})

	/*
	 * The whole session, asserted as one object. Three of its four fields come from three different
	 * places — the account reader, the Redis hash and this service's own constant — and `toEqual`
	 * is what notices a fifth field appearing or the tier being copied out of the hash instead.
	 *
	 * The id reaches the reader as an ObjectId: it is stored as a hex string, and a reader handed the
	 * string would query a collection whose `_id` is an ObjectId and find nothing.
	 */
	it('builds the session from the account data, the stored id and this service own tier', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live())

		await expect(resolve(s)).resolves.toEqual({
			email: 'mark@rivers.test',
			_id: ID,
			tier: TIER.shopOwner,
			refreshToken: TOKEN,
			...LINEAGE,
			// A hash written before `accessKey` existed carries none, and the resolver hands `undefined` on
			// rather than inventing a key: the rotation reads that as "nothing to retire", which is exactly
			// what those sessions did before the field was added. Spelled out rather than left off, because
			// `toEqual` ignores an undefined property and would agree with a resolver that dropped the field.
			accessKey: undefined
		})
		expect(readSessionData).toHaveBeenCalledExactlyOnceWith(new Types.ObjectId(ID))
	})

	/*
	 * ⚠️ **The access key travels out of the resolver for the same reason the lineage does**: the rotation
	 * that follows is the only thing that can retire the access token this session minted, and it can only
	 * do that with a name that does not depend on what the request carried. A resolver that read the hash
	 * and dropped this field would leave every headerless refresh — every page reload — orphaning a live
	 * access token, which is precisely the bug the field was added to close.
	 */
	it('carries the bound access key through to the caller, unchanged', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const bound = hashedKey('access:access-token-bound')

		await expect(resolve(readStore(live({ accessKey: bound })))).resolves.toMatchObject({ accessKey: bound })
	})

	/*
	 * The lineage travels **out** of the resolver as well as into it, because the rotation that follows is
	 * what writes it back into the next refresh hash. A resolver that read it, checked the cap and dropped it
	 * would leave `refreshSessionTokens` with nothing to propagate, and every rotation would mint a session
	 * with no family and no login date — an unbounded one, one refresh at a time.
	 */
	it('carries the lineage through to the caller, unchanged', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)

		await expect(resolve(readStore(live({ sessionCapDays: '30' })))).resolves.toMatchObject({
			familyId: FAMILY_ID,
			originalLogin: `${NOW - 1000}`,
			sessionCapDays: '30'
		})
	})

	/*
	 * A hash that predates these fields is refused rather than defaulted, and refused **before** the
	 * account read — the behaviour itself is `assertRefreshLineage`'s own suite, so what is pinned here is
	 * that the resolver calls it at all, and calls it early.
	 */
	it.each([['familyId'], ['originalLogin'], ['sessionCapDays']])(
		'refuses a session carrying no %s, before it reads the account',
		async (field) => {
			vi.stubEnv('REDIS_KEY', REDIS_KEY)
			const hash: Record<string, string> = live()
			delete hash[field]

			expectStatus(await rejection(() => resolve(readStore(hash))), 498, 'Invalid Token')
			expect(readSessionData).not.toHaveBeenCalled()
		}
	)

	/*
	 * The ordinary miss. A token whose session expired has no tombstone, and the resolver has to refuse it
	 * on the way out exactly as it did before any of this existed — the second `hGetAll` is the only thing
	 * an expired session now pays for. It was a third until the raw-key read that sat between the two was
	 * deleted.
	 */
	it('walks past a miss with no tombstone without touching the family', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({})

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.hGetAll.mock.calls).toEqual([[SESSION_KEY], [TOMBSTONE_KEY]])
		expect(s.sMembers).not.toHaveBeenCalled()
		expect(s.del).not.toHaveBeenCalled()
	})

	/*
	 * The case rotation-on-every-refresh created. Two tabs refresh with the same cookie; the second
	 * arrives after the first consumed the token, holding a cookie the browser has already replaced. It is a
	 * lost race, not a theft.
	 *
	 * ⚠️ **409 and no revocation.** Answering the 498 a replay gets would log a legitimate user out of every
	 * session they have for opening two tabs, and answering with the winner's new token would hand a live
	 * credential to whoever asked second. The counter is what makes the window's size an observation rather
	 * than a guess.
	 */
	it('tells the loser of a refresh race to retry, counts it, and revokes nothing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, { familyId: FAMILY_ID, consumedAt: `${NOW - 1}` })

		const error = await rejection(() => resolve(s))

		expectStatus(error, 409, 'Refresh In Progress')
		expect(error.extensions.code).toBe('REFRESH_RACE_RETRY')
		expect(s.incr).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}grace-hits`)
		expect(s.sMembers).not.toHaveBeenCalled()
		expect(s.del).not.toHaveBeenCalled()
	})

	/*
	 * Both sides of the grace boundary, one millisecond apart. The window is a `<=`, so the instant it is
	 * exactly `GRACE_SECONDS` old is still a retry — and the millisecond before that is a replay. Written
	 * against the literal 10 000 rather than the constant, for the reason at the top of this file.
	 */
	it.each([
		['at the very edge of the window, as a retry', NOW - GRACE_MS, 409, 'Refresh In Progress'],
		['one millisecond past it, as a replay', NOW - GRACE_MS - 1, 498, 'Invalid Token']
	])('treats a token consumed %s', async (_label, consumedAt, status, message) => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, { familyId: FAMILY_ID, consumedAt: `${consumedAt}` })

		expectStatus(await rejection(() => resolve(s)), status as number, message as string)
	})

	/*
	 * The whole point of the tombstone. A refresh token presented after its rotation is a token
	 * someone kept a copy of, and neither side of that can be told apart from the other — so every session
	 * the lineage owns dies, the legitimate holder included. That is the trade the reuse detection makes.
	 *
	 * The 498 is deliberately the same one an expired session gets: a replayer learns nothing from the
	 * response about whether it tripped anything.
	 */
	it('revokes the whole family when a consumed token comes back later', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, TOMBSTONE)

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.sMembers).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY)
		expect(s.del.mock.calls).toEqual([[MEMBERS[0]], [MEMBERS[1]], [FAMILY_KEY]])
		expect(s.incr).not.toHaveBeenCalled()
		expect(readSessionData).not.toHaveBeenCalled()
	})

	/*
	 * The mass logout the line above performs is the one an admin eventually has to explain, so
	 * this path files the reason under the account that lost the sessions.
	 *
	 * ⚠️ **The account comes off the tombstone, and it has to.** By this point the session hash the token
	 * named is gone — the rotation that wrote the marker deleted it — and the family set holds key digests
	 * rather than an account, so `_id` and `tier` are readable nowhere else on this request.
	 */
	it('files a replay under the account the tombstone names, with no token in the line', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, TOMBSTONE)

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.lPush).toHaveBeenCalledExactlyOnceWith(
			trailKeyFor(TIER.shopOwner, ID),
			JSON.stringify({
				familyId: FAMILY_ID,
				tier: TIER.shopOwner,
				accountId: ID,
				action: 'refreshTokenReplayed',
				at: `${NOW}`
			})
		)
		expect(s.lPush.mock.calls[0][1]).not.toContain(TOKEN)
	})

	/*
	 * ⚠️ **The tombstone's tier wins over the service's own** — the only place on this platform where that is
	 * true, and it is not a hole in `assertTier`: nothing is being authorised here. The token belonged to
	 * whoever the marker says, and filing its replay under the tier of whichever service happened to receive
	 * it would put one account's incident on another account's screen.
	 */
	it('files a replay under the tombstone tier even when this service serves another', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, { ...TOMBSTONE, tier: TIER.user })

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.lPush.mock.calls[0][0]).toBe(trailKeyFor(TIER.user, ID))
	})

	/*
	 * ⚠️ **An unattributable replay still revokes, and writes nothing.** A tombstone written before the
	 * account was stored carries none, and a `tier` that is not one of the three constants is a corrupt marker
	 * rather than a fourth
	 * collection — both lose the trail entry and keep the revocation. The security action never depends on the
	 * explanation, which is the whole reason `isTier` exists rather than a cast.
	 */
	it.each([
		['it predates the account fields', { familyId: TOMBSTONE.familyId, consumedAt: TOMBSTONE.consumedAt }],
		['its tier is not one of the three', { ...TOMBSTONE, tier: 'superAdmin' }],
		['it names a tier but no account', { familyId: TOMBSTONE.familyId, consumedAt: TOMBSTONE.consumedAt, tier: TIER.admin }]
	])('revokes a replayed lineage but records nothing when %s', async (_label, tombstone) => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, tombstone)

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.del.mock.calls).toEqual([[MEMBERS[0]], [MEMBERS[1]], [FAMILY_KEY]])
		expect(s.lPush).not.toHaveBeenCalled()
		expect(s.expire).not.toHaveBeenCalled()
	})

	/*
	 * ⚠️ **A malformed tombstone fails closed, and the two shapes fail closed differently.** `Number(undefined)`
	 * is `NaN` and every comparison against it is false, so a marker with no `consumedAt` falls out of the
	 * grace branch into the replay one rather than granting an unbounded retry window. A marker with no
	 * `familyId` names no lineage, so there is nothing to revoke — but the token is still refused, because
	 * "we cannot tell whose family this was" is not a reason to hand a consumed token back.
	 */
	it.each([
		['no consumedAt', { familyId: FAMILY_ID }, true],
		['no familyId', { consumedAt: `${NOW - GRACE_MS - 1}` }, false],
		['nothing but a stray field', { note: 'corrupt' }, false]
	])('refuses a token whose tombstone carries %s', async (_label, tombstone, revokes) => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore({}, tombstone as Record<string, string>)

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.sMembers.mock.calls).toHaveLength(revokes ? 1 : 0)
	})

	/*
	 * The cap is measured from `originalLogin`, which no rotation moves, so a session cannot refresh
	 * its way past it — that is the difference between this and the idle timeout the refresh TTL already is.
	 * A session this old is the shape a quietly stolen token has, so it takes its family with it.
	 *
	 * ⚠️ The three rows per cap are the relational-admin mutants: `>` is what makes a session exactly at
	 * the cap survive, and `>=` or `<` would each be caught by exactly one of these.
	 */
	it.each([
		['1', DAY_MS, false],
		['1', DAY_MS - 1, false],
		['1', DAY_MS + 1, true],
		['30', 30 * DAY_MS, false],
		['30', 30 * DAY_MS - 1, false],
		['30', 30 * DAY_MS + 1, true]
	])('with a %s-day cap, an age of %i milliseconds is refused: %o', async (sessionCapDays, age, refused) => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live({ sessionCapDays: sessionCapDays as string, originalLogin: `${NOW - (age as number)}` }))

		if (!refused) {
			await expect(resolve(s)).resolves.toMatchObject({ _id: ID })
			expect(s.del).not.toHaveBeenCalled()

			return
		}

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.sMembers).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY)
		expect(s.del.mock.calls).toEqual([[MEMBERS[0]], [MEMBERS[1]], [FAMILY_KEY]])
		expect(readSessionData).not.toHaveBeenCalled()
	})

	/*
	 * The trail's second call site. A session ended by its own age cap is the other way a lineage dies without
	 * anybody asking, so it gets the other action — an admin reading "sessionCapReached" is looking at a
	 * policy expiry, and reading "refreshTokenReplayed" at a suspected theft. One vocabulary, two meanings,
	 * and confusing them would send an incident response after a session that simply got old.
	 *
	 * ⚠️ **The tier stamped here is the service's own, not the hash's** — `assertTier` has already proved the
	 * two equal, and the constant is the one no caller can influence. The account id is the session's, since
	 * unlike the replay path there is a live hash to read it from.
	 */
	it('files a capped session under this service tier, with the cap action', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live({ sessionCapDays: '1', originalLogin: `${NOW - DAY_MS - 1}` }))

		expectStatus(await rejection(() => resolve(s)), 498, 'Invalid Token')
		expect(s.lPush).toHaveBeenCalledExactlyOnceWith(
			trailKeyFor(TIER.shopOwner, ID),
			JSON.stringify({
				familyId: FAMILY_ID,
				tier: TIER.shopOwner,
				accountId: ID,
				action: 'sessionCapReached',
				at: `${NOW}`
			})
		)
		expect(s.lTrim).toHaveBeenCalledExactlyOnceWith(trailKeyFor(TIER.shopOwner, ID), 0, 49)
		expect(s.expire).toHaveBeenCalledExactlyOnceWith(trailKeyFor(TIER.shopOwner, ID), 30 * 24 * 60 * 60)
	})

	// A session inside its cap resolves and writes no trail at all: the events are what a revocation leaves
	// behind, and an ordinary refresh revokes nothing.
	it('records nothing on the path that resolves a session', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = readStore(live())

		await expect(resolve(s)).resolves.toMatchObject({ _id: ID })
		expect(s.lPush).not.toHaveBeenCalled()
		expect(s.lTrim).not.toHaveBeenCalled()
		expect(s.expire).not.toHaveBeenCalled()
	})
})

describe('findAccountForSession', () => {
	const PROJECTION = '_id login.email deleted disabled'
	const _id = new Types.ObjectId(ID)

	interface IAccount extends IAuthorizationDisDel {
		_id: Types.ObjectId
		login: { email: string }
	}

	const active: IAccount = { _id, login: { email: 'mark@rivers.test' }, disabled: false }

	const model = (account: IAccount | null) => {
		const lean = vi.fn(async () => account)
		const findById = vi.fn<ISessionAccountModel<IAccount>['findById']>(() => ({ lean }))

		return { model: { findById } satisfies ISessionAccountModel<IAccount>, findById, lean }
	}

	// The projection is the caller's, deliberately — a shop owner's session carries onboarding fields a
	// customer has no equivalent of — so it has to arrive at the query untouched.
	it('asks for one document by id, with the projection it was handed', async () => {
		const m = model(active)

		await findAccountForSession(m.model, _id, PROJECTION)

		expect(m.findById).toHaveBeenCalledExactlyOnceWith({ _id }, PROJECTION)
		expect(m.lean).toHaveBeenCalledExactlyOnceWith()
	})

	/*
	 * ⚠️ The order of the two guards is the whole security content of this function. A document that is
	 * gone is refused *before* anything reads a field off it — the account may have been deleted
	 * outright between two refreshes, and `checkUserAuthorizationDisDel` on `null` is a TypeError, which
	 * the GraphQL layer answers with a 500 rather than a 401.
	 */
	it('refuses a session whose account no longer exists', async () => {
		expectStatus(await rejection(() => findAccountForSession(model(null).model, _id, PROJECTION)), 401, 'Unauthorized')
	})

	/*
	 * Both liveness gates run on **every refresh**, not at login only. That is what makes disabling an
	 * account take effect within one access-token lifetime (30–90 minutes) instead of one refresh-token
	 * lifetime (90 days).
	 */
	it.each([
		['deleted', { ...active, deleted: new Date() }],
		['disabled', { ...active, disabled: true }]
	])('refuses a %s account on the very next refresh', async (_label, account) => {
		expectStatus(await rejection(() => findAccountForSession(model(account).model, _id, PROJECTION)), 401, 'Unauthorized')
	})

	// The document itself, not a copy: whatever the projection asked for is what the session carries.
	it('returns the document it read', async () => {
		await expect(findAccountForSession(model(active).model, _id, PROJECTION)).resolves.toBe(active)
	})
})

describe('refreshSessionTokens', () => {
	const OLD_REFRESH = 'refresh-token-1'
	const OLD_KEY = hashedKey(OLD_REFRESH)

	/** As `authorizationLogoutHandler` reads it: the `Authorization` header with `Bearer ` stripped, prefix intact. */
	const PRESENTED_ACCESS = 'access:access-token-1'
	const OLD_TOMBSTONE_KEY = tombstoneKeyFor(OLD_REFRESH)
	const FAMILY_KEY = familyKeyFor(FAMILY_ID)
	/** The account's session index — one hash per account, named by tier *and* id. */
	const INDEX_KEY = indexKeyFor(TIER.shopOwner, ID)
	/*
	 * The per-family mint bucket. The digest is `sha256(FAMILY_ID)`, written out as a literal
	 * rather than computed here: a test that hashed the id itself would agree with the implementation about
	 * any algorithm, including a mutated one.
	 *
	 * ⚠️ It is a *different* key from `FAMILY_KEY` — that one is the set of live session keys a revocation
	 * walks, this one is a counter. They share nothing but the id they are built from.
	 */
	const RL_FAMILY_KEY = `${REDIS_KEY}rl:refresh:family:eb8e9661945f5feea4260ffdbf474a5125cc7eb0cad7d50dbfda549221efc2f7`
	const LINEAGE = { familyId: FAMILY_ID, originalLogin: `${NOW - DAY_MS}`, sessionCapDays: '30' }

	const session: TAuthorizationSession<{ email: string; onboardingStep: string }> = {
		email: 'mark@rivers.test',
		onboardingStep: 'company',
		_id: ID,
		tier: TIER.shopOwner,
		refreshToken: OLD_REFRESH,
		...LINEAGE
	}

	/**
	 * The access key the session itself records — a whole key, prefix and digest, exactly as `sessionKey`
	 * built it when this pair was minted. Deliberately *not* the digest of `PRESENTED_ACCESS`: the two are
	 * different names for the same half of a session, and only assertions that can tell them apart can show
	 * which of the two the rotation actually followed.
	 */
	const BOUND_ACCESS_KEY = hashedKey('access:access-token-bound')

	/** A session minted after the residual was closed: it knows the key of its own access token. */
	const boundSession: TAuthorizationSession<{ email: string; onboardingStep: string }> = {
		...session,
		accessKey: BOUND_ACCESS_KEY
	}

	const writeStore = (
		over: Partial<ISessionWriteStore> = {}
	): ISessionWriteStore & { [K in keyof ISessionWriteStore]: ReturnType<typeof vi.fn> } => ({
		hSet: vi.fn(async () => 1),
		expire: vi.fn(async () => 1),
		del: vi.fn(async () => 1),
		sAdd: vi.fn(async () => 1),
		// The two the per-family mint limiter needs. `incr` answering 1 and `ttl` answering -1 is
		// the first call of a fresh window: under the limit, and the window still to be armed.
		incr: vi.fn(async () => 1),
		ttl: vi.fn(async () => -1),
		// The two the index prune needs: a TTL on the successor's field, and the removal of the
		// predecessor's. `hExpire` answers an array — one status per field asked about — and 1 is "set".
		hExpire: vi.fn(async () => [1]),
		hDel: vi.fn(async () => 1),
		...over
	})

	const cookieJar = () => {
		const set = vi.fn<ICookies['set']>()
		const ctx: IContextLogin = { cookies: { set, get: vi.fn<ICookies['get']>() } }

		return { ctx, set }
	}

	const captureException = vi.fn()

	// The tombstone stamps `Date.now()` into a Redis value, so the clock is pinned here too — see the note
	// on the resolver suite for why only `Date` is faked.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
		captureException.mockClear()
	})

	/*
	 * The rotation, spelled out end to end. Four things are being pinned at once and each of them is a
	 * silent failure on its own: the two prefixes (`access:` and `refresh:` are what tell one hash from
	 * the other under a shared key space), the two payloads, the two TTLs, and the deletion of the token
	 * this call arrived with — without that last one the function re-issues rather than rotates, and a
	 * stolen refresh token stays valid for its whole 90 days.
	 *
	 * ⚠️ The two prefixes are inside the digest, not around it: `access:` and `refresh:` are what
	 * tell the two hashes apart, so they have to be part of the value hashed rather than a readable
	 * fragment of the key. That is also why the old token is dropped in **both** shapes — the session being
	 * rotated may predate the cutover, and a rotation that leaves the old refresh key alive is exactly the
	 * replay this function rotates to prevent.
	 */
	it('writes both hashes, arms both TTLs and drops the token it was called with', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const { ctx, set } = cookieJar()

		const result = await refreshSessionTokens({ store, ctx, session, captureException })

		const keyAccess = hashedKey(`access:${result.accessToken}`)
		const keyRefresh = hashedKey(`refresh:${set.mock.calls[0][1]}`)

		expect(result).toEqual({ status: true, accessToken: expect.any(String) })
		expect(store.hSet.mock.calls).toEqual([
			[keyAccess, { email: 'mark@rivers.test', onboardingStep: 'company', _id: ID, tier: TIER.shopOwner }],
			// `accessKey` names the access token *this* rotation minted, never the one it retired: the field
			// exists so that whatever ends this session next can find both halves without holding either
			// token, and a value one rotation behind would name a key this call has already deleted.
			[keyRefresh, { _id: ID, tier: TIER.shopOwner, ...LINEAGE, accessKey: keyAccess } satisfies IRefreshData],
			[
				INDEX_KEY,
				{ [keyRefresh.slice(REDIS_KEY.length)]: JSON.stringify({ tier: TIER.shopOwner, mintedAt: LINEAGE.originalLogin }) }
			],
			[OLD_TOMBSTONE_KEY, { familyId: FAMILY_ID, consumedAt: `${NOW}`, _id: ID, tier: TIER.shopOwner } satisfies ITombstoneData]
		])
		expect(store.expire.mock.calls).toEqual([
			// The mint bucket's window is armed before anything is minted — see the limiter's own tests below.
			[RL_FAMILY_KEY, 3600],
			[keyAccess, expect.any(Number)],
			[keyRefresh, REFRESH_TOKEN_EXPIRY],
			// Thirty days in seconds, written out for the same reason the two windows above are: computing it
			// from the constant the implementation multiplies would move both sides of the assertion at once.
			[INDEX_KEY, 2_592_000],
			[FAMILY_KEY, REFRESH_TOKEN_EXPIRY],
			[OLD_TOMBSTONE_KEY, REFRESH_TOKEN_EXPIRY]
		])
		expect(store.del).toHaveBeenCalledExactlyOnceWith(OLD_KEY)
		/*
		 * Both halves of the index write. The successor's field gets the *remaining* cap — this session logged in
		 * a day ago under a thirty-day cap, so twenty-nine days, not a fresh thirty — and the predecessor's
		 * field is removed, so one session is one row however many times it rotates.
		 *
		 * ⚠️ The two numbers on this write are deliberately different: `[INDEX_KEY, 2_592_000]` above is the
		 * *key's* TTL and this is the *field's*. A single number here would mean either a row that outlives
		 * its session or an index that one short login can take down.
		 */
		expect(store.hExpire.mock.calls).toEqual([[INDEX_KEY, keyRefresh.slice(REDIS_KEY.length), 2_505_600]])
		expect(store.hDel.mock.calls).toEqual([[INDEX_KEY, OLD_KEY.slice(REDIS_KEY.length)]])
	})

	/*
	 * The two records a rotation leaves behind besides the pair itself.
	 *
	 * ⚠️ **The tombstone value names a family, a time and an account, and holds no token of any kind.** The
	 * design this replaced stored the successor token under the consumed one so the loser of a race could be
	 * handed it — which would have put a live credential into a Redis *value*, exactly the thing the hashed
	 * namespace took out of the keys. `Object.keys` is asserted whole so a fifth field cannot be added without
	 * this failing.
	 *
	 * ⚠️ **`_id` and `tier` are the pair the trail needs, and neither is a credential**: a tier is one of three
	 * constants and an account id is what every resource query already carries. They are here because a replay
	 * is detected *after* this rotation deleted the session hash, so by then the account is readable nowhere
	 * else — the reuse trail would have nothing to file the mass logout under.
	 *
	 * The key itself is a digest under a constant namespace, asserted anchored: `used:` varies with nothing,
	 * so the only variable part of the key is still 64 hex characters.
	 */
	it('tombstones the consumed token with a family, a timestamp and its account, and nothing else', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })

		const [key, value] = store.hSet.mock.calls[3] as [string, Record<string, string>]

		expect(key).toMatch(new RegExp(`^${REDIS_KEY}used:[0-9a-f]{64}$`))
		expect(key).not.toContain(OLD_REFRESH)
		expect(Object.keys(value)).toEqual(['familyId', 'consumedAt', '_id', 'tier'])
		expect(value).toEqual({ familyId: FAMILY_ID, consumedAt: `${NOW}`, _id: ID, tier: TIER.shopOwner })
	})

	/*
	 * ⚠️ **The account written here is the *session's*, not one supplied by the caller.** A rotation
	 * is reached with a session the middleware already tier-asserted, so the marker names the account the
	 * consumed token actually belonged to — which is what makes the replay path's trail entry trustworthy.
	 * Copying the serving service's own tier in would mislabel every session the shared logout service rotates.
	 */
	it('names the account off the session it is rotating, whichever tier that is', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const other = '68b0f2c1a2b3c4d5e6f7081a'

		await refreshSessionTokens({
			store,
			ctx: cookieJar().ctx,
			session: { ...session, _id: other, tier: TIER.user },
			captureException
		})

		const [, value] = store.hSet.mock.calls[3] as [string, Record<string, string>]

		expect(value).toEqual({ familyId: FAMILY_ID, consumedAt: `${NOW}`, _id: other, tier: TIER.user })
	})

	/*
	 * The set is what a reuse event walks, so it has to name the pair this rotation just minted —
	 * both halves, since revoking a lineage that left its access tokens alive would leave the thief up to an
	 * hour of working credentials.
	 *
	 * ⚠️ **The set gets the refresh TTL, not the access one.** It has to outlive every member it names: a set
	 * that expired first would leave live sessions with no record of which family they belong to, and a later
	 * reuse event would find an empty set and revoke nothing.
	 */
	it('files the new pair into the family and gives the set a TTL that outlives both', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const { ctx, set } = cookieJar()

		const result = await refreshSessionTokens({ store, ctx, session, captureException })

		expect(store.sAdd).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY, [
			hashedKey(`access:${result.accessToken}`),
			hashedKey(`refresh:${set.mock.calls[0][1]}`)
		])
		expect(store.expire.mock.calls[4]).toEqual([FAMILY_KEY, REFRESH_TOKEN_EXPIRY])
	})

	/*
	 * ⚠️ **The lineage is propagated, never re-minted.** A rotation that stamped a fresh `originalLogin` would
	 * reset the absolute cap on every refresh, and a session would live for ever an hour at a time — the exact
	 * hole the absolute cap exists to close. A fresh `familyId` would be worse: each rotation would start a
	 * lineage of
	 * one, and a reuse event would revoke the replayed token alone while the thief's own chain carried on.
	 */
	/*
	 * The session index, from the rotation side. Three properties, each of which is a silent failure alone:
	 *
	 * - **the field is the digest of the successor's refresh key**, so a revocation can rebuild the key to delete
	 *   as `${REDIS_KEY}${field}` without holding a token. Asserted as the *body of `keyRefresh`* rather than
	 *   as a shape: a field that merely looked like a digest would pass `/^[0-9a-f]{64}$/` while naming a key
	 *   nothing can revoke;
	 * - **the value names the login, not this rotation.** `mintedAt` is `originalLogin`, carried forward — a
	 *   session that refreshes every fifteen minutes must not read as fifteen minutes old to the account
	 *   looking at its own sessions;
	 * - **no token material anywhere in it.** `Object.keys` is asserted whole so a third field cannot be
	 *   added without this failing, and the serialized value is checked against the token itself.
	 */
	it('files the successor under its account, by digest, naming the original login', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const { ctx, set } = cookieJar()

		await refreshSessionTokens({ store, ctx, session, captureException })

		const newRefresh = set.mock.calls[0][1] as string
		const [key, value] = store.hSet.mock.calls[2] as [string, Record<string, string>]
		const [field] = Object.keys(value)

		expect(key).toBe(INDEX_KEY)
		expect(field).toBe(hashedKey(`refresh:${newRefresh}`).slice(REDIS_KEY.length))
		expect(field).toMatch(/^[0-9a-f]{64}$/)
		expect(Object.keys(value)).toHaveLength(1)
		expect(JSON.parse(value[field]!)).toEqual({ tier: TIER.shopOwner, mintedAt: LINEAGE.originalLogin })
		expect(Object.keys(JSON.parse(value[field]!) as object)).toEqual(['tier', 'mintedAt'])
		expect(value[field]).not.toContain(newRefresh)
		expect(value[field]).not.toContain(OLD_REFRESH)
	})

	it('carries the lineage into the new refresh hash without changing any of it', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })

		expect(store.hSet.mock.calls[1][1]).toMatchObject(LINEAGE)
	})

	/*
	 * The whole rotation as one ordered list, across all four commands and the cookie — because every one of
	 * these orderings is a window a process death opens if it is reversed, and none of them is visible in a
	 * per-command assertion.
	 *
	 * - **the mint bucket before everything**: a rotation refused for rate reasons has to cost one `INCR` and
	 *   leave nothing to unwind, which it can only do if it is counted before the first token is generated;
	 * - **the pair before its TTLs**: a hash is unreadable until it is written, so nothing can find a session
	 *   whose TTL has not been armed yet — the reverse would arm a TTL on a key that does not exist;
	 * - **the index before the deletes**: the rollback removes the two session keys and nothing else, so an
	 *   index write that fails has to fail while the old refresh token is still alive — the client keeps a
	 *   working session instead of one whose successor was never recorded;
	 * - **the family before the tombstone**: a pair filed after its own tombstone could be replayed against a
	 *   family that does not yet name it, and the revocation would miss the very keys the thief holds;
	 * - **the tombstone before the delete**: delete-then-tombstone leaves a window in which a consumed token
	 *   has no marker, and a replay of it then looks exactly like ordinary expiry;
	 * - **the cookie before the deletes**: a client whose old token was dropped before its new one reached it
	 *   holds nothing at all, and the rollback cannot give it back;
	 * - **the prune last, after the delete of the token it names**: unfile-then-delete leaves a
	 *   still-usable refresh token listed nowhere, which is exactly the session a revocation misses, while
	 *   delete-then-unfile leaves a row naming a key that is already gone — and the field's own TTL removes
	 *   that row even if this last command never runs.
	 */
	it('runs the whole rotation in the one order a crash between any two steps survives', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const calls: [string, string][] = []
		const record = (command: string) => async (key: string) => {
			calls.push([command, key])

			return 1
		}
		const store: ISessionWriteStore = {
			hSet: record('hSet'),
			expire: record('expire'),
			del: record('del'),
			sAdd: record('sAdd'),
			incr: record('incr'),
			ttl: record('ttl'),
			hExpire: record('hExpire'),
			hDel: record('hDel')
		}
		const { ctx, set } = cookieJar()
		set.mockImplementation(() => void calls.push(['cookie', 'refresh_token']))

		const result = await refreshSessionTokens({
			store,
			ctx,
			session,
			presentedAccessToken: PRESENTED_ACCESS,
			captureException
		})

		const keyAccess = hashedKey(`access:${result.accessToken}`)
		const keyRefresh = hashedKey(`refresh:${set.mock.calls[0][1]}`)

		expect(calls).toEqual([
			['incr', RL_FAMILY_KEY],
			['expire', RL_FAMILY_KEY],
			['hSet', keyAccess],
			['hSet', keyRefresh],
			['expire', keyAccess],
			['expire', keyRefresh],
			['hSet', INDEX_KEY],
			['expire', INDEX_KEY],
			['hExpire', INDEX_KEY],
			['sAdd', FAMILY_KEY],
			['expire', FAMILY_KEY],
			['hSet', OLD_TOMBSTONE_KEY],
			['expire', OLD_TOMBSTONE_KEY],
			['cookie', 'refresh_token'],
			['del', hashedKey(PRESENTED_ACCESS)],
			['del', OLD_KEY],
			['hDel', INDEX_KEY]
		])
	})

	/*
	 * The per-family mint limiter. Three things are policy rather than mechanism and each is
	 * asserted here so that changing one is a failing test rather than a silent loosening: the bucket the
	 * counter lives in, the identity it counts (the lineage, never an address), and the window.
	 *
	 * ⚠️ **The identity is the `familyId`, and the key carries no plaintext of it.** `assertUnderRateLimit`
	 * hashes what it is handed, so the id is not recoverable from a `KEYS` scan or an AOF file — while
	 * `rl:refresh:family:` stays readable, so an admin can still count the bucket without naming anyone.
	 */
	it('counts one mint against the lineage, in its own bucket, over an hour', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })

		expect(store.incr).toHaveBeenCalledExactlyOnceWith(RL_FAMILY_KEY)
		expect(RL_FAMILY_KEY).not.toContain(FAMILY_ID)
		expect(store.expire.mock.calls[0]).toEqual([RL_FAMILY_KEY, 3600])
	})

	/*
	 * ⚠️ **The 429 path, and what it must not have done on the way to throwing.** Twenty-one mints in one
	 * hour by one lineage is a rotation loop or a stolen token being exercised, and the answer is a refusal
	 * that costs the platform one `INCR` — no token generated, no hash written, no cookie set, and above all
	 * **no delete**: a rotation refused after it had dropped the old refresh key would log the legitimate
	 * client out of a session it was entitled to keep.
	 *
	 * The stub answers 21 rather than any number over the limit, because 21 is the first refusal — a mutant
	 * that compared with `>=` instead of `>` would refuse the twentieth, and that boundary is invisible to a
	 * test that hands the limiter a hundred.
	 */
	it('refuses the twenty-first mint of an hour and writes nothing at all', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore({ incr: vi.fn(async () => 21) })
		const { ctx, set } = cookieJar()

		expectStatus(
			await rejection(() => refreshSessionTokens({ store, ctx, session, captureException })),
			429,
			'Too Many Requests'
		)

		expect(store.hSet).not.toHaveBeenCalled()
		expect(store.sAdd).not.toHaveBeenCalled()
		expect(store.del).not.toHaveBeenCalled()
		expect(set).not.toHaveBeenCalled()
		// ⚠️ Not reported to Sentry either: the refusal happens before the try block, so it is not an error
		// the rotation caught — it is the limiter working, and a 429 per rotation loop would be noise.
		expect(captureException).not.toHaveBeenCalled()
	})

	// The twentieth is still served: the limit is twenty *allowed*, so a caller that has spent nineteen has
	// one left. Pinned because `>` and `>=` differ by exactly this call and by no other.
	it('serves the twentieth', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore({ incr: vi.fn(async () => 20) })

		await expect(refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })).resolves.toMatchObject({
			status: true
		})
	})

	/*
	 * Without this delete the access token the call arrived with lives out its remaining 30–91
	 * minutes alongside its own successor, so a stolen pair keeps working straight through the rotation the
	 * legitimate client made — the rotation that was supposed to be what invalidated it.
	 *
	 * It is hashed like every other key, and the value hashed is the **prefixed** token: the header carries
	 * `access:…`, and hashing the bare uuid would build a key nothing was ever stored under, so the delete
	 * would succeed silently and delete nothing.
	 */
	it('retires the access token the call arrived with', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({
			store,
			ctx: cookieJar().ctx,
			session,
			presentedAccessToken: PRESENTED_ACCESS,
			captureException
		})

		expect(store.del.mock.calls).toEqual([[hashedKey(PRESENTED_ACCESS)], [OLD_KEY]])
	})

	/*
	 * ⚠️ And it is optional, deliberately. A client whose access token expired before it refreshed has none to
	 * send, which is the ordinary case rather than an error — the same tolerance `authorizationLogoutHandler`
	 * has. Deleting `sessionKey(undefined)` would name a real key, the digest of the string `'undefined'`, and
	 * a rotation that fell over on it would be a rotation that only worked for clients holding two credentials.
	 */
	it('never issues the extra delete when no access token was presented', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, presentedAccessToken: undefined, captureException })

		expect(store.del).toHaveBeenCalledExactlyOnceWith(OLD_KEY)
	})

	/*
	 * ⚠️ **The bug the bound key closes, stated as the test that would have caught it.** A refresh sent with
	 * no `Authorization` header is not an edge case: an access token lives in memory, so every page reload
	 * refreshes without one. For as long as `presentedAccessToken` was the only name the rotation had, each
	 * of those reloads left a live access token behind — in no family, in no index row, reachable by no
	 * logout and no revocation, and good for the rest of its 30–91 minutes. The session's own `accessKey` is
	 * a name that does not depend on what the request carried, so the headerless path retires its
	 * predecessor exactly as the header-carrying one does.
	 */
	it('retires the access token the session records even when the call carried no header', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({
			store,
			ctx: cookieJar().ctx,
			session: boundSession,
			presentedAccessToken: undefined,
			captureException
		})

		expect(store.del.mock.calls).toEqual([[BOUND_ACCESS_KEY], [OLD_KEY]])
	})

	/*
	 * ⚠️ **Both names are followed, because they can genuinely differ.** A client that presents an access
	 * token older than the one its session records — a tab that slept through a rotation, a retry off a
	 * stale copy — names a key the session no longer knows about. Retiring only the bound one would leave
	 * that older token alive, which is the same orphan in the other direction.
	 */
	it('retires both the bound access key and a presented token that names a different one', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({
			store,
			ctx: cookieJar().ctx,
			session: boundSession,
			presentedAccessToken: PRESENTED_ACCESS,
			captureException
		})

		expect(store.del.mock.calls).toEqual([[BOUND_ACCESS_KEY], [hashedKey(PRESENTED_ACCESS)], [OLD_KEY]])
	})

	/*
	 * ⚠️ **And in the ordinary case the two names are one key, which must cost one command.** A client
	 * refreshing with the access token its session records is what every non-reloading tab does, so a
	 * rotation issuing two `del`s for one key would double that command on the commonest path of the auth
	 * surface. The set is what collapses them; asserting the *count* is what stops it being quietly removed,
	 * since a second delete of a deleted key succeeds and no other assertion here would notice.
	 */
	it('issues one delete when the bound key and the presented token name the same access session', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({
			store,
			ctx: cookieJar().ctx,
			session: { ...session, accessKey: hashedKey(PRESENTED_ACCESS) },
			presentedAccessToken: PRESENTED_ACCESS,
			captureException
		})

		expect(store.del.mock.calls).toEqual([[hashedKey(PRESENTED_ACCESS)], [OLD_KEY]])
	})

	/*
	 * ⚠️ The access hash is the session **minus its refresh token and minus the lineage**, and the refresh
	 * hash is the identity plus the lineage and nothing else.
	 *
	 * Holding two hashes is only worth anything while an access-token lookup cannot yield the refresh
	 * token — a resource service reads the access hash on every request, and a refresh token leaking
	 * through it would hand a 30-minute credential the powers of a 90-day one. In the other direction,
	 * keeping the refresh hash minimal is what forces every later refresh to re-read the account: an
	 * email or an onboarding step cached there would outlive the change that invalidated it.
	 *
	 * ⚠️ The lineage is stripped from the access hash for a different reason than the refresh token is: it
	 * is not a credential, it is a **shape** question. The four login writers build the access hash without
	 * it, so leaving it in here would make a rotated session and a freshly logged-in one look different to
	 * every resource service that reads one — and those services validate what they read.
	 */
	it('keeps the refresh token and the lineage out of the access hash, and the account out of the refresh one', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })

		expect(Object.keys(store.hSet.mock.calls[0][1])).toEqual(['email', 'onboardingStep', '_id', 'tier'])
		expect(Object.keys(store.hSet.mock.calls[1][1])).toEqual([
			'_id',
			'tier',
			'familyId',
			'originalLogin',
			'sessionCapDays',
			'accessKey'
		])
	})

	/*
	 * ⚠️ **The same exclusion, asserted from the other end**: a session that already carries `accessKey` must
	 * not have it copied into the access hash it mints. `accessKey` is the one field a rotation re-stamps
	 * rather than propagates, so a copy would name the key this call has just deleted — and a resource
	 * service reading the access hash would see a field the login writers never put there, which is the
	 * shape divergence the lineage is stripped to avoid.
	 */
	it('never lets the bound access key of the consumed session reach the access hash it mints', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const result = await refreshSessionTokens({ store, ctx: cookieJar().ctx, session: boundSession, captureException })

		expect(Object.keys(store.hSet.mock.calls[0][1])).toEqual(['email', 'onboardingStep', '_id', 'tier'])
		expect(store.hSet.mock.calls[1][1]).toMatchObject({ accessKey: hashedKey(`access:${result.accessToken}`) })
		expect(Object.values(store.hSet.mock.calls[0][1])).not.toContain(BOUND_ACCESS_KEY)
	})

	/*
	 * The TTLs are asymmetric on purpose: the access token dies within the hour, the refresh token
	 * carries the session. `accessTokenExpiry` randomises the short one so a mass login does not come
	 * back as a mass refresh at the same second.
	 *
	 * ⚠️ The upper bound is 91 minutes, not the 90 the helper's comments claim. `koa-utils` scales a
	 * continuous `Math.random()` by `61` — the `90 - 30 + 1` of an *integer* range — and then shifts by
	 * 30, so the band is `[30, 91)` minutes. Asserted at the real bound rather than the intended one:
	 * this test runs against a live random number and would otherwise fail roughly one run in sixty.
	 */
	it('gives the access token minutes and the refresh token months', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()

		await refreshSessionTokens({ store, ctx: cookieJar().ctx, session, captureException })

		// [0] is the mint bucket's window; the access token's TTL is the first one the rotation itself arms.
		const accessTtl = store.expire.mock.calls[1][1] as number
		expect(accessTtl).toBeGreaterThanOrEqual(30 * 60)
		expect(accessTtl).toBeLessThan(91 * 60)
		expect(REFRESH_TOKEN_EXPIRY).toBe(90 * 24 * 60 * 60)
	})

	// The cookie carries the *refresh* token — the access token is returned to the caller instead, so a
	// swap here would put a 90-day credential in a header and a 30-minute one in an httpOnly cookie.
	it('sets the new refresh token as an httpOnly cookie and returns the access token separately', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const store = writeStore()
		const { ctx, set } = cookieJar()

		const result = await refreshSessionTokens({ store, ctx, session, captureException })

		expect(set).toHaveBeenCalledExactlyOnceWith('refresh_token', expect.any(String), {
			httpOnly: true,
			sameSite: 'Strict',
			secure: false,
			expirationDate: 0,
			maxAge: REFRESH_TOKEN_EXPIRY * 1000
		})
		expect(set.mock.calls[0][1]).not.toBe(result.accessToken)
		expect(store.hSet.mock.calls[1][0]).toBe(hashedKey(`refresh:${set.mock.calls[0][1]}`))
	})

	/*
	 * The session is `ctx.state.user` — the caller's object, still in use after this returns. The three
	 * services this was extracted from each built the access payload with `delete session.refreshToken`,
	 * which mutated it in place and needed a `@ts-expect-error` to do it; the rest element does the same
	 * job without reaching into the caller.
	 */
	it('leaves the session it was handed untouched', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const live = { ...session }

		await refreshSessionTokens({ store: writeStore(), ctx: cookieJar().ctx, session: live, captureException })

		expect(live).toEqual(session)
	})

	/*
	 * ⚠️ Half a rotation is worse than none: a hash written without its TTL never expires, so a failure
	 * after the first `hSet` would leave an immortal session behind. Both new keys go, and — this is the
	 * part worth asserting — **the old refresh key does not**, since the client still holds it and has
	 * nothing else to log in with.
	 */
	it('deletes both keys it had just written when the rotation fails, and spares the old one', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const boom = new Error('redis is down')
		const store = writeStore({
			hSet: vi.fn(async () => {
				throw boom
			})
		})
		const { ctx, set } = cookieJar()

		expectStatus(
			await rejection(() => refreshSessionTokens({ store, ctx, session, captureException })),
			500,
			'Internal Server Error'
		)

		const keyAccess = store.hSet.mock.calls[0][0] as string
		const keyRefresh = store.hSet.mock.calls[1][0] as string
		// The whole key, anchored: prefix plus 64 hex characters and nothing else. `toContain` on the
		// token would pass on a key that also carried it in the clear somewhere.
		expect(keyAccess).toMatch(new RegExp(`^${REDIS_KEY}[0-9a-f]{64}$`))
		expect(keyRefresh).toMatch(new RegExp(`^${REDIS_KEY}[0-9a-f]{64}$`))
		expect(keyAccess).not.toBe(keyRefresh)
		// ⚠️ Exactly two deletes, and neither shape of the old key among them: the rollback drops what this
		// call minted, and the client still holds the old refresh token and has nothing else to log in with.
		expect(store.del.mock.calls).toEqual([[keyAccess], [keyRefresh]])
		expect(set).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledExactlyOnceWith(boom)
	})

	/*
	 * The last step can fail too, and by then the cookie has already gone out. The rollback still runs,
	 * so the client is left holding a refresh token no hash backs — it logs in again. Recorded because
	 * the alternative reading ("the cookie is set, therefore the rotation committed") is what would talk
	 * someone into skipping the rollback on this path and leaving two TTL-less keys behind instead.
	 */
	it('rolls the new keys back even after the cookie went out', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const boom = new Error('redis is down')
		const store = writeStore({
			del: vi.fn(async (key: string) => {
				if (key === OLD_KEY) throw boom

				return 1
			})
		})
		const { ctx, set } = cookieJar()

		expectStatus(
			await rejection(() => refreshSessionTokens({ store, ctx, session, captureException })),
			500,
			'Internal Server Error'
		)

		expect(set).toHaveBeenCalledOnce()
		// ⚠️ Three deletes, and neither the tombstone nor the family key among them — the rollback does not
		// unwind either, deliberately. The old refresh key survived the failure, so nothing can reach the
		// tombstone (one is read only after a live-key miss) and the rotation that eventually succeeds
		// overwrites it; the family members name keys these very deletes are removing. Unwinding either
		// would add commands to an error path to tidy state that is already inert.
		expect(store.del.mock.calls).toEqual([[OLD_KEY], [store.hSet.mock.calls[0][0]], [store.hSet.mock.calls[1][0]]])
		expect(store.del.mock.calls.flat()).not.toContain(FAMILY_KEY)
		expect(store.del.mock.calls.flat()).not.toContain(OLD_TOMBSTONE_KEY)
	})
})
