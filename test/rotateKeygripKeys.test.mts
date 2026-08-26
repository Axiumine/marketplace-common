import { describe, expect, it } from 'vitest'

import { KEYGRIP_KEY_BYTES, KEYGRIP_MAX_KEYS, rotateKeygripKeys } from '../src/encryption/rotateKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'
import { SESSION_CAP_DAYS_REMEMBERED } from '../src/others/sessionLifetime.mts'

const NOW = new Date('2026-08-12T09:00:00.000Z')
const DAY_MS = 86_400_000

/** A key whose age is stated in days, so every test reads as the rule it is checking. */
const aged = (id: string, days: number): IKeygripKeyMaterial => ({
	id,
	material: Buffer.alloc(64, id.length).toString('base64'),
	createdAt: new Date(NOW.getTime() - days * DAY_MS).toISOString()
})

describe('rotateKeygripKeys', () => {
	it('mints 64 bytes of fresh material at index 0 and keeps the rest in order', () => {
		const before = [aged('k2', 1), aged('k1', 4)]

		const after = rotateKeygripKeys(before, NOW)

		expect(after).toHaveLength(3)
		expect(Buffer.from(after[0].material, 'base64')).toHaveLength(KEYGRIP_KEY_BYTES)
		expect(after[0].createdAt).toBe(NOW.toISOString())
		// The survivors are the same objects in the same order: `Keygrip` signs with index 0 and verifies
		// against the whole array, so a rotation that reordered anything would change which key signs
		// twice over.
		expect(after.slice(1)).toEqual(before)
	})

	/*
	 * ⚠️ Every rotation must mint a key no other entry shares an id with: the fingerprint is computed over
	 * the ids, so two entries carrying one id make two genuinely different key sets fingerprint the same,
	 * and the holders table would report agreement that does not exist.
	 */
	it('numbers the new key past the highest already there, not by position', () => {
		// Four entries, ids up to k9 — a length-derived id would answer k5 and collide the moment k9's
		// generation ages out.
		const before = [aged('k9', 1), aged('k8', 2), aged('k7', 3), aged('k6', 4)]

		expect(rotateKeygripKeys(before, NOW)[0].id).toBe('k10')
	})

	// Past the tenth rotation the number is two digits, and it still has to be read as a number rather
	// than as one character followed by whatever.
	it('reads a multi-digit number, so the eleventh rotation is k13 and not k3', () => {
		expect(rotateKeygripKeys([aged('k12', 1), aged('k2', 40)], NOW)[0].id).toBe('k13')
	})

	/*
	 * ⚠️ The id has to match end to end. Half-reading `k9-old` as nine would let a hand-written label push
	 * the counter somewhere no minted key ever put it — and the ids are what the fingerprint is computed
	 * over, so a counter driven by a label is a fingerprint driven by a label.
	 */
	it('takes no number from an id that only starts like one', () => {
		expect(rotateKeygripKeys([aged('k2', 1), aged('k9-old', 40)], NOW)[0].id).toBe('k3')
	})

	it('mints material nobody can predict — two rotations of the same array differ', () => {
		const before = [aged('k2', 1), aged('k1', 4)]

		expect(rotateKeygripKeys(before, NOW)[0].material).not.toBe(rotateKeygripKeys(before, NOW)[0].material)
	})

	// A hand-written record must stay rotatable: the number in an id is a label, and the only property it
	// owes anybody is being different from the others.
	it('starts numbering at k1 when no existing id carries a number', () => {
		const before = [aged('itest-k1', 1), aged('adopted', 2)]

		expect(rotateKeygripKeys(before, NOW)[0].id).toBe('k1')
	})

	/*
	 * ⚠️ The thirty-day promise, as a rule rather than a paragraph. A key younger than the longest session
	 * this platform issues may still be verifying a remembered customer's cookie, and dropping it logs
	 * exactly those customers out — the ones who asked not to be.
	 */
	it('retires nothing when no key is older than the remembered-session cap', () => {
		const before = [aged('k3', 1), aged('k2', 20), aged('k1', SESSION_CAP_DAYS_REMEMBERED)]

		const after = rotateKeygripKeys(before, NOW)

		expect(after).toHaveLength(4)
		expect(after.map((key) => key.id)).toEqual(['k4', 'k3', 'k2', 'k1'])
	})

	// The boundary belongs on the side that keeps the key: one minted exactly at the cap could have signed
	// a cookie a millisecond earlier, and that cookie is alive until the same millisecond today.
	it('retires a key one millisecond past the cap, and not one at it', () => {
		const atTheCap = [aged('k3', 1), aged('k2', 2), aged('k1', SESSION_CAP_DAYS_REMEMBERED)]
		const pastIt: IKeygripKeyMaterial[] = [
			atTheCap[0],
			atTheCap[1],
			{ ...atTheCap[2], createdAt: new Date(NOW.getTime() - SESSION_CAP_DAYS_REMEMBERED * DAY_MS - 1).toISOString() }
		]

		expect(rotateKeygripKeys(atTheCap, NOW).map((key) => key.id)).toEqual(['k4', 'k3', 'k2', 'k1'])
		expect(rotateKeygripKeys(pastIt, NOW).map((key) => key.id)).toEqual(['k4', 'k3', 'k2'])
	})

	it('retires every key past the cap, oldest first', () => {
		const before = [aged('k3', 1), aged('k2', SESSION_CAP_DAYS_REMEMBERED + 1), aged('k1', SESSION_CAP_DAYS_REMEMBERED + 90)]

		expect(rotateKeygripKeys(before, NOW).map((key) => key.id)).toEqual(['k4', 'k3'])
	})

	/*
	 * ⚠️ Two survivors, never one. `Keygrip` signs with index 0 and verifies against the array, so a
	 * single-entry array is a fleet with no grace period at all: the next rotation would invalidate every
	 * cookie on the platform the instant it landed.
	 */
	it('never leaves fewer than two keys, however old the rest are', () => {
		const before = [aged('k2', 400), aged('k1', 800)]

		const after = rotateKeygripKeys(before, NOW)

		expect(after.map((key) => key.id)).toEqual(['k3', 'k2'])
	})

	/*
	 * ⚠️ Refused, not trimmed. Reaching the cap with nothing retirable means every key in the array is
	 * still verifying somebody's cookie; the only way to fit a sixth is to log those customers out, and an
	 * operator clicking "rotate" during an incident has not asked for that. The message says how long the
	 * wait is.
	 */
	it('refuses a rotation that would exceed the cap while every key is still in its window', () => {
		const before = [aged('k5', 1), aged('k4', 2), aged('k3', 3), aged('k2', 4), aged('k1', SESSION_CAP_DAYS_REMEMBERED)]

		expect(before).toHaveLength(KEYGRIP_MAX_KEYS)
		expect(() => rotateKeygripKeys(before, NOW)).toThrow(
			`KEYGRIP_ROTATE_CAP: the key set already holds ${KEYGRIP_MAX_KEYS} keys and none is older than ${SESSION_CAP_DAYS_REMEMBERED} days.`
		)
	})

	// The same five, with the oldest one past the cap: the retirement makes room, so the cap is a refusal
	// only when it has nothing to drop.
	it('accepts a full array when the oldest key has aged out', () => {
		const before = [aged('k5', 1), aged('k4', 2), aged('k3', 3), aged('k2', 4), aged('k1', SESSION_CAP_DAYS_REMEMBERED + 1)]

		expect(rotateKeygripKeys(before, NOW).map((key) => key.id)).toEqual(['k6', 'k5', 'k4', 'k3', 'k2'])
	})
})
