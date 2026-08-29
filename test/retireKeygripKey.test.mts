import { describe, expect, it } from 'vitest'

import { KEYGRIP_RETIRE_CURRENT, KEYGRIP_RETIRE_UNKNOWN, retireKeygripKey } from '../src/encryption/retireKeygripKey.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'

/** A key whose material is a function of its id, so a test can name the survivors and mean it. */
const key = (id: string): IKeygripKeyMaterial => ({
	id,
	material: Buffer.alloc(64, id.length).toString('base64'),
	createdAt: '2026-08-01T00:00:00.000Z'
})

describe('retireKeygripKey', () => {
	it('removes the named key and leaves the others in order', () => {
		const before = [key('k4'), key('k3'), key('k2')]

		const after = retireKeygripKey(before, 'k3')

		// The ids exactly, not a length: a filter written `===` instead of `!==` answers a one-element array
		// that a length check would have to be read very carefully to catch.
		expect(after.map((entry) => entry.id)).toEqual(['k4', 'k2'])
		expect(after[0]).toBe(before[0])
	})

	// The oldest entry is the one an incident most often reaches for, and it is the index an off-by-one in
	// the removal would take instead of the one asked for.
	it('removes the last key as readily as a middle one', () => {
		expect(retireKeygripKey([key('k4'), key('k3'), key('k2')], 'k2').map((entry) => entry.id)).toEqual(['k4', 'k3'])
	})

	/*
	 * ⚠️ The point of the whole operation: an admin who is told "retired" must be able to believe it. A
	 * retire that answered the array unchanged would report success while every process still verifies with
	 * the key the admin has just declared compromised.
	 */
	it('refuses an id no key carries, rather than answering the array unchanged', () => {
		expect(() => retireKeygripKey([key('k4'), key('k3')], 'k9')).toThrow(
			new Error(
				'KEYGRIP_RETIRE_UNKNOWN: no key in the current set is called k9. Nothing was retired — read the key set again before assuming this key is gone.'
			)
		)
	})

	// An empty set reaches the same refusal rather than a TypeError: the current-key guard has to read index
	// 0 of an array that may not have one.
	it('refuses against an empty key set instead of throwing on the read', () => {
		expect(() => retireKeygripKey([], 'k1')).toThrow(/^KEYGRIP_RETIRE_UNKNOWN: /)
	})

	/*
	 * ⚠️ `Keygrip` signs with index 0. Removing it without minting a replacement would leave the platform
	 * signing with nothing, or — worse — leave the admin believing the suspect key is out of use while a
	 * later rotation is what actually replaces it.
	 */
	it('refuses to retire the key the platform is signing with, and names rotation as the operation', () => {
		expect(() => retireKeygripKey([key('k4'), key('k3')], 'k4')).toThrow(
			new Error(
				'KEYGRIP_RETIRE_CURRENT: k4 is the key the platform is signing with and cannot be retired on its own. Rotate instead: that mints a fresh signer and moves this key down the array, and it can be retired from there.'
			)
		)
	})

	// The current-key guard reads index 0 and not "is it in there": the same id anywhere else in the array
	// is retirable, and a guard written as a membership test would refuse every retire there is.
	it('retires the second key even though a current key exists', () => {
		expect(retireKeygripKey([key('k4'), key('k3')], 'k3').map((entry) => entry.id)).toEqual(['k4'])
	})

	/*
	 * No lower bound, deliberately. `rotateKeygripKeys` stops at two survivors because routine maintenance
	 * must not spend the grace period; an incident response is the admin spending it on purpose, and the
	 * single survivor is the signer, so the keyring still signs and still verifies.
	 */
	it('leaves a single key rather than refusing to shorten the set', () => {
		const after = retireKeygripKey([key('k2'), key('k1')], 'k1')

		expect(after).toHaveLength(1)
		expect(after[0].id).toBe('k2')
	})

	/*
	 * The two codes are the wire contract: the admin service reports an unknown id as a 404 and the current
	 * key as a 409, and it branches on these rather than on a prefix it spelled out itself. Pinned as
	 * literals here, because a test that only compared each constant to itself would pass on a blanked one.
	 */
	it('carries the two codes a consumer branches on', () => {
		expect(KEYGRIP_RETIRE_CURRENT).toBe('KEYGRIP_RETIRE_CURRENT')
		expect(KEYGRIP_RETIRE_UNKNOWN).toBe('KEYGRIP_RETIRE_UNKNOWN')
	})

	it('does not touch the array it was given', () => {
		const before = [key('k4'), key('k3')]

		retireKeygripKey(before, 'k3')

		expect(before.map((entry) => entry.id)).toEqual(['k4', 'k3'])
	})
})
