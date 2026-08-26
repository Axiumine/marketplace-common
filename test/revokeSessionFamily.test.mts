import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IReuseEvent } from '../src/others/recordReuseEvent.mts'
import { ISessionFamilyStore, revokeSessionFamily } from '../src/others/revokeSessionFamily.mts'
import { TIER } from '../src/others/Tier.mts'

const REDIS_KEY = 'test:'
const FAMILY_ID = '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d'
const FAMILY_KEY = `${REDIS_KEY}family:${FAMILY_ID}`

const ACCOUNT_ID = '68b0f2c1a2b3c4d5e6f70819'
const ACCOUNT = { tier: TIER.shopOwner, accountId: ACCOUNT_ID }
const TRAIL_KEY = `${REDIS_KEY}reuse:shopOwner:${ACCOUNT_ID}`

const NOW = 1_754_784_000_000

const MEMBERS = [`${REDIS_KEY}${'a'.repeat(64)}`, `${REDIS_KEY}${'b'.repeat(64)}`, `${REDIS_KEY}${'c'.repeat(64)}`]

/*
 * ⚠️ The stub carries `sMembers`, `del` and the three trail commands, and **no `hGetAll`** — deliberately,
 * and it is the point of the extraction. The routine is reachable with a store that cannot read a session,
 * which is the proof that widening `ISessionReadStore` bought a delegation rather than a dependency.
 */
const store = (
	over: Partial<ISessionFamilyStore> = {}
): ISessionFamilyStore & { [K in keyof ISessionFamilyStore]: ReturnType<typeof vi.fn> } => ({
	sMembers: vi.fn(async () => MEMBERS),
	del: vi.fn(async () => 1),
	lPush: vi.fn(async () => 1),
	lTrim: vi.fn(async () => 'OK'),
	expire: vi.fn(async () => 1),
	...over
})

const revoke = (s: ISessionFamilyStore, over: Partial<Parameters<typeof revokeSessionFamily>[0]> = {}) =>
	revokeSessionFamily({ store: s, familyId: FAMILY_ID, account: ACCOUNT, action: 'refreshTokenReplayed', ...over })

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(NOW)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe('revokeSessionFamily', () => {
	/*
	 * ⚠️ One `del` per member, each with exactly one key (BCON-08). The argument count is asserted, not just
	 * the key set: `del(...members)` would satisfy a laxer test, work on this single node, and fail the day
	 * the store becomes a cluster — with revocation as the thing that broke.
	 */
	it('deletes every member with its own single-key del, and the family key last', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revoke(s)

		expect(s.sMembers).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY)
		expect(s.del.mock.calls).toEqual([[MEMBERS[0]], [MEMBERS[1]], [MEMBERS[2]], [FAMILY_KEY]])
		expect(s.del.mock.calls.every((call) => call.length === 1)).toBe(true)
	})

	/*
	 * ⚠️ The order is the recoverability of the walk. The family key is the only record of what is left to
	 * delete, so deleting it before its members turns a mid-way failure into a lineage nobody can finish
	 * revoking — a stolen token surviving the very request that detected it.
	 */
	it('never deletes the family key before a member', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revoke(s)

		const keys = s.del.mock.calls.map(([key]) => key)

		expect(keys.indexOf(FAMILY_KEY)).toBe(keys.length - 1)
	})

	// The members are the keys themselves, digests included, never the tokens they were built from: a set of
	// tokens would be a list of live credentials sitting in the store E13-S01 took them out of.
	it('deletes the members verbatim, hashing nothing again', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revoke(s)

		expect(s.del.mock.calls.slice(0, MEMBERS.length).flat()).toEqual(MEMBERS)
	})

	/*
	 * ⚠️ A family whose sessions already expired revokes quietly. This runs on the request that discovered a
	 * theft and that request has its own `throw` to reach: dying on a missing key would answer a replay with
	 * a 500 and leave the rest of the lineage alive.
	 */
	it('revokes a family whose members are already gone, without throwing', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ del: vi.fn(async () => 0) })

		await expect(revoke(s)).resolves.toBeUndefined()

		expect(s.del).toHaveBeenCalledTimes(MEMBERS.length + 1)
	})

	// An empty set still deletes the family key: the set outlives its members by TTL, so "no members" is the
	// ordinary end state of a lineage rather than an error, and leaving the key behind would accumulate one
	// dead set per login.
	it('deletes the family key even when the set is empty', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store({ sMembers: vi.fn(async () => []) })

		await revoke(s)

		expect(s.del).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY)
	})

	/*
	 * ⚠️ The trail carries the lineage, the account, the action and the time — and no token, no digest of one
	 * and nothing network-derived (E17-S05). The stored line is parsed and compared whole, key count
	 * included, so a sixth field cannot appear here without this failing.
	 */
	it('appends one event naming the lineage, the account, the action and the time', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revoke(s, { action: 'sessionCapReached' })

		expect(s.lPush).toHaveBeenCalledExactlyOnceWith(
			TRAIL_KEY,
			JSON.stringify({
				familyId: FAMILY_ID,
				tier: TIER.shopOwner,
				accountId: ACCOUNT_ID,
				action: 'sessionCapReached',
				at: `${NOW}`
			})
		)
		expect(Object.keys(JSON.parse(s.lPush.mock.calls[0][1]) as IReuseEvent)).toHaveLength(5)
	})

	/*
	 * ⚠️ **Revoke first, record last.** A failed append after a successful revocation leaves an operator
	 * without an explanation; the reverse leaves a trail claiming a logout that never happened, which is
	 * worse than silence because it is an explanation that is wrong.
	 */
	it('writes the event only after the last key is gone', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const order: string[] = []
		const s = store({
			del: vi.fn(async (key: string) => order.push(`del ${key}`)),
			lPush: vi.fn(async () => order.push('lPush'))
		})

		await revoke(s)

		expect(order).toEqual([...MEMBERS.map((member) => `del ${member}`), `del ${FAMILY_KEY}`, 'lPush'])
	})

	/*
	 * ⚠️ **A revocation the trail cannot attribute still revokes.** `account` is `undefined` when the
	 * tombstone that named this lineage was written before E17-S05 put the account on it. Filing the event
	 * anyway would need an account id invented here, and an invented one names a key no console reads: the
	 * security action never degrades, only its explanation does.
	 */
	it('revokes without writing anything when the caller cannot say whose lineage it was', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await expect(revoke(s, { account: undefined })).resolves.toBeUndefined()

		expect(s.del.mock.calls).toEqual([[MEMBERS[0]], [MEMBERS[1]], [MEMBERS[2]], [FAMILY_KEY]])
		expect(s.lPush).not.toHaveBeenCalled()
		expect(s.lTrim).not.toHaveBeenCalled()
		expect(s.expire).not.toHaveBeenCalled()
	})

	// The account decides the key, so the same lineage revoked for two different accounts writes two trails —
	// which is what makes the console's per-account read possible without a scan.
	it('files the event under the account it was given, not under the family', async () => {
		vi.stubEnv('REDIS_KEY', REDIS_KEY)
		const s = store()

		await revoke(s, { account: { tier: TIER.admin, accountId: ACCOUNT_ID } })

		expect(s.lPush.mock.calls[0][0]).toBe(`${REDIS_KEY}reuse:admin:${ACCOUNT_ID}`)
		expect(s.lTrim.mock.calls[0][0]).toBe(`${REDIS_KEY}reuse:admin:${ACCOUNT_ID}`)
		expect(s.expire.mock.calls[0][0]).toBe(`${REDIS_KEY}reuse:admin:${ACCOUNT_ID}`)
	})
})
