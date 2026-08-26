/**
 * Why a lineage was revoked (E17-S05). Two values, one per place `revokeSessionFamily` is called from,
 * and the pair is the whole vocabulary of the reuse trail.
 *
 * ⚠️ **This list is shared rather than spelled twice.** The Admin console renders these values as text and
 * the backend writes them into Redis; a GraphQL enum written by hand on one side and a string literal on
 * the other drift the moment a third case is added, and the drift shows up as an operator reading a blank
 * cell rather than as a failing build. `marketplace-admin` consumes this package, so its generated enum
 * can be asserted against this constant — which is what E17-S01 requires.
 *
 * ⚠️ **An operator's own revocation is deliberately not one of these.** Attributing a revoke to the Admin
 * who pressed the button is a second audit trail with its own retention question, and E17's open question 4
 * answered it "not attributable" for now. Adding a value here would answer it by accident.
 */
export const REUSE_EVENT_ACTIONS = [
	/** A consumed refresh token was presented again, past the grace window (E14-S02/S03). */
	'refreshTokenReplayed',
	/** The session reached its absolute age cap, measured from the login it descends from (E14-S05). */
	'sessionCapReached'
] as const

export type ReuseEventAction = (typeof REUSE_EVENT_ACTIONS)[number]
