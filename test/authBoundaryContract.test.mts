import { describe, expect, it } from 'vitest'

import { AUTH_BOUNDARY_CASES, AUTH_BOUNDARY_SERVICES, requiredAuthBoundaryCases } from '../src/others/authBoundaryContract.mts'

const ALL_CASES = ['AB-01', 'AB-02', 'AB-03', 'AB-04', 'AB-05', 'AB-06', 'AB-07', 'AB-08', 'AB-09', 'AB-10', 'AB-11']

const RESOURCE_CASES = ['AB-01', 'AB-02', 'AB-03', 'AB-04', 'AB-05', 'AB-06', 'AB-08', 'AB-09', 'AB-10', 'AB-11']

const LOGOUT_CASES = ['AB-01', 'AB-04', 'AB-05', 'AB-06', 'AB-08', 'AB-09', 'AB-10', 'AB-11']

describe('AUTH_BOUNDARY_CASES', () => {
	it('is the eleven ids, in order, each with something written on it', () => {
		expect(AUTH_BOUNDARY_CASES.map(({ id }) => id)).toEqual(ALL_CASES)
		expect(AUTH_BOUNDARY_CASES).toHaveLength(ALL_CASES.length)

		for (const boundaryCase of AUTH_BOUNDARY_CASES) {
			expect(Object.keys(boundaryCase)).toEqual(['id', 'what'])
			// A case whose `what` went empty still enumerates but no longer says what a suite has to prove,
			// which is the whole content of the contract — the ids alone are filing codes.
			expect(boundaryCase.what).not.toBe('')
		}
	})
})

describe('AUTH_BOUNDARY_SERVICES', () => {
	it('names the seven authenticated services and nothing else', () => {
		expect(Object.keys(AUTH_BOUNDARY_SERVICES)).toEqual([
			'marketplace-dev-admin-authenticated-resource',
			'marketplace-dev-authenticated-resource',
			'marketplace-dev-user-authenticated-resource',
			'marketplace-dev-admin-authenticated-authorization',
			'marketplace-dev-authenticated-authorization',
			'marketplace-dev-user-authenticated-authorization',
			'marketplace-dev-authenticated-logout'
		])
	})

	it('excuses nothing without naming a real case and giving a reason for it', () => {
		for (const exemptions of Object.values(AUTH_BOUNDARY_SERVICES)) {
			for (const [id, reason] of Object.entries(exemptions)) {
				expect(ALL_CASES).toContain(id)
				// An exemption is the only way to owe less than the eleven, so a blank reason is an
				// untested boundary with nothing behind it. See the module's own warning.
				expect(reason).not.toBe('')
			}
		}
	})
})

describe('requiredAuthBoundaryCases', () => {
	it.each([
		['marketplace-dev-admin-authenticated-resource'],
		['marketplace-dev-authenticated-resource'],
		['marketplace-dev-user-authenticated-resource']
	])('excuses %s from the replay case only — it mints no token', (service) => {
		expect(requiredAuthBoundaryCases(service)).toEqual(RESOURCE_CASES)
	})

	it.each([
		['marketplace-dev-admin-authenticated-authorization'],
		['marketplace-dev-authenticated-authorization'],
		['marketplace-dev-user-authenticated-authorization']
	])('holds %s to all eleven — it is the service that rotates', (service) => {
		expect(requiredAuthBoundaryCases(service)).toEqual(ALL_CASES)
	})

	it('excuses the logout service from the two tier cases and the replay case', () => {
		expect(requiredAuthBoundaryCases('marketplace-dev-authenticated-logout')).toEqual(LOGOUT_CASES)
	})

	it('refuses to answer for a service the contract has never heard of', () => {
		expect(() => requiredAuthBoundaryCases('marketplace-dev-order-authenticated-resource')).toThrow(
			new Error(
				'marketplace-dev-order-authenticated-resource is not in AUTH_BOUNDARY_SERVICES — add it to the auth-boundary contract before writing its suite'
			)
		)
	})

	it('does not answer an empty list for a name that only looks like a service', () => {
		// ⚠️ Objects inherit `toString`, `constructor` and the rest of `Object.prototype`; a lookup that
		// checked truthiness instead of `typeof … === 'undefined'` would answer *something* for those and
		// hand a caller a required-case list it never wrote down.
		expect(() => requiredAuthBoundaryCases('constructor')).toThrow(Error)
		expect(() => requiredAuthBoundaryCases('')).toThrow(Error)
	})
})
