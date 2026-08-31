import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PositionType } from '../src/models/types/PositionType.mts'
import { ADMIN_ONLY_FIELDS_SHOP_OWNER, APPROVAL_GATE_FIELD_SHOP_OWNER } from '../src/others/adminOnlyFields.mts'
import { assertTier } from '../src/others/assertTier.mts'
import { assertTurnstile } from '../src/others/assertTurnstile.mts'
import { assertUnderRateLimit, IRateLimitStore } from '../src/others/assertUnderRateLimit.mts'
import { checkShopOwnerApproval } from '../src/others/checkShopOwnerApproval.mts'
import { checkShopOwnerEmailVerified } from '../src/others/checkShopOwnerEmailVerified.mts'
import { checkUserAuthorizationDisDel } from '../src/others/checkUserAuthorizationDisDel.mts'
import { EMAIL_CHECK_LINK, SALT_ROUNDS } from '../src/others/Constants.mts'
import { constantTimeEquals } from '../src/others/constantTimeEquals.mts'
import { isIntrospectionBypassAllowed } from '../src/others/isIntrospectionBypassAllowed.mts'
import { newSessionLineage } from '../src/others/newSessionLineage.mts'
import { guardRefreshAttempt } from '../src/others/refreshRateLimit.mts'
import {
	GRACE_SECONDS,
	resolveSessionCapDays,
	SESSION_CAP_DAYS_DEFAULT,
	SESSION_CAP_DAYS_REMEMBERED
} from '../src/others/sessionLifetime.mts'
import { sha256Hex } from '../src/others/sha256Hex.mts'
import { isTier, TIER } from '../src/others/Tier.mts'
import { expectStatus, rejection } from './graphQLErrors.mts'

describe('Constants', () => {
	it('SALT_ROUNDS is 14', () => {
		expect(SALT_ROUNDS).toBe(14)
	})

	it('EMAIL_CHECK_LINK is the email-check path', () => {
		expect(EMAIL_CHECK_LINK).toBe('/x/email-check')
	})
})

/*
 * The three session-lifetime numbers, asserted as exact values. They are policy, not implementation:
 * each one is a decision written down with its reasoning where it is declared, and a silent edit here is a
 * silent change to how long a stolen token is worth something. The `toBe` is the whole point — a
 * `toBeGreaterThan` would let 30 become 300 and still pass.
 */
describe('sessionLifetime', () => {
	it('SESSION_CAP_DAYS_DEFAULT is one day', () => {
		expect(SESSION_CAP_DAYS_DEFAULT).toBe(1)
	})

	it('SESSION_CAP_DAYS_REMEMBERED is thirty days', () => {
		expect(SESSION_CAP_DAYS_REMEMBERED).toBe(30)
	})

	// Not a restatement of the two cases above: it is the invariant that keeps the physical Redis TTL the
	// safety net rather than the binding limit. A cap longer than REFRESH_TOKEN_EXPIRY would mean sessions
	// the cap says are alive and Redis has already dropped.
	it('keeps both caps under the 90-day physical TTL', () => {
		expect(SESSION_CAP_DAYS_REMEMBERED * 86400).toBeLessThan(REFRESH_TOKEN_EXPIRY)
		expect(SESSION_CAP_DAYS_DEFAULT).toBeLessThan(SESSION_CAP_DAYS_REMEMBERED)
	})

	it('GRACE_SECONDS is ten seconds', () => {
		expect(GRACE_SECONDS).toBe(10)
	})

	it('resolveSessionCapDays gives the long cap only to a literal true', () => {
		expect(resolveSessionCapDays(true)).toBe(SESSION_CAP_DAYS_REMEMBERED)
	})

	/*
	 * The fail-short arm, and the reason the parameter is `unknown` rather than `boolean`. Each of these
	 * is something a caller that is not one of the three login forms can actually send — an omitted
	 * argument, a null from a client that serialises absence that way, the string a query-string parser
	 * produces, the number a JSON body carries. Every one of them takes the short cap.
	 */
	it.each([[false], [undefined], [null], ['true'], [1], [{}]])('falls back to the short cap for %o', (rememberMe) => {
		expect(resolveSessionCapDays(rememberMe)).toBe(SESSION_CAP_DAYS_DEFAULT)
	})
})

/*
 * The lineage a login stamps. One helper for the three tier writers, because a lineage
 * stamped differently in one of them would be a session capped differently from the other two, and nothing
 * downstream could tell.
 */
describe('newSessionLineage', () => {
	const NOW = 1_754_784_000_000

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	/*
	 * ⚠️ Every value is a **string**, and the two numeric ones are asserted as such. A Redis hash gives back
	 * strings whatever went in, and `assertRefreshLineage` refuses anything that is not a non-negative
	 * integer written as one — so a number written here would resolve fine on the machine that wrote it and
	 * be refused by the next service to read it back.
	 */
	it('stamps the three fields the whole chain is checked against', () => {
		const lineage = newSessionLineage(true)

		expect(Object.keys(lineage)).toEqual(['familyId', 'originalLogin', 'sessionCapDays'])
		expect(lineage.originalLogin).toBe(`${NOW}`)
		expect(lineage.sessionCapDays).toBe('30')
		expect(lineage.familyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
	})

	// The three inputs the helper takes, at the writer's own boundary rather than only at
	// `resolveSessionCapDays`.
	it.each([
		[true, '30'],
		[false, '1'],
		[undefined, '1']
	])('resolves the cap of a login whose rememberMe was %o to %s days', (rememberMe, sessionCapDays) => {
		expect(newSessionLineage(rememberMe).sessionCapDays).toBe(sessionCapDays)
	})

	/*
	 * ⚠️ A fresh family per login, never a value derived from a token. Two logins sharing a `familyId` would
	 * make one reuse event revoke both, and a `familyId` derived from a token would put that token back into
	 * a key name that is not a digest — undoing the hashed namespace through the side door.
	 */
	it('mints a family per login, shared by nothing', () => {
		expect(newSessionLineage(true).familyId).not.toBe(newSessionLineage(true).familyId)
	})
})

describe('PositionType', () => {
	it('maps Point -> "Point"', () => {
		expect(PositionType.Point).toBe('Point')
		expect(Object.keys(PositionType)).toEqual(['Point'])
	})
})

describe('checkUserAuthorizationDisDel', () => {
	it('throws when the user is deleted', () => {
		expect(() => checkUserAuthorizationDisDel({ deleted: true, disabled: false } as never)).toThrow()
	})

	it('throws when the user is disabled', () => {
		expect(() => checkUserAuthorizationDisDel({ deleted: false, disabled: true } as never)).toThrow()
	})

	it('deleted takes precedence over disabled', () => {
		expect(() => checkUserAuthorizationDisDel({ deleted: true, disabled: true } as never)).toThrow()
	})

	// The function returns void — assert on the absence of a throw, not on the return
	// value. `expect(fn(...)).toBeUndefined()` reads a void return (Qodana:
	// JSVoidFunctionReturnValueUsed) and kills the same mutants either way.
	it('does not throw for an active user', () => {
		expect(() => checkUserAuthorizationDisDel({ deleted: false, disabled: false } as never)).not.toThrow()
	})
})

/*
 * BC-03's approval gate, which was once written by the Admin tier and read by nothing at all
 * — a shop owner parked pending review could log in and keep working. Both BC-01 services call this
 * now, so the two states below are the whole contract: raised refuses, absent serves.
 *
 * The absent case is not the same test as `waitApprov: false`. `funShopOwnerUpdateStatus` `$unset`s
 * the field rather than storing `false`, so an approved account really has no such key, and a gate
 * written as `=== true` or `!== false` would pass this suite while failing on real data.
 */
describe('checkShopOwnerApproval', () => {
	it('throws when the shop owner is awaiting approval', () => {
		expect(() => checkShopOwnerApproval({ waitApprov: true })).toThrow()
	})

	// Void return: assert the absence of a throw rather than the return value, exactly as the
	// disabled/deleted block above does and for the same Qodana reason.
	it('does not throw when the field is absent, which is what an approved account looks like', () => {
		expect(() => checkShopOwnerApproval({})).not.toThrow()
	})

	it('does not throw when the field is present and false', () => {
		expect(() => checkShopOwnerApproval({ waitApprov: false })).not.toThrow()
	})
})

/*
 * The three states of `emailVerify` on a shop owner, and the reason this gate is written `=== false`.
 *
 * Absent and `valid: false` are NOT the same case here, where on the customer they are: `shopOwnerAdd`
 * writes no `emailVerify` block at all, so every Admin-provisioned account — which is every shop owner
 * that existed before `shopOwnerRegister` shipped — has the absent shape. A gate written `!== true`
 * passes the two interesting tests below and locks all of them out of the platform on deploy.
 */
describe('checkShopOwnerEmailVerified', () => {
	it('throws when a registration was started and the link was never opened', () => {
		expect(() => checkShopOwnerEmailVerified({ emailVerify: { valid: false } })).toThrow()
	})

	it('does not throw when the block is absent, which is what an Admin-provisioned account looks like', () => {
		expect(() => checkShopOwnerEmailVerified({})).not.toThrow()
	})

	// The block present but `valid` unset — the shape koa-utils' email-*change* flow leaves behind. It
	// is not a pending registration and must not be refused as one.
	it('does not throw when the block is present and valid is unset', () => {
		expect(() => checkShopOwnerEmailVerified({ emailVerify: {} })).not.toThrow()
	})

	it('does not throw once the link has been opened', () => {
		expect(() => checkShopOwnerEmailVerified({ emailVerify: { valid: true } })).not.toThrow()
	})
})

/*
 * Three values, one per collection you can authenticate against. Asserted as a whole object and by
 * key list, because the interesting failure is a *fourth* value or a missing one, and a per-key
 * `toBe` would see neither: the platform has no `role` field and no permission enum, so this constant
 * is the only place the tier vocabulary is written down and anything spelled differently anywhere
 * else is a session no service will accept.
 */
describe('TIER', () => {
	it('is exactly one value per tenant collection, each named after its collection', () => {
		expect(TIER).toEqual({ admin: 'admin', shopOwner: 'shopOwner', user: 'user' })
		expect(Object.keys(TIER)).toEqual(['admin', 'shopOwner', 'user'])
	})
})

/*
 * The parsing half of the tier vocabulary, and only that.
 *
 * ⚠️ **Not an authorisation decision and never to be used as one** — `assertTier` below answers "is this
 * session mine to serve"; this answers "is this string a tier at all". Its one caller reads a tombstone
 * that may predate the field, and an event filed under `undefined` would name a trail key no console reads
 * while claiming an account had been logged out.
 */
describe('isTier', () => {
	it.each(Object.values(TIER))('accepts the tier vocabulary itself (%s)', (tier) => {
		expect(isTier(tier)).toBe(true)
	})

	// `undefined` is the shape that actually arrives — a Redis hash answers a missing field with it — and the
	// three strings after it are the near misses: a plausible fourth role, a case slip, and an empty value.
	it.each([undefined, 'superAdmin', 'ShopOwner', ''])('refuses %o, which is not one of the three', (value) => {
		expect(isTier(value)).toBe(false)
	})
})

/*
 * ⚠️ The one thing standing between an Admin access token and the ShopOwner resource API.
 *
 * All nine services share one `REDIS_KEY` prefix — deliberately, because the single logout service
 * finds a session by token content and cannot know which tier minted it — so a session key from any
 * tier is findable by any service. Before this existed, `hGetAll` returning a non-empty hash was the
 * whole check, and a token from the wrong tier was simply accepted.
 */
describe('assertTier', () => {
	it.each(Object.values(TIER))('returns for a session minted for this very tier (%s)', (tier) => {
		expect(() => assertTier(tier, tier)).not.toThrow()
	})

	// The actual hole, in both directions: an Admin token reaching the ShopOwner resource service, and
	// the reverse. Nothing else in the request distinguishes them.
	it.each([
		[TIER.admin, TIER.shopOwner],
		[TIER.shopOwner, TIER.admin],
		[TIER.user, TIER.shopOwner],
		[TIER.shopOwner, TIER.user]
	])('refuses a %s session presented to a %s service', async (actual, expected) => {
		expectStatus(await rejection(() => assertTier(actual, expected)), 403, 'Forbidden')
	})

	/*
	 * ⚠️ A missing `tier` is invalid, not a wildcard, and it has no branch of its own — `undefined !==
	 * expected` is what rejects it.
	 *
	 * Sessions minted before the field existed carry no tier. Treating them as trusted would have kept
	 * the hole open for the whole `REFRESH_TOKEN_EXPIRY` (90 days); rejecting them costs those
	 * sessions one re-login. Fail closed.
	 */
	it.each([undefined, '', 'Admin', 'shopowner'])('refuses %o, because only an exact match is a match', async (actual) => {
		expectStatus(await rejection(() => assertTier(actual, TIER.admin)), 403, 'Forbidden')
	})

	// 403, never 401. The caller authenticated correctly — it simply authenticated somewhere else, and
	// a 401 tells the client to refresh its way out of a situation refreshing cannot fix.
	it('answers 403 rather than 401, so the client does not try to refresh out of it', async () => {
		const error = await rejection(() => assertTier(TIER.admin, TIER.user))

		expect(error.extensions.http).toEqual({ status: 403 })
		expect(error.extensions.http).not.toEqual({ status: 401 })
	})
})

/*
 * The environment allowlist, in one place because the predicate is. What the cases below are
 * really asserting is the *polarity*: every value in the refusing list would be admitted by the
 * `NODE_ENV !== 'production'` form this replaced, and every one of them is a shape a real deploy
 * produces — a container runtime that exports nothing, a shell that exports an empty string, a capital
 * letter, a staging box nobody classified.
 */
describe('isIntrospectionBypassAllowed', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it.each([['development'], ['test']])('allows the bypass under NODE_ENV=%o', (environment) => {
		vi.stubEnv('NODE_ENV', environment)

		expect(isIntrospectionBypassAllowed()).toBe(true)
	})

	it.each([['production'], ['staging'], ['Production'], ['DEVELOPMENT'], ['testing'], ['dev'], [''], [undefined]])(
		'refuses the bypass under NODE_ENV=%o',
		(environment) => {
			vi.stubEnv('NODE_ENV', environment)

			expect(isIntrospectionBypassAllowed()).toBe(false)
		}
	)
})

describe('sha256Hex', () => {
	// Digests written as literals, computed elsewhere. A test that hashed the input with the same call
	// the implementation makes would agree with it about any algorithm, including a mutated one.
	it.each([
		['mario@example.com', '94975275c0782c9df03b43f60e2da7f45d8fe447c73d4c52fad895d2937ae9e3'],
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']
	])('digests %o to the known SHA-256', (value, digest) => {
		expect(sha256Hex(value)).toBe(digest)
	})

	// Lower-case hex, and 64 characters of it: the encoding is part of the key format, and a `base64`
	// digest would still be a digest while silently changing every Redis key the limiter writes.
	it('returns 64 lower-case hex characters', () => {
		expect(sha256Hex('mario@example.com')).toMatch(/^[0-9a-f]{64}$/)
	})

	// ⚠️ It does not normalise. Case folding here would let the limiter meter what the account lookup
	// never matches on, and the callers already lower-case and trim before either sees the address.
	it('does not fold case — A@x.it and a@x.it are two identities', () => {
		expect(sha256Hex('A@x.it')).toBe('fd422176584775609e253e4da40b5e14ca921e1d6cc1964904e4ec27eb9a8e40')
		expect(sha256Hex('a@x.it')).toBe('7b52b85a621e206ba35f4d3cc103f34909f0e3c5e1d79d839b27be119b03a813')
		expect(sha256Hex('A@x.it')).not.toBe(sha256Hex('a@x.it'))
	})

	it('is a pure function of its input', () => {
		expect(sha256Hex('mario@example.com')).toBe(sha256Hex('mario@example.com'))
	})
})

describe('assertUnderRateLimit', () => {
	// The identity's digest, written out as a literal rather than computed here: a test that hashed the
	// value itself would agree with the implementation about any algorithm, including a mutated one.
	const KEY = 'test:rl:login:857b6e3f78989500a2e460a084bb142eed749b2c938b938edcad77abf521aa19'

	const store = (
		over: Partial<IRateLimitStore> = {}
	): IRateLimitStore & { [K in keyof IRateLimitStore]: ReturnType<typeof vi.fn> } => ({
		incr: vi.fn(async () => 1),
		ttl: vi.fn(async () => -1),
		expire: vi.fn(async () => 1),
		...over
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	const limiter = (s: IRateLimitStore) => assertUnderRateLimit(s, 'login', 'mark@rivers.test', 5, 60)

	// The prefix comes from the environment and the rest is built here, so the whole key is asserted
	// literally. A bucket or an identity that fell out of it would silently merge two limits into one
	// — every caller of `login` sharing a single counter is a platform-wide lockout.
	it('counts against one key per prefix, bucket and identity', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store()

		await limiter(s)

		expect(s.incr).toHaveBeenCalledExactlyOnceWith(KEY)
	})

	// The identity is hashed and the bucket is not. Asserting only that the key differs from the address
	// is satisfied by a mutant that reverses the string, so both halves are pinned by shape as well: the
	// digest is 64 lower-case hex characters and `rl:login:` is still readable in front of it.
	it('carries no plaintext identity, and keeps the bucket readable', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store()

		await limiter(s)

		const key = s.incr.mock.calls[0][0] as string

		expect(key).not.toContain('mark@rivers.test')
		expect(key).toContain('test:rl:login:')
		expect(key.slice('test:rl:login:'.length)).toMatch(/^[0-9a-f]{64}$/)
	})

	/*
	 * INCR on a missing key creates it with **no TTL**, so the window is armed by hand — and on the
	 * first call of a window the TTL is not read at all, which is what the `||` short-circuit is for.
	 *
	 * The stub answers a live TTL of 5 s deliberately: it is the one answer under which the two halves
	 * of that condition disagree, so a test where `ttl` returned -1 would pass just as happily with
	 * the short-circuit gone.
	 */
	it('arms the window on the first call without reading the TTL', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ ttl: vi.fn(async () => 5) })

		await limiter(s)

		expect(s.expire).toHaveBeenCalledExactlyOnceWith(KEY, 60)
		expect(s.ttl).not.toHaveBeenCalled()
	})

	// Re-arming on every call would push the expiry forward on each request and never let the key die
	// under sustained traffic — the limit would hold forever instead of for a window.
	it('leaves a live window alone on a later call', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ incr: vi.fn(async () => 2), ttl: vi.fn(async () => 5) })

		await limiter(s)

		expect(s.ttl).toHaveBeenCalledExactlyOnceWith(KEY)
		expect(s.expire).not.toHaveBeenCalled()
	})

	// A TTL of exactly 0 is a key that expires this second, not one with no expiry at all: the bound
	// is `< 0`, and `<= 0` would re-arm a window that was about to close on its own.
	it('treats a TTL of zero as a live window', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ incr: vi.fn(async () => 2), ttl: vi.fn(async () => 0) })

		await limiter(s)

		expect(s.expire).not.toHaveBeenCalled()
	})

	// The repair arm. Arming only when the counter reads 1 leaves the key immortal if the process dies
	// between the INCR and the EXPIRE, which locks that identity out for good; a negative TTL is what
	// that looks like from the outside, and any later call fixes it.
	it('repairs a lost EXPIRE on any later call', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ incr: vi.fn(async () => 3), ttl: vi.fn(async () => -1) })

		await limiter(s)

		expect(s.expire).toHaveBeenCalledExactlyOnceWith(KEY, 60)
	})

	// The boundary itself: the fifth call of a limit of five is allowed, the sixth is not. `>=` here
	// would spend the allowance one request early, and `<` would never refuse at all.
	it('lets the last call inside the allowance through', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')

		await expect(limiter(store({ incr: vi.fn(async () => 5), ttl: vi.fn(async () => 5) }))).resolves.toBeUndefined()
	})

	it('refuses the first call past the allowance with a 429', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ incr: vi.fn(async () => 6), ttl: vi.fn(async () => 5) })

		expectStatus(await rejection(() => limiter(s)), 429, 'Too Many Requests')
	})

	// The counter is still incremented and the window still armed on a refused call — a fixed window
	// counts attempts, not successes, so hammering it cannot keep the window from closing.
	it('still counts the refused call', async () => {
		vi.stubEnv('REDIS_KEY', 'test:')
		const s = store({ incr: vi.fn(async () => 9), ttl: vi.fn(async () => -1) })

		await rejection(() => limiter(s))

		expect(s.incr).toHaveBeenCalledExactlyOnceWith(KEY)
		expect(s.expire).toHaveBeenCalledExactlyOnceWith(KEY, 60)
	})

	/*
	 * The pre-lookup half of the limiter: what one *attempt* at a rotation costs, whether or not the token
	 * behind it
	 * exists. It is the only identity available before the session read, and the only limiter that ever sees
	 * a token that resolves to no family at all — garbage, expired, tombstoned.
	 *
	 * ⚠️ **Twenty per minute, not per hour**, and the short window is a memory decision rather than a
	 * security one: this is the only Redis structure an attacker creates at will, one key per distinct
	 * token, so an hour-long window would hold sixty times as many of them.
	 */
	describe('guardRefreshAttempt', () => {
		/*
		 * The token digest hashed a second time by the limiter — both literals, neither computed here. The
		 * first is `sha256('refresh:old-refresh-token')`, the second is `sha256` of *that string*.
		 *
		 * ⚠️ The double hash is not an oversight. `assertUnderRateLimit` bans a raw token as an identity, so
		 * what is handed to it is already a session-key digest; the limiter then builds its own key from that.
		 * One extra `sha256` per attempt, and no live credential is ever an argument to the limiter.
		 */
		const REFRESH_KEY = 'test:rl:refresh:token:8ba1ddeaec9dc556437fdc381e377aa10e2d7d0e4cb66e857982b31b28da8d40'
		const TOKEN = 'refresh:old-refresh-token'

		it('counts one attempt per token, in its own bucket, over a minute', async () => {
			vi.stubEnv('REDIS_KEY', 'test:')
			const s = store()

			await guardRefreshAttempt(s, TOKEN)

			expect(s.incr).toHaveBeenCalledExactlyOnceWith(REFRESH_KEY)
			expect(s.expire).toHaveBeenCalledExactlyOnceWith(REFRESH_KEY, 60)
		})

		// ⚠️ Neither the token nor its session-key digest may appear in the counter's key. The first would be
		// a live credential in a key name — the thing the hashed namespace removed — and the second would let
		// anyone who
		// could read the rate-limit keyspace derive the session keyspace from it.
		it('carries neither the token nor its session key', async () => {
			vi.stubEnv('REDIS_KEY', 'test:')
			const s = store()

			await guardRefreshAttempt(s, TOKEN)

			const key = s.incr.mock.calls[0][0] as string

			expect(key).not.toContain('old-refresh-token')
			expect(key).not.toContain('c934d70b631c47c68f5194a79773e210010efc6874a72193dd1c1e55032ddd6c')
			expect(key.slice('test:rl:refresh:token:'.length)).toMatch(/^[0-9a-f]{64}$/)
		})

		// The boundary, both sides: twenty allowed, the twenty-first refused. A limit of twenty attempts
		// against a token whose session does not exist is what makes guessing one cost something.
		it('lets the twentieth attempt through and refuses the twenty-first', async () => {
			vi.stubEnv('REDIS_KEY', 'test:')

			await expect(guardRefreshAttempt(store({ incr: vi.fn(async () => 20) }), TOKEN)).resolves.toBeUndefined()
			expectStatus(
				await rejection(() => guardRefreshAttempt(store({ incr: vi.fn(async () => 21) }), TOKEN)),
				429,
				'Too Many Requests'
			)
		})

		// Two different tokens are two different counters — a shared one would let any caller spend every
		// other caller's allowance, which is a platform-wide logout dressed up as a rate limit.
		it('gives each token its own counter', async () => {
			vi.stubEnv('REDIS_KEY', 'test:')
			const s = store()

			await guardRefreshAttempt(s, TOKEN)
			await guardRefreshAttempt(s, 'refresh:another-token')

			expect(s.incr.mock.calls[0][0]).not.toBe(s.incr.mock.calls[1][0])
		})
	})
})

/*
 * Cloudflare Turnstile. A bot cost multiplier and not an authentication step — `assertUnderRateLimit`
 * is what bounds a determined attacker who has bought solves — so what matters here is which way it
 * fails, and it fails closed everywhere it can.
 */
describe('assertTurnstile', () => {
	const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

	const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>()

	const stub = (response: Response) => {
		fetchMock.mockReset()
		fetchMock.mockResolvedValue(response)
		vi.stubGlobal('fetch', fetchMock)
	}

	const sentBody = () => String(fetchMock.mock.calls[0][1].body as URLSearchParams)

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		fetchMock.mockReset()
	})

	/*
	 * ⚠️ Fails closed in production with no secret configured, and this is the asymmetry that matters:
	 * a missing `TURNSTILE_SECRET` is a deployment mistake, and the safe reading of it is "the gate is
	 * broken", not "the gate is off".
	 */
	it('refuses every gated call in production when no secret is configured', async () => {
		vi.stubEnv('TURNSTILE_SECRET', undefined)
		vi.stubEnv('NODE_ENV', 'production')
		stub(Response.json({ success: true }))

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	/*
	 * And bypasses everywhere else — silently, with no call to Cloudflare.
	 *
	 * Integration suites and local development have no site key, so without this arm no test on the
	 * platform could register a user. It is also why `TURNSTILE_SECRET` is deliberately absent from
	 * every service's `REQUIRED_ENV_VARS`: those abort the process at boot, and a service that cannot
	 * start without a captcha secret cannot run its own tests.
	 *
	 * The token is passed anyway: without a secret this must return before it is even looked at, and
	 * asserting that `fetch` stayed untouched is what tells the bypass apart from a verification that
	 * happened to succeed.
	 */
	it.each(['test', 'development', undefined])('waves the call through with no secret under NODE_ENV=%o', async (nodeEnv) => {
		vi.stubEnv('TURNSTILE_SECRET', undefined)
		vi.stubEnv('NODE_ENV', nodeEnv)
		stub(Response.json({ success: true }))

		await expect(assertTurnstile('tok-abc')).resolves.toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	// A configured secret and no token is a client that skipped the widget — refused before any
	// request is made, since there is nothing to verify.
	it.each([undefined, ''])('refuses a missing token (%o) without asking Cloudflare', async (token) => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: true }))

		expectStatus(await rejection(() => assertTurnstile(token)), 403, 'Forbidden')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	// The whole request, spelled out. The endpoint, the verb, the form encoding and the two mandatory
	// form fields are each what Cloudflare's API requires, and a wrong one answers a JSON body with
	// `success: false` — which this guard reads as "the visitor is a bot" rather than "we asked
	// wrongly", so a silent mistake here closes registration for everyone.
	it('posts the secret and the token as a form body, with a timeout', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: true }))

		await assertTurnstile('tok-abc')

		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(VERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: expect.any(URLSearchParams),
			signal: expect.any(AbortSignal)
		})
		expect(sentBody()).toBe('secret=secret-v1&response=tok-abc')
		// Bounded by the signal rather than by the OS default, which is minutes: without it a hung
		// verifier holds the request — and the connection behind it — open for that long.
		expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(false)
	})

	// ⚠️ The body is two parameters and there is no third. This replaces an assertion that pinned
	// `&remoteip=203.0.113.7` — the client address used to be sent to Cloudflare here, and this path was
	// the last one on which one left the platform. Cloudflare observed that address when the browser
	// solved the challenge, so repeating it bought no signal; the parameter is gone from the signature,
	// so no caller can put it back without changing this package.
	it('sends the secret and the token and nothing else', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: true }))

		await assertTurnstile('tok-abc')

		expect([...new URLSearchParams(sentBody()).keys()]).toEqual(['secret', 'response'])
		expect(sentBody()).not.toContain('remoteip')
	})

	it('accepts a token Cloudflare verified', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: true }))

		await expect(assertTurnstile('tok-abc')).resolves.toBeUndefined()
	})

	// `success: false` is the ordinary refusal — a replayed token, an expired one, a bot.
	it('refuses a token Cloudflare rejected', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }))

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
	})

	// Anything that is not exactly `true` is a refusal, including a body that never mentions the field
	// — an answer this guard does not understand is not an answer it may act on.
	it.each([{}, { success: 'true' }, { success: 1 }, { success: null }])('refuses the unparseable answer %o', async (payload) => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json(payload))

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
	})

	/*
	 * ⚠️ A non-2xx answer is a failed verification, and the body is never read.
	 *
	 * `fetch` only rejects on a transport failure, so a 500 from Cloudflare arrives as a resolved
	 * response carrying an HTML error page. The payload below is deliberately a *valid success body*:
	 * a guard that parsed it regardless of the status would let every visitor through for as long as
	 * the outage lasted, and would look identical to a working one from the outside.
	 */
	it('refuses on a non-2xx answer without reading its body', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(Response.json({ success: true }, { status: 500 }))

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
	})

	// A 200 carrying something that is not JSON — an interception page, a proxy's error document.
	// `res.json()` rejects, and the catch turns that into a refusal rather than a 500 for the visitor.
	it('refuses a 2xx answer that is not JSON', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		stub(new Response('<html>captive portal</html>', { status: 200 }))

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
	})

	// The outage arm: an unreachable Cloudflare closes registration rather than opening it. Neither the
	// error nor the token is logged — the token is attacker-supplied, and the outcome is already known.
	it('refuses when the verifier cannot be reached at all', async () => {
		vi.stubEnv('TURNSTILE_SECRET', 'secret-v1')
		fetchMock.mockReset()
		fetchMock.mockRejectedValue(new TypeError('fetch failed'))
		vi.stubGlobal('fetch', fetchMock)

		expectStatus(await rejection(() => assertTurnstile('tok-abc')), 403, 'Forbidden')
	})
})

/*
 * The constant-time comparison. The cases below are ordinary equality cases on purpose: what
 * is being asserted is that removing the timing gradient did not change *which* pairs are equal. The
 * timing property itself is not measurable from a unit test on a JIT runtime — it is a property of the
 * construction (two fixed-width HMAC digests, no size check, no early exit), and the test that guards it
 * is the `length` grep in the story plus the shape assertions below.
 */
describe('constantTimeEquals', () => {
	it('answers true for two identical strings', () => {
		expect(constantTimeEquals('introspect-me', 'introspect-me')).toBe(true)
	})

	it('answers false for two different strings of the same width', () => {
		expect(constantTimeEquals('introspect-me', 'introspect-yo')).toBe(false)
	})

	// A prefix of the configured value is the shape a timing attack walks through, one character at a
	// time. It is no more equal than any other wrong answer.
	it('answers false for a prefix of the other operand', () => {
		expect(constantTimeEquals('introspect', 'introspect-me')).toBe(false)
	})

	it('answers false when the first operand is the wider one', () => {
		expect(constantTimeEquals('introspect-me-too', 'introspect-me')).toBe(false)
	})

	it('answers true for two empty strings', () => {
		expect(constantTimeEquals('', '')).toBe(true)
	})

	it('answers false when only one operand is empty', () => {
		expect(constantTimeEquals('', 'introspect-me')).toBe(false)
		expect(constantTimeEquals('introspect-me', '')).toBe(false)
	})

	// An absent header takes the same path a wrong one takes: the helper is still called and still
	// computes both digests. No `if (!value) return false` guard sits in front of it, because that guard
	// is the timing signal this function exists to remove.
	it('answers false for an absent operand against a configured value', () => {
		expect(constantTimeEquals(undefined, 'introspect-me')).toBe(false)
		expect(constantTimeEquals('introspect-me', undefined)).toBe(false)
	})

	// The empty string the absent operand folds to is a value, not a wildcard: it matches the empty
	// string and nothing else. Asserting it against a literal keeps a mutated fold from passing.
	it('folds an absent operand to the empty string and to nothing else', () => {
		expect(constantTimeEquals(undefined, '')).toBe(true)
		expect(constantTimeEquals(undefined, 'Stryker was here')).toBe(false)
		expect(constantTimeEquals('Stryker was here', undefined)).toBe(false)
	})

	// A repeated HTTP header arrives as an array. It is not a code, and it is not joined into one either
	// — `['a', 'b']` must not match the configured value `a,b`.
	it('answers false for a repeated header, whatever it would join to', () => {
		expect(constantTimeEquals(['a', 'b'], 'a,b')).toBe(false)
		expect(constantTimeEquals(['introspect-me'], 'introspect-me')).toBe(false)
	})

	it('answers true consistently across calls, so the per-process key is stable', () => {
		expect(constantTimeEquals('introspect-me', 'introspect-me')).toBe(true)
		expect(constantTimeEquals('introspect-me', 'introspect-me')).toBe(true)
	})

	// The HMAC key never leaves the process: the module exports the comparison and nothing else, so there
	// is no accessor to log it through, write it to Redis with, or assert against.
	it('exports the comparison and nothing else', async () => {
		const module = await import('../src/others/constantTimeEquals.mts')

		expect(Object.keys(module)).toEqual(['constantTimeEquals'])
	})
})

/*
 * Exactly one `createHash` call is left in this package — `sha256Hex`, the pseudonymisation primitive.
 * `constantTimeEquals` added a *comparison* primitive next to it, and the natural way to write that one is
 * a second `createHash`. This asserts the count rather than trusting a review to notice: a bare digest of
 * a caller-supplied candidate is precomputable, which is the whole reason `constantTimeEquals` keys its
 * hash.
 *
 * ⚠️ It counts `createHash(` — the **call** — rather than the bare word a grep would name. The word
 * also appears in `sha256Hex.mts`'s import and in two docstrings that exist to say which primitive
 * belongs where, and a check that forbade *writing about* the distinction would be deleted by the first
 * person who documented it correctly.
 */
describe('the hashing primitives', () => {
	const sources = (directory: string): string[] =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name)
			return entry.isDirectory() ? sources(path) : path.endsWith('.mts') ? [path] : []
		})

	it('keeps createHash to the single call in sha256Hex', () => {
		const hits = sources('src').filter((path) => readFileSync(path, 'utf8').includes('createHash('))

		expect(hits).toEqual([join('src', 'others', 'sha256Hex.mts')])
	})

	it('has constantTimeEquals reach for createHmac instead', () => {
		const source = readFileSync(join('src', 'others', 'constantTimeEquals.mts'), 'utf8')

		expect(source).toContain('createHmac(')
		expect(source).not.toContain('createHash(')
	})
})

/*
 * The admin-only field list, held to the model it names.
 *
 * Two assertions, and the second is the one that matters. The list is the input to three
 * `no-restricted-syntax` blocks in three service repos, and an eslint selector matching `notes`
 * protects nothing the moment the field is called something else — the rule keeps passing, forever,
 * on a name that no longer exists. Nothing in those repos can notice: they do not own the shape. This
 * repo does, so the rename fails here.
 *
 * `toEqual` on the exact contents rather than a membership check: the whole value of the list is that
 * it is *complete*, and a `toContain` would let a field be dropped from it — quietly widening what the
 * three services are allowed to select — while staying green.
 */
describe('ADMIN_ONLY_FIELDS_SHOP_OWNER', () => {
	// Dynamic and inside `beforeEach`, for the reason `models.test.mts` documents at length on its own
	// ShopOwner block: ShopOwner.mts builds a Schema with an inline `_id: false` that throws
	// synchronously if a mutant flips it, and a top-level import moves that throw into Vitest's
	// collection phase, where Stryker does not see it and reports the mutant as Survived.
	// `beforeEach` rather than `beforeAll` — REPO.md's rule — because a throw in `beforeAll` marks the
	// tests below *skipped*, and the vitest-runner does not count a skipped test as a kill either.
	let ShopOwner: (typeof import('../src/models/MongoDB/ShopOwner.mts'))['ShopOwner']

	beforeEach(async () => {
		;({ ShopOwner } = await import('../src/models/MongoDB/ShopOwner.mts'))
	})

	it('names the admin notes and the approval gate, and nothing else', () => {
		expect(ADMIN_ONLY_FIELDS_SHOP_OWNER).toEqual(['notes'])
	})

	it('names only fields that still exist on ShopOwnerSchema', () => {
		expect(ADMIN_ONLY_FIELDS_SHOP_OWNER.map((field) => ShopOwner.schema.path(field)?.path)).toEqual(['notes'])
	})

	/*
	 * The approval gate left the list above when it stopped being read-by-nobody, but it needs the
	 * same rename trap: three eslint blocks and two projections spell `waitApprov` as a string, and
	 * none of them fails when the model calls the field something else. This assertion does.
	 */
	it('APPROVAL_GATE_FIELD_SHOP_OWNER still names a real path on ShopOwnerSchema', () => {
		expect(ShopOwner.schema.path(APPROVAL_GATE_FIELD_SHOP_OWNER)?.path).toBe('waitApprov')
	})
})
