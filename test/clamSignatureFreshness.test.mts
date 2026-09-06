import { describe, expect, it } from 'vitest'

import { clamSignatureFreshness, parseClamSignatureDate } from '../src/others/clamSignatureFreshness.mjs'

/*
 * RISK_REGISTER R22. A scanner with a six-month-old signature database answers `clean` as fast as a
 * current one, and until this module existed nothing on the platform read the daemon's version reply at
 * all. The reply below is the real shape `clamd` returns to `nVERSION` — engine, database version, build
 * date, `/`-separated — and every case here is a way that reply can arrive.
 */

const BUILT_AT = Date.UTC(2026, 8, 4, 8, 31, 7)
const REPLY = 'ClamAV 0.103.11/27412/Fri Sep 04 2026 08:31:07 GMT+0000'

const DAY = 86_400_000

describe('the build date is read out of the version reply', () => {
	it('takes the third field and nothing else', () => {
		expect(parseClamSignatureDate(REPLY)?.getTime()).toBe(BUILT_AT)
	})

	it('reads a reply that arrives with the newline and NUL a socket adds', () => {
		expect(parseClamSignatureDate(`${REPLY}\n\0`)?.getTime()).toBe(BUILT_AT)
	})

	// Each of these is a reply this cannot read, and reading it wrong would be worse than saying so: a
	// confident date parsed out of the engine version would report a scanner as fresh forever.
	it.each([
		['an empty reply', ''],
		['a reply with no fields at all', 'ClamAV 0.103.11'],
		['a reply missing the date field', 'ClamAV 0.103.11/27412'],
		['a reply whose date field is empty', 'ClamAV 0.103.11/27412/'],
		['a reply whose date field is not a date', 'ClamAV 0.103.11/27412/unknown'],
		['an error the daemon answers instead', 'ERROR: unknown command']
	])('answers undefined for %s', (_label, reply) => {
		expect(parseClamSignatureDate(reply)).toBeUndefined()
	})
})

describe('a version reply becomes a verdict a boot can act on', () => {
	it('is fresh while the database is younger than the threshold', () => {
		expect(clamSignatureFreshness(REPLY, BUILT_AT + DAY, 7 * DAY)).toStrictEqual({
			state: 'fresh',
			ageMs: DAY,
			builtAt: new Date(BUILT_AT)
		})
	})

	// The boundary is `>`, so a database rebuilt exactly on the threshold is still fresh. A daily
	// rebuild against a one-day threshold would otherwise alternate between verdicts on rounding.
	it('is fresh at exactly the threshold, and stale one millisecond past it', () => {
		expect(clamSignatureFreshness(REPLY, BUILT_AT + 7 * DAY, 7 * DAY).state).toBe('fresh')
		expect(clamSignatureFreshness(REPLY, BUILT_AT + 7 * DAY + 1, 7 * DAY).state).toBe('stale')
	})

	it('reports the age it measured, which is what the alert has to say', () => {
		expect(clamSignatureFreshness(REPLY, BUILT_AT + 30 * DAY, 7 * DAY)).toStrictEqual({
			state: 'stale',
			ageMs: 30 * DAY,
			builtAt: new Date(BUILT_AT)
		})
	})

	// Clock skew between a container and the host that built the signatures is ordinary, and a negative
	// age cannot mean stale. Alerting on it would teach the reader to ignore this alert.
	it('calls a database built in the future fresh rather than wrong', () => {
		expect(clamSignatureFreshness(REPLY, BUILT_AT - DAY, 7 * DAY)).toStrictEqual({
			state: 'fresh',
			ageMs: -DAY,
			builtAt: new Date(BUILT_AT)
		})
	})

	it('hands back the reply it could not read, so the alert can quote it', () => {
		expect(clamSignatureFreshness('ERROR: unknown command', BUILT_AT, 7 * DAY)).toStrictEqual({
			state: 'unreadable',
			reply: 'ERROR: unknown command'
		})
	})
})
