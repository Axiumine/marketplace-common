/**
 * What every authenticated service's auth-boundary suite has to prove, in one place.
 *
 * ⚠️ **This is data for tests and nothing imports it at runtime — deliberately.** It lives here because
 * it is the only place all seven authenticated services can read the same list from: each of them is its
 * own repo with its own gates, so a contract written down in seven copies is a contract that drifts, and
 * the drift is exactly the defect this exists to prevent. Three resource services were once found testing
 * their boundary three different ways, and the reason was that nothing said what the suite must contain.
 *
 * How a service satisfies it: its boundary suite carries the case id in a comment directly above the test
 * that proves the case — `// AB-04: a request carrying no credential is refused` — and a
 * `authBoundaryContract.test.mts` in that repo reads its own suite files and fails when a required id is
 * missing. **One test may carry two ids**: the contract asks for the case to be proven, not for a
 * one-to-one mapping onto `it()` blocks.
 *
 * ⚠️ **A service missing from `AUTH_BOUNDARY_SERVICES` cannot ask what it owes** —
 * `requiredAuthBoundaryCases` throws on an unknown name rather than answering an empty list. Adding an
 * eighth authenticated service is then a deliberate edit here, reviewed against `docs/testing.md`, not a
 * silent omission that leaves a boundary untested for as long as nobody looks.
 */

export interface IAuthBoundaryCase {
	/** Stable id. It is the marker a suite carries; renaming one invalidates every repo at once, on purpose. */
	id: string
	/** What the case asserts, in a line. The wording a suite's comment should echo. */
	what: string
}

/**
 * The seven cases. Ordered from the ordinary path outward: accept, then the refusals a credential can
 * earn, ending with the one only a token-minting service can fail.
 */
export const AUTH_BOUNDARY_CASES: readonly IAuthBoundaryCase[] = [
	{ id: 'AB-01', what: 'a valid credential is accepted and the session it resolves reaches ctx.state.user' },
	{ id: 'AB-02', what: 'a session minted for another tier is refused with 403, not 401' },
	{ id: 'AB-03', what: 'a session carrying no tier at all is refused — fail closed, never a wildcard' },
	{ id: 'AB-04', what: 'a request carrying no credential is refused' },
	{ id: 'AB-05', what: 'a credential of the wrong shape is refused — a bad scheme, a broken signature' },
	{ id: 'AB-06', what: 'a credential whose session is gone from Redis is refused' },
	{ id: 'AB-07', what: 'a refresh token presented a second time is refused, and its family revoked with it' }
]

/**
 * Which of the seven each service owes, expressed as what it is **excused** from and why.
 *
 * ⚠️ **An exemption carries a reason, and the reason is the point.** "This service does not do that" has
 * to survive being read a year later by somebody deciding whether a missing test is a decision or a gap —
 * which is a question that once had to be answered by archaeology. `requiredAuthBoundaryCases` subtracts these
 * from the full list, so an exemption is the only way to owe less, and adding one is a visible edit.
 */
export const AUTH_BOUNDARY_SERVICES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	'marketplace-dev-admin-authenticated-resource': {
		'AB-07': 'a resource service reads an access session and mints nothing, so it has no token to replay'
	},
	'marketplace-dev-authenticated-resource': {
		'AB-07': 'a resource service reads an access session and mints nothing, so it has no token to replay'
	},
	'marketplace-dev-user-authenticated-resource': {
		'AB-07': 'a resource service reads an access session and mints nothing, so it has no token to replay'
	},
	'marketplace-dev-admin-authenticated-authorization': {},
	'marketplace-dev-authenticated-authorization': {},
	'marketplace-dev-user-authenticated-authorization': {},
	'marketplace-dev-authenticated-logout': {
		'AB-02':
			'the one service serving all three tiers (ADR-005): it finds a session by token content alone and asserts no tier, so there is no wrong one to refuse',
		'AB-03': 'same reason as AB-02 — a service that asserts no tier cannot fail closed on a missing one',
		'AB-07': 'logout deletes the tokens it is given and mints none, so it has no rotation to replay'
	}
}

/**
 * The case ids a named service must prove. Throws on a service this contract has never heard of, which is
 * what makes the map above an enumeration rather than a lookup table with a default.
 */
export function requiredAuthBoundaryCases(service: string): readonly string[] {
	// ⚠️ `Object.hasOwn`, not truthiness and not `typeof … === 'undefined'`: the map is a plain object
	// literal, so `AUTH_BOUNDARY_SERVICES['constructor']` answers a *function* rather than nothing, and an
	// inherited key read as a known service would hand back a required-case list nobody ever wrote down.
	if (!Object.hasOwn(AUTH_BOUNDARY_SERVICES, service)) {
		throw new Error(
			`${service} is not in AUTH_BOUNDARY_SERVICES — add it to the auth-boundary contract before writing its suite`
		)
	}

	const exemptions = AUTH_BOUNDARY_SERVICES[service]

	return AUTH_BOUNDARY_CASES.filter(({ id }) => !Object.hasOwn(exemptions, id)).map(({ id }) => id)
}
