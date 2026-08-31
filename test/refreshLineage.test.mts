import { describe, expect, it } from 'vitest'

import { assertRefreshLineage } from '../src/others/assertRefreshLineage.mts'
import { REFRESH_RACE_RETRY_CODE, throwRefreshRaceRetry } from '../src/others/throwRefreshRaceRetry.mts'
import { expectStatus, rejection } from './graphQLErrors.mts'

const LINEAGE = { familyId: '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d', originalLogin: '1754784000000', sessionCapDays: '1' }

describe('assertRefreshLineage', () => {
	// The ordinary case: a session minted since the lineage landed carries all three and passes silently.
	it('accepts a session that carries its whole lineage', () => {
		expect(() => assertRefreshLineage(LINEAGE)).not.toThrow()
	})

	/*
	 * ⚠️ One case per field, and each one is a rejection rather than a default. A session minted before
	 * these fields existed carries none of them; defaulting `familyId` would file every such session into
	 * one shared family, where a single reuse event revokes unrelated accounts across every tier. The cost
	 * of refusing is one forced re-login for sessions older than the deploy.
	 *
	 * The three cases are also what kills the `&&`-for-`||` mutant: each leaves the other two fields valid.
	 */
	it.each([['familyId'], ['originalLogin'], ['sessionCapDays']])('refuses a session with no %s', async (field) => {
		const lineage: Record<string, string> = { ...LINEAGE }
		delete lineage[field]

		expectStatus(await rejection(() => assertRefreshLineage(lineage)), 498, 'Invalid Token')
	})

	/*
	 * ⚠️ **The malformed-number cases are the fail-open this guard exists to close.** `Number('later')` is
	 * `NaN`, and every comparison against `NaN` is false — so a session whose `originalLogin` is not a
	 * number would answer "not older than the cap" for ever, which is precisely the unbounded session
	 * the absolute cap refuses to allow. An empty string is worse still: `Number('')` is `0`, an epoch in
	 * 1970.
	 *
	 * `'12abc'` and `'1.5'` are the anchors and the character class asserted: without `$` the first would
	 * pass, and without `\d` the second would.
	 */
	it.each([[''], [' '], ['abc'], ['12abc'], ['1.5'], ['-1'], ['1e3']])(
		'refuses %o as a stored number, in either numeric field',
		(value) => {
			expect(() => assertRefreshLineage({ ...LINEAGE, originalLogin: value })).toThrow()
			expect(() => assertRefreshLineage({ ...LINEAGE, sessionCapDays: value })).toThrow()
		}
	)

	// `familyId` is an opaque identifier and is only ever checked for presence — it is a uuid today and the
	// guard must not become the place that decides it always will be.
	it('accepts any non-empty familyId, and refuses an empty one', () => {
		expect(() => assertRefreshLineage({ ...LINEAGE, familyId: 'not-a-uuid' })).not.toThrow()
		expect(() => assertRefreshLineage({ ...LINEAGE, familyId: '' })).toThrow()
	})
})

describe('throwRefreshRaceRetry', () => {
	/*
	 * ⚠️ 409 and a code of its own, because this and a 498 mean opposite things to a client: 498 is "log in
	 * again", this is "retry, your cookie jar already holds the winner's token". The three SPAs branch on
	 * the code, so it is asserted as the literal string rather than through the constant alone — the
	 * constant and the value are what a rename would silently pull apart.
	 */
	it('answers a retryable 409 carrying the code the three SPAs match on', async () => {
		const error = await rejection(() => throwRefreshRaceRetry())

		expectStatus(error, 409, 'Refresh In Progress')
		expect(error.extensions.code).toBe('REFRESH_RACE_RETRY')
		expect(REFRESH_RACE_RETRY_CODE).toBe('REFRESH_RACE_RETRY')
		// The description is the only place the *remedy* is written down — the client already holds the
		// winner's cookie and has to send it again — so it is pinned rather than left to drift into silence.
		expect(error.extensions.description).toBe(
			'This refresh token was just rotated by another request. Retry with the current cookie.'
		)
	})

	// Nothing replayable travels in it. The design this replaced handed the loser the winner's new pair,
	// which would have put a live credential into an error payload as well as into a Redis value.
	it('carries no token in any of its extensions', async () => {
		const error = await rejection(() => throwRefreshRaceRetry())

		expect(JSON.stringify(error.extensions)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
	})
})
