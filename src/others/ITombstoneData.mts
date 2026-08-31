/**
 * What the reuse tombstone holds — the lineage the consumed token belonged to, whose it was, and when it
 * was consumed. Four fields, and the count is part of the contract.
 *
 * ⚠️ **No successor token, no prefix of one, nothing replayable, ever.** The design this replaced cached
 * the winner's new access/refresh pair here so the loser of a race could be handed it; that would put a
 * live credential into a Redis *value*, which is exactly what the hashed namespace took out of Redis keys.
 * A dump of this store must yield nothing usable as a Bearer token, and that is what the field list below
 * is for: every addition to it is a decision about what a dump reveals, which is why the count is written
 * down.
 *
 * ⚠️ **`_id` and `tier` are here because by the time a replay is detected there is nowhere else to read
 * them.** The session hash the token named was deleted by the rotation that wrote this marker,
 * and the family set holds key digests rather than an account — so without these two the reuse event that
 * explains the mass logout could not be filed under the account it happened to. Neither is a credential:
 * the tier is one of three constants and the account id is what every resource query already carries.
 *
 * ⚠️ **A tombstone written before those two fields existed is still honoured.** `resolveAuthorizationSession`
 * revokes the lineage on the strength of `familyId` alone and skips only the event — the security action
 * never depends on the trail.
 *
 * ⚠️ Every value is a string because everything a Redis hash holds is a string — `consumedAt` is epoch
 * millis written out, not a number.
 */
export interface ITombstoneData {
	/** The lineage to revoke when this token is presented again outside the grace window. */
	familyId: string
	/** When the rotation consumed the token, epoch millis as a string. The grace window is measured from it. */
	consumedAt: string
	/** The account the consumed session belonged to, so a replay can be filed under it. */
	_id: string
	/** Which collection that account lives in — half the trail's key, for the reason `sessionIndexKey` gives. */
	tier: string
}
