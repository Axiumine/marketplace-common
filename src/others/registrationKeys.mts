import { ScrubbableTier } from '@others/accountScrub.mjs'
import { Binary } from 'mongodb'

/**
 * Where a tier's pending registration for an address lives — the shared prefix, the word `pending:`,
 * the tier, and the hex of the address's own ciphertext.
 *
 * ⚠️ **The key is the deterministic ciphertext of the address, not a digest of it** (ADR-043). A
 * `sha256` would key the record just as well and would quietly cost the reuse: the ciphertext is
 * *already* the value MongoDB indexes, so the same call that finds the record produces the bytes the
 * confirm step inserts, and nothing on this path ever holds a second representation of the address.
 *
 * ⚠️ **The hex encoding happens inside this builder and nowhere else.** It is part of the key shape,
 * not an incidental formatting step at the call site — the whole point of moving this builder into
 * `marketplace-common` is that every byte of the shape, encoding included, lives in exactly one place.
 * A caller that hex-encoded the ciphertext itself, even to arrive at the identical string, would be
 * rebuilding the key shape a second time in a second repo, which is the drift this move exists to end.
 *
 * The tier is in the key because `user` and `shopOwner` are unrelated collections (ADR-002) and one
 * person may legitimately be both, with the same address, at the same time — so the tier segment is
 * what keeps the two pending registrations from colliding on one key. The three-day claim window this
 * key is written under (ADR-042) is not part of the key itself: **abandonment is not a state anybody
 * has to notice**, because the window is the record's own TTL rather than a check run lazily on a visit
 * to the activation link.
 */
export const pendingRegistrationKey = (tier: ScrubbableTier, email: Binary): string =>
	`${process.env.REDIS_KEY}pending:${tier}:${Buffer.from(email.buffer).toString('hex')}`
