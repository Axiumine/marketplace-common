import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const companyFind = vi.fn()
const companyUpdateMany = vi.fn()
const itemUpdateMany = vi.fn()

// ⚠️ No `deleteOne` and no `findOneAndDelete` on either mock. The cascade withdraws documents rather than
// removing them, so a regression to a hard delete reaches for a method that is not here and fails against
// these mocks — not against a real database, and not after it has destroyed a shop.
vi.mock('@MongoDB/Company.mjs', () => ({ Company: { find: companyFind, updateMany: companyUpdateMany } }))
vi.mock('@MongoDB/Item.mjs', () => ({ Item: { updateMany: itemUpdateMany } }))

const { unpublishOwnerStorefront } = await import('../src/others/unpublishOwnerStorefront.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

/** Two shops under the owner, so the item hop has a real `$in` rather than a degenerate one. */
const shopIds = [new Types.ObjectId('507f1f77bcf86cd7994390a1'), new Types.ObjectId('507f1f77bcf86cd7994390a2')]

/**
 * What is asserted about the session double is which queries were handed it.
 *
 * ⚠️ **A query that does not join the session runs outside the transaction**, against its own snapshot,
 * and nothing in the result says so — the call succeeds and the atomicity ADR-045 asks for is gone.
 * `threaded` records every `.session()` argument in call order, so a dropped hop fails a test instead of
 * quietly leaving an inactive owner with a live storefront.
 */
const threaded: unknown[] = []

/** `.session()` is a hop on the chain: it records what it was given and answers the rest of the chain. */
const sessioned = (tail: object) => ({
	session: vi.fn((clientSession: unknown) => {
		threaded.push(clientSession)

		return tail
	})
})

/** The caller's transaction, as the cascade receives it — the double is not a `ClientSession`. */
const inSession = { withTransaction: vi.fn(), endSession: vi.fn() } as never

/** The cascade's three queries, armed with the companies the owner holds. */
function mockCascade(...ids: Types.ObjectId[]) {
	companyFind.mockReturnValueOnce(sessioned({ lean: vi.fn().mockResolvedValue(ids.map((idCompany) => ({ _id: idCompany }))) }))
	companyUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: ids.length }) }))
	itemUpdateMany.mockReturnValueOnce(sessioned({ exec: vi.fn().mockResolvedValue({ matchedCount: 0 }) }))
}

/** Every cascade query ran, once each, against the ids handed to `mockCascade`. */
function expectCascade(ids: Types.ObjectId[]) {
	expect(companyFind).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, '_id')
	expect(companyUpdateMany).toHaveBeenCalledExactlyOnceWith({ idShopOwner: _id }, { $set: { published: false } })
	expect(itemUpdateMany).toHaveBeenCalledExactlyOnceWith({ idCompany: trusted({ $in: ids }) }, { $set: { published: false } })
}

beforeEach(() => {
	companyFind.mockReset()
	companyUpdateMany.mockReset()
	itemUpdateMany.mockReset()
	threaded.length = 0
})

describe('unpublishOwnerStorefront', () => {
	it('withdraws every company the owner holds and every item filed under one', async () => {
		mockCascade(...shopIds)

		await expect(unpublishOwnerStorefront(_id, inSession)).resolves.toBeUndefined()

		expectCascade(shopIds)
	})

	/*
	 * ⚠️ **The `$in` carries mongoose's trusted marker, and the assertion compares it.** Every service that
	 * calls this sets `sanitizeFilter` globally: an untrusted `$in` is stripped on the way to the driver,
	 * which turns the item hop into a filter that matches nothing — every item stays published under a shop
	 * that has just gone dark, and nothing fails. `toEqual` compares symbol-keyed properties, so a dropped
	 * `trusted()` fails here.
	 */
	it('marks the item filter as trusted', async () => {
		mockCascade(...shopIds)

		await unpublishOwnerStorefront(_id, inSession)

		const [filter] = itemUpdateMany.mock.calls[0]

		expect(filter.idCompany).toEqual(trusted({ $in: shopIds }))
	})

	/*
	 * ⚠️ Every query joins the caller's transaction, this one included. The cascade is the half of the close
	 * that ADR-045 makes atomic with the stamp: a company read or an item write outside the transaction sees
	 * — and leaves behind — a state the stamp is still free to roll back.
	 */
	it('runs all three queries inside the transaction it was handed', async () => {
		mockCascade(...shopIds)

		await unpublishOwnerStorefront(_id, inSession)

		expect(threaded).toStrictEqual([inSession, inSession, inSession])
	})

	/*
	 * An owner with no companies is a real account — one that registered and never opened a shop. The company
	 * ids collapse to `$in: []`, which matches nothing and writes nothing, and both `updateMany` calls are
	 * still made: a `length > 0` short-circuit would be an extra branch buying nothing the driver does not
	 * already do.
	 */
	it('asks for an empty set when the owner holds no company', async () => {
		mockCascade()

		await expect(unpublishOwnerStorefront(_id, inSession)).resolves.toBeUndefined()

		expectCascade([])
	})
})
