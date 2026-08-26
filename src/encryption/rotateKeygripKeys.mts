import { randomBytes } from 'node:crypto'

import { IKeygripKeyMaterial } from '@others/IKeygripKeyMaterial.mjs'
import { SESSION_CAP_DAYS_REMEMBERED } from '@others/sessionLifetime.mjs'

/**
 * Bytes of key material a rotation mints. An SHA-512 HMAC key is 64 bytes: shorter weakens the MAC, and
 * anything past 128 is hashed down before use, so the extra length would be discarded. The seed script in
 * `marketplace-db-setup` mints the same length for the same reason.
 */
export const KEYGRIP_KEY_BYTES = 64

/**
 * How many keys the array may hold.
 *
 * ⚠️ **This is a refusal, not a trim.** Five entries is a monthly rotation plus an emergency one inside
 * the same thirty-day window, which is the cadence this platform can actually need. A sixth would have to
 * come from retiring a key early, and every key in the array younger than `SESSION_CAP_DAYS_REMEMBERED`
 * is still verifying somebody's remembered cookie — so the trim an operator did not ask for would log
 * those customers out. Refusing gives them the choice; trimming makes it for them, silently.
 */
export const KEYGRIP_MAX_KEYS = 5

/** Never fewer than this many keys survive a rotation. */
const KEYGRIP_MIN_KEYS = 2

/** Milliseconds in a day, for turning two ISO-8601 stamps into an age the retirement rule can read. */
const DAY_MS = 86_400_000

/** `k` followed by digits, and nothing else — the id shape both this and the seed script mint. */
const NUMBERED_ID = /^k(\d+)$/

/**
 * The id a rotation gives the key it mints: one past the highest number already in the array.
 *
 * ⚠️ **Not `k${keys.length + 1}`, and not the version number.** Retirement removes entries from the
 * array, so a length-derived id starts repeating the moment the first key ages out — and two keys sharing
 * an id make the fingerprint of two genuinely different key sets identical, which is the one thing the
 * fingerprint exists to prevent. The version number would collide with the seed script's `k2`, which it
 * mints at version 1 when it adopts the old environment pair.
 *
 * An id that does not match the shape contributes nothing rather than throwing: nothing on the platform
 * mints one, but a hand-written record must still be rotatable — the number is a label, and the only
 * property it owes anybody is being different from the others.
 */
const nextKeyId = (keys: readonly IKeygripKeyMaterial[]) => {
	const highest = keys.reduce((max, key) => Math.max(max, Number(NUMBERED_ID.exec(key.id)?.[1] ?? 0)), 0)

	return `k${highest + 1}`
}

/**
 * Whether a key is old enough that nothing it signed can still be presented.
 *
 * Strictly older, not "at least": a key minted exactly `SESSION_CAP_DAYS_REMEMBERED` days ago could have
 * signed a remembered cookie one millisecond before that instant, and that cookie is alive until the same
 * millisecond today. The boundary belongs on the side that keeps the key.
 */
const isRetirable = (key: IKeygripKeyMaterial, now: Date) =>
	now.getTime() - new Date(key.createdAt).getTime() > SESSION_CAP_DAYS_REMEMBERED * DAY_MS

/**
 * The next key array: a freshly minted key at index 0, the survivors behind it (ADR-034).
 *
 * ⚠️ **Rotation prepends; only retirement is age-gated.** A new signer is harmless at any cadence — what
 * logs a remembered customer out is dropping a key that is still verifying their cookie, and that is
 * governed by `createdAt` and nothing else. So a rotate never asks "is it time?", it asks "which of these
 * can no longer be verifying anything?", and the answer is allowed to be "none".
 *
 * Retirement runs from the oldest end and stops at two survivors. Two rather than one because
 * `Keygrip` signs with index 0 and verifies against the whole array: a single-entry array is a fleet with
 * no grace period at all, where the next rotation invalidates every cookie the moment it lands.
 *
 * ⚠️ **A full array of five keys, none of them retirable, is refused.** The alternative is retiring a key
 * younger than the longest session this platform issues, which is the one outcome an operator clicking
 * "rotate" cannot be assumed to want — they are usually rotating *because* something is wrong, and being
 * logged out mid-incident is not the help they asked for. `KEYGRIP_ROTATE_CAP` says how long the wait is.
 *
 * `now` is a parameter rather than a `new Date()` here, for the reason every age rule on this platform
 * takes one: the boundary is the whole behaviour, and a function that reads the clock itself can only be
 * tested by moving the clock.
 */
export function rotateKeygripKeys(keys: readonly IKeygripKeyMaterial[], now: Date): IKeygripKeyMaterial[] {
	const minted: IKeygripKeyMaterial = {
		id: nextKeyId(keys),
		material: randomBytes(KEYGRIP_KEY_BYTES).toString('base64'),
		createdAt: now.toISOString()
	}

	const next = [minted, ...keys]

	while (next.length > KEYGRIP_MIN_KEYS && isRetirable(next[next.length - 1], now)) next.pop()

	if (next.length > KEYGRIP_MAX_KEYS)
		throw new Error(
			`KEYGRIP_ROTATE_CAP: the key set already holds ${KEYGRIP_MAX_KEYS} keys and none is older than ${SESSION_CAP_DAYS_REMEMBERED} days. Rotating now would retire a key that is still verifying sessions; wait until the oldest one ages out.`
		)

	return next
}
