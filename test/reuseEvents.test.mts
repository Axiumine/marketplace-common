import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	IReuseEvent,
	IReuseEventStore,
	recordReuseEvent,
	REUSE_EVENTS_MAX,
	REUSE_EVENTS_TTL_SECONDS
} from '../src/others/recordReuseEvent.mts'
import { REUSE_EVENT_ACTIONS } from '../src/others/ReuseEventAction.mts'
import { SESSION_INDEX_TTL_SECONDS } from '../src/others/sessionKeys.mts'
import { TIER } from '../src/others/Tier.mts'

const REDIS_KEY = 'test:'
const ACCOUNT_ID = '68b0f2c1a2b3c4d5e6f70819'
const FAMILY_ID = '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d'
const TRAIL_KEY = `${REDIS_KEY}reuse:shopOwner:${ACCOUNT_ID}`

const NOW = 1_754_784_000_000

const event = (over: Partial<IReuseEvent> = {}): IReuseEvent => ({
	familyId: FAMILY_ID,
	tier: TIER.shopOwner,
	accountId: ACCOUNT_ID,
	action: 'refreshTokenReplayed',
	at: `${NOW}`,
	...over
})

const store = (
	over: Partial<IReuseEventStore> = {}
): IReuseEventStore & { [K in keyof IReuseEventStore]: ReturnType<typeof vi.fn> } => ({
	lPush: vi.fn(async () => 1),
	lTrim: vi.fn(async () => 'OK'),
	expire: vi.fn(async () => 1),
	...over
})

/**
 * A Redis list, as much of one as the bound needs: `lPush` prepends, `lTrim` keeps an inclusive range.
 * The stub above proves the *commands*; this proves what they do to the stored data, which is the only
 * way "the trail cannot grow without limit" is an assertion rather than a claim about two arguments.
 */
const fakeList = () => {
	const lists = new Map<string, string[]>()

	return {
		lists,
		lPush: vi.fn(async (key: string, element: string) => {
			const list = lists.get(key) ?? []

			list.unshift(element)
			lists.set(key, list)

			return list.length
		}),
		lTrim: vi.fn(async (key: string, start: number, stop: number) => {
			lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1))

			return 'OK'
		}),
		expire: vi.fn(async () => 1)
	}
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('REUSE_EVENT_ACTIONS', () => {
	/*
	 * ⚠️ The exact list, asserted as a list. E17-S01 has `marketplace-admin`'s generated GraphQL enum
	 * asserted equal to this constant, so a value added here without a schema change fails there — which is
	 * only true while this test pins the membership rather than a count or an inclusion.
	 */
	it('is exactly the two actions the two revocation call sites file', () => {
		expect([...REUSE_EVENT_ACTIONS]).toEqual(['refreshTokenReplayed', 'sessionCapReached'])
		expect(REUSE_EVENT_ACTIONS).toHaveLength(2)
	})

	// An admin's own revocation is not in the vocabulary, and E17's open question 4 is why. The assertion
	// is here so that adding it is a deliberate act with a failing test in front of it, not a quiet append.
	it('carries no value for an admin-initiated revocation', () => {
		expect(REUSE_EVENT_ACTIONS).not.toContain('adminRevoked')
	})
})

describe('recordReuseEvent', () => {
	// ⚠️ Three single-key commands (BCON-08), and the key is the account's own trail — not the family's, and
	// not a global one: the console reads one account at a time, and a shared list would be a `SCAN` away.
	it('appends the serialised event to the account trail, trims it and re-arms the expiry', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await expect(recordReuseEvent({ store: s, event: event() })).resolves.toBeUndefined()

		expect(s.lPush).toHaveBeenCalledExactlyOnceWith(TRAIL_KEY, JSON.stringify(event()))
		expect(s.lTrim).toHaveBeenCalledExactlyOnceWith(TRAIL_KEY, 0, REUSE_EVENTS_MAX - 1)
		expect(s.expire).toHaveBeenCalledExactlyOnceWith(TRAIL_KEY, REUSE_EVENTS_TTL_SECONDS)
	})

	/*
	 * ⚠️ Push, then trim, then expire — and the order is the bound. Trimming before pushing leaves the list
	 * one over its limit for the width of a round trip, and arming the TTL before the append would fix a
	 * deadline on a trail that is then written to.
	 */
	it('pushes before it trims, and trims before it expires', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const order: string[] = []
		const s = store({
			lPush: vi.fn(async () => order.push('lPush')),
			lTrim: vi.fn(async () => order.push('lTrim')),
			expire: vi.fn(async () => order.push('expire'))
		})

		await recordReuseEvent({ store: s, event: event() })

		expect(order).toEqual(['lPush', 'lTrim', 'expire'])
	})

	/*
	 * ⚠️ **The stored line is the whole contract with E13 and E14-S04: nothing replayable.** Five fields, and
	 * the count is asserted so that a sixth carrying a token, a digest of one, or the IP the replay came from
	 * cannot be added without this failing. A dump of the trail must stay useless to whoever reads it.
	 */
	it('stores five fields and nothing that could be replayed', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await recordReuseEvent({ store: s, event: event() })

		const stored = JSON.parse(s.lPush.mock.calls[0][1]) as Record<string, string>

		expect(stored).toEqual({
			familyId: FAMILY_ID,
			tier: TIER.shopOwner,
			accountId: ACCOUNT_ID,
			action: 'refreshTokenReplayed',
			at: `${NOW}`
		})
		expect(Object.keys(stored)).toHaveLength(5)
	})

	// The tier is half the key, so the same account id under two tiers writes two trails — the collision
	// `sessionIndexKey` guards against, guarded the same way here.
	it('files the event under the tier its account belongs to', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await recordReuseEvent({ store: s, event: event({ tier: TIER.admin }) })

		expect(s.lPush.mock.calls[0][0]).toBe(`${REDIS_KEY}reuse:admin:${ACCOUNT_ID}`)
	})

	/*
	 * ⚠️ **The bound, proved against a list that actually stores what it is handed.** E17-S05 asks for a
	 * stated bound on growth *and a test of it*: 60 appends leave 50 entries, the newest is first, and the
	 * ten oldest are gone. Asserting the `lTrim` arguments alone would pass on an implementation that trims
	 * the wrong end and answers an admin with the ten events furthest from the incident.
	 */
	it('never lets one account trail exceed REUSE_EVENTS_MAX, keeping the newest', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = fakeList()

		for (let i = 0; i < REUSE_EVENTS_MAX + 10; i++) {
			await recordReuseEvent({ store: s, event: event({ at: `${NOW + i}` }) })
		}

		const trail = (s.lists.get(TRAIL_KEY) ?? []).map((line) => (JSON.parse(line) as IReuseEvent).at)

		expect(trail).toHaveLength(REUSE_EVENTS_MAX)
		expect(REUSE_EVENTS_MAX).toBe(50)
		expect(trail[0]).toBe(`${NOW + REUSE_EVENTS_MAX + 9}`)
		expect(trail.at(-1)).toBe(`${NOW + 10}`)
	})

	// Every append re-arms the expiry, so a trail being written to during an incident does not age out
	// mid-investigation — thirty days from the *last* event, which is why `expire` is called every time.
	it('re-arms the same TTL on every append, not only on the first', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await recordReuseEvent({ store: s, event: event() })
		await recordReuseEvent({ store: s, event: event({ action: 'sessionCapReached' }) })

		expect(s.expire.mock.calls).toEqual([
			[TRAIL_KEY, REUSE_EVENTS_TTL_SECONDS],
			[TRAIL_KEY, REUSE_EVENTS_TTL_SECONDS]
		])
	})

	// The retention is E15's session-index figure, reused rather than chosen again: a trail must not outlive
	// the sessions it describes by an interval nobody decided on.
	it('retains a trail for the same thirty days a session index row gets', () => {
		expect(REUSE_EVENTS_TTL_SECONDS).toBe(SESSION_INDEX_TTL_SECONDS)
		expect(REUSE_EVENTS_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
	})
})
