import { hashSessionToken } from '@others/hashSessionToken.mjs'
import { IRefreshData } from '@others/IRefreshData.mjs'
import { MILLISECONDS_PER_DAY, SESSION_CAP_DAYS_REMEMBERED, sessionCapRemainingSeconds } from '@others/sessionLifetime.mjs'
import { Tier } from '@others/Tier.mjs'

/**
 * The three Redis commands the session keyspace is touched with, and nothing else. Parameters rather
 * than an import, for the reason spelled out on `ISessionReadStore`.
 *
 * ⚠️ **`incr` left this interface with the dual-read fallback (E13-S10).** It was here for one counter,
 * `dual-read-hits`, and the session keyspace now has nothing to count: a read either finds the digest or
 * finds nothing. The remaining counter on the auth path, `grace-hits`, belongs to the tombstone rather
 * than to a session key and is declared on `ISessionReadStore`, which is where it is issued.
 */
export interface ISessionKeyStore {
	hGetAll(key: string): Promise<Record<string, string>>
	hGet(key: string, field: string): Promise<string | null>
	del(key: string): Promise<unknown>
}

/**
 * The three commands the session index is written with. Same argument as `ISessionKeyStore`: a parameter
 * rather than an import, so the helper is testable without a Redis and usable from a service that holds
 * its own client.
 *
 * ⚠️ **`hExpire` is why this platform's Redis floor is 7.4.0** — hash-field TTLs exist in no earlier
 * release, and Redis refuses an unknown command at the first call rather than at startup. The floor is
 * written down in `marketplace-docker-DBs/README.md` §Redis, pinned by `marketplace-docker-DBs/env`, and asserted at boot by
 * `assertHashFieldTTLSupport` so a server that cannot do this says so before it serves a request.
 */
export interface ISessionIndexStore {
	hSet(key: string, value: Record<string, string>): Promise<unknown>
	expire(key: string, seconds: number): Promise<unknown>
	hExpire(key: string, fields: string, seconds: number): Promise<unknown>
}

/**
 * The one command the session index is pruned with — logout and rotation both remove exactly one field
 * from exactly one key.
 *
 * Separate from `ISessionIndexStore` because the two roles are separate: a service that only ends
 * sessions never writes the index, and asking it for `hSet` would be asking for a capability it has no
 * business holding.
 */
export interface ISessionIndexPruneStore {
	hDel(key: string, field: string): Promise<unknown>
}

/**
 * The key a session is **written** under: the shared prefix plus the digest of the prefixed token.
 *
 * The `REDIS_KEY` prefix stays exactly as it is and is shared by all nine services (CON-04, settled) —
 * the single logout service finds a session by token content alone (ADR-005, CON-05, settled), and a
 * per-service prefix would leave it unable to revoke anything it did not mint.
 */
export const sessionKey = (token: string) => `${process.env.REDIS_KEY}${hashSessionToken(token)}`

/**
 * The key that marks a refresh token as **consumed** — the shared prefix, the word `used:`, and the digest
 * of the prefixed token (E14-S02).
 *
 * The hash stored under it holds the lineage the token belonged to, so a replay can be answered without
 * the token's own key, which rotation has by then deleted. It is written *before* that delete, never after:
 * a consumed token that lost its marker to a process death replays as ordinary expiry.
 *
 * ⚠️ **A digest, exactly like a session key, and for the same reason.** The word in front of it is a
 * namespace, not a weakening: `used:` is a constant, so what varies in the key is still only the digest and
 * a dump still names no credential.
 */
export const tombstoneKey = (token: string) => `${process.env.REDIS_KEY}used:${hashSessionToken(token)}`

/**
 * The key of the set naming every session key minted from one login (E14-S03) — the shared prefix, the word
 * `family:`, and the lineage's own id.
 *
 * ⚠️ **`familyId` is not hashed because it is not a credential, and it must stay that way.** It is a
 * `randomUUID()` minted at login and carried forward through every rotation; presenting one grants nothing,
 * which is what lets a tombstone name it in the clear. Deriving it from a token — hashing one, truncating
 * one, reusing one — would put the token back into a key name that is not a digest, undoing E13-S01 through
 * the side door.
 */
export const familyKey = (familyId: string) => `${process.env.REDIS_KEY}family:${familyId}`

/**
 * The key of the hash naming every live session of one account (E15-S02) — the shared prefix, the word
 * `idx:`, the tier and the account's `_id`.
 *
 * ⚠️ **The tier is part of the name, not decoration.** Ids come from three separate collections and
 * nothing stops two of them minting the same `ObjectId` string; without the tier segment an `admin` and a
 * `user` who collided would share one index, and E15-S04's revocation would log out a stranger.
 *
 * ⚠️ **This exists so that listing an account's sessions never needs `SCAN`** (BCON-08). A keyspace scan
 * is O(keyspace) on one node and simply wrong on a cluster, where the keys of one account are spread over
 * every slot. One hash per account is one key, one round trip, and one slot.
 *
 * ⚠️ **Neither segment is hashed, and neither is a credential.** The tier is a constant and the account id
 * is what every resource query already carries; presenting either grants nothing. What must never appear
 * here is a token — see the field names on the hash itself, which are digests for exactly that reason.
 */
export const sessionIndexKey = (tier: Tier, accountId: string) => `${process.env.REDIS_KEY}idx:${tier}:${accountId}`

/**
 * The session key one index field names (E15-S04) — the shared prefix and the field, verbatim.
 *
 * ⚠️ **The only key builder here that takes no token, and that is the point.** An index field *is* the
 * body of the session key that filed it, which is what lets a revocation delete a session it has no
 * credential for. Rehashing the field would digest a digest and name a key that has never existed, and
 * the failure would be a revocation that answers success having deleted nothing.
 *
 * ⚠️ **Every session key on the platform has this one shape** (E13-S10). The raw-token shape this note
 * used to except is gone with the fallback that read it, so rebuilding a key from an index field is the
 * whole of the mapping rather than the digest half of it.
 */
export const sessionKeyFromIndexField = (field: string) => `${process.env.REDIS_KEY}${field}`

/**
 * The key of the list holding one account's reuse events (E17-S05) — the shared prefix, the word `reuse:`,
 * the tier and the account's `_id`.
 *
 * ⚠️ **Per account, exactly like the session index, and for the same reason.** A platform-wide trail would
 * be a second structure to bound and would put the console back on a keyspace scan to answer "whose events
 * are these" (BCON-08). E17's open question 3 was answered "per account only", and this key shape is that
 * answer written down: every read the console makes is one key it already knows the name of.
 *
 * ⚠️ **Nothing hashed, nothing credential-shaped, and the values under it are the same.** A tier is a
 * constant and an account id is what every Admin query already carries; the events themselves carry a
 * lineage id, an action and a timestamp — see `IReuseEvent`, where the omission is the contract.
 */
export const reuseEventsKey = (tier: Tier, accountId: string) => `${process.env.REDIS_KEY}reuse:${tier}:${accountId}`

/**
 * The counter incremented whenever a refresh loses a race and is told to retry (E14-S04).
 *
 * ⚠️ **A count and nothing else** — no token, no key, no account id — for the same reason as the counter
 * above. It answers two questions nothing else can: a window never hit is a window that can be shortened,
 * and a window hit constantly means an SPA is refreshing in a loop. Both are invisible without it, and
 * E14-S09 is the story that reads it.
 */
export const graceHitsKey = () => `${process.env.REDIS_KEY}grace-hits`

/**
 * The one hash every service reads its cookie-signing keys from at boot (ADR-034).
 *
 * ⚠️ **What it holds is wrapped, and that is the whole security argument for keeping keys in Redis at
 * all.** A dump of this database yields opaque session tokens today; raw signing keys next to them would
 * turn one read into the ability to mint any cookie for any account. Under `wrapped` is AES-256-GCM
 * ciphertext whose key is `KEYGRIP_KEK`, which lives in env and is never written here.
 *
 * Fields: `version` (an integer, bumped on every rotation and authenticated as the AAD), `wrapped` (the
 * blob), `fp` (the fingerprint of the key ids, in the clear and safe there).
 *
 * Not a hashed key and not confusable with one: a digest is 64 hex characters and this is a word.
 */
export const keygripKey = () => `${process.env.REDIS_KEY}keygrip`

/**
 * Which service last adopted which key set: `<service name> -> <fingerprint>@<ISO-8601>`.
 *
 * ⚠️ **This is the detection that did not exist**, and the reason E01 carried an open question for two
 * incidents. Five services each read their keys from their own `.env` and nothing compared the five
 * copies; disagreement showed up as users being logged out by whichever service the edge happened to
 * pick. One row per service, all rows carrying the same fingerprint, is the platform saying it agrees —
 * and after a rotation it is also the progress bar, because a service that has not swapped yet still
 * shows the old one.
 *
 * Written at boot and again on every live swap. Nothing reads it at runtime: it exists for
 * `keygripStatus` (E01-S14) and for an operator with `redis-cli`.
 */
export const keygripHoldersKey = () => `${process.env.REDIS_KEY}keygrip:holders`

/**
 * The pub/sub channel a rotation announces itself on; the payload is the new version number.
 *
 * ⚠️ **The message is a nudge, not the key.** Subscribers re-read the record and unwrap it themselves, so
 * a publisher cannot hand a service key material it did not already have the KEK to read, and a lost
 * message costs a delay rather than a wrong key — the same read runs on a timer for exactly that reason.
 */
export const keygripChannel = () => `${process.env.REDIS_KEY}keygrip:rotated`

/**
 * Whether a hash reply is a session.
 *
 * ⚠️ **The nullish arm is not dead defensiveness.** `hGetAll` is declared to answer a `Record`, and the
 * live client does — but a hash read is the one place on this platform where "nothing there" and "the
 * client handed back something odd" have to reach the same exit, because the caller turns a miss into a
 * 498 and a `TypeError` into a 500. `Object.keys(null)` throws, so without this the difference between
 * those two answers would be the difference between a re-login and an incident.
 */
const isSessionHash = (hash: Record<string, string> | null | undefined) => hash != null && Object.keys(hash).length !== 0

/**
 * Reads a session hash, by the one key shape a session has ever been written under since the cutover.
 *
 * ⚠️ **This read had a raw-key second half until E13-S10 removed it.** A token that misses the digest
 * now misses altogether, which is the property the hashed namespace was introduced to buy: a raw session
 * key is no longer a working credential, so a Redis dump taken before the cutover cannot be replayed
 * against a live platform. The removal was safe to make because there was no cutover deploy to drain —
 * see the story.
 *
 * Returns an empty hash on a miss, so callers keep the "empty means no session" test they already had —
 * and get it for a nullish reply too, which is what makes that test the *only* one they need.
 */
export async function readSessionHash(store: Pick<ISessionKeyStore, 'hGetAll'>, token: string): Promise<Record<string, string>> {
	const hash = await store.hGetAll(sessionKey(token))

	return isSessionHash(hash) ? hash : {}
}

/**
 * Reads one field of a session hash, by the same single key shape as `readSessionHash`. `null` is "no
 * session", exactly as a single `hGet` answered before the fallback existed and again after it went.
 */
export async function readSessionField(store: Pick<ISessionKeyStore, 'hGet'>, token: string, field: string) {
	return store.hGet(sessionKey(token), field)
}

/**
 * Deletes one session, with one single-key `del` (BCON-08).
 *
 * ⚠️ **This deleted two key shapes until E13-S10 reduced it to one.** The second `del` was aimed at a
 * pre-cutover raw-token key, and a shape that can no longer be written and can no longer be read is a
 * shape there is nothing to delete: keeping the call would be one wasted round trip per logout against a
 * cluster, and would read as though the cutover were still running.
 *
 * ⚠️ **Still a single-key `del` and never a multi-key one.** The constraint outlives the pair — the
 * caller that ends several sessions issues one command each, so nothing here assumes two keys share a
 * cluster slot.
 */
export async function deleteSession(store: Pick<ISessionKeyStore, 'del'>, token: string) {
	await store.del(sessionKey(token))
}

/**
 * The field of a refresh session hash that names its access half.
 *
 * Declared `keyof IRefreshData` rather than written as a bare string at each call site: renaming the field
 * then fails to compile here instead of turning every revocation into a read that answers `null` and a
 * routine that silently retires nothing.
 */
const ACCESS_KEY_FIELD: keyof IRefreshData = 'accessKey'

/**
 * Ends the access token one refresh session minted, given that session's **key** (R54, 2026-08-13).
 *
 * A revocation reaches a session through the index, which holds the body of a session *key* and no token
 * at all — so nothing it has in hand can name the access half. `IRefreshData.accessKey` is what closes
 * that: the refresh hash records the key of the access session minted beside it, stamped at login and
 * re-stamped by every rotation, so one `hGet` turns a refresh session into the pair it really is.
 *
 * ⚠️ **Before the refresh session is deleted, never after.** The field lives *inside* the hash this
 * caller is about to remove, so the other order cannot read it at all. The window this one leaves is the
 * harmless half of the pair: an access session deleted whose refresh session survives is still listed,
 * still indexed and revoked again by the next call, while the reverse would recreate exactly the orphan
 * `accessKey` exists to prevent — a live access token in no index and no family, reachable by nothing.
 *
 * ⚠️ **A key, not a token, and it is deleted verbatim.** What the hash carries is already the full Redis
 * key of the access session — `sessionKey(accessToken)`, a digest behind the shared prefix — so hashing it
 * again would name a key that has never existed. Storing it is not storing a credential: presenting a
 * digest grants nothing, and E17 renders none of it.
 *
 * ⚠️ **A falsy value is "nothing to retire", and both falsy cases are real.** A session minted before the
 * field existed carries none, and `hGet` answers `null` for a hash that is already gone — the ordinary
 * outcome when a session expired between the index read and this call. Neither is an error, and neither
 * may become a `del` of the bare prefix, which would name the wrong key for everyone.
 */
export async function retireAccessSession(store: Pick<ISessionKeyStore, 'hGet' | 'del'>, refreshSessionKey: string) {
	const accessKey = await store.hGet(refreshSessionKey, ACCESS_KEY_FIELD)

	if (!accessKey) return

	await store.del(accessKey)
}

/**
 * What one field of a session index holds, and the whole of it (decided 2026-08-13).
 *
 * ⚠️ **No token material, ever.** The field *name* is already the digest that identifies the session, so
 * the value exists only to describe it to a human — E17 renders this list to an account. Anything that
 * could be presented as a credential belongs in the session hash, which is keyed by a digest and read
 * only by whoever already holds the token.
 *
 * `mintedAt` is the *session's* mint, not the current token's: it is `originalLogin`, carried forward
 * unchanged by every rotation exactly as the refresh hash carries it. A rotating session must not look
 * freshly created every fifteen minutes — the row names a login, and the operator reading it is asking
 * when that login happened.
 */
export interface ISessionIndexEntry {
	tier: Tier
	mintedAt: string
}

/**
 * How long an index key lives: the **longer** of the two session caps (E14-S05), in seconds.
 *
 * ⚠️ **Unconditional, and never the cap of the session being written.** One unremembered login after a
 * remembered one would otherwise pull the whole key's TTL down to a day and orphan the thirty-day
 * session — live, listed nowhere, and therefore silently missed by E15-S04's revocation. E15-S03 prunes
 * fields that outlive their sessions; nothing recovers a session that outlives its index, so this number
 * must never be the shorter one.
 */
export const SESSION_INDEX_TTL_SECONDS = (SESSION_CAP_DAYS_REMEMBERED * MILLISECONDS_PER_DAY) / 1000

/**
 * Files a freshly minted session under its account, so the account can enumerate its own sessions without
 * scanning the keyspace (E15-S02). Called by every login and by every rotation.
 *
 * ⚠️ **The token goes in prefixed — `refresh:…`, exactly as `sessionKey` takes it.** The field name is
 * the digest of the *session key body*, which is what lets E15-S04 rebuild the key to delete as
 * `${REDIS_KEY}${field}` with no token in hand. Hashing the bare uuid here would produce an index that
 * names nothing revocable, and nothing would notice until the first revocation quietly deleted no keys.
 *
 * ⚠️ **The `expire` is reissued on every write, not set once.** A key whose TTL were set only when it was
 * first created would take the whole account's index down thirty days after its first login, however
 * recently it logged in since.
 *
 * ⚠️ **The field carries its own TTL, and it is the session's absolute cap** (E15-S03). Rotation and
 * logout remove the field they supersede, but a session that simply expires passes through neither, so
 * without a per-field TTL the index would only ever grow — a slow leak, and a list of sessions that
 * cannot be used shown to an operator deciding which to end. The number is the remaining time to
 * `originalLogin + sessionCapDays`, not the session key's 90-day physical TTL: after E14-S05 a session
 * key outlives the session it holds, so a field expiring with the key would keep naming a login nobody
 * can make. **Rotation therefore does not extend it** — the successor is written with the remainder its
 * predecessor carried, computed from the same `originalLogin`, which is what stops a session that
 * refreshes every fifteen minutes from being listed for ever.
 *
 * ⚠️ **Only the refresh session is indexed, and that is no longer the same thing as revoking only the
 * refresh session.** A session *is* its refresh lineage; the access token is a derived credential with a
 * life measured in minutes, and filing it here would double the index for something that expires on its
 * own. What reaches it instead is the `accessKey` field the row's own session hash carries — see
 * `retireAccessSession`, which every revocation built on this index calls before it deletes a session
 * (R54). One row still names one login; ending it now ends both halves of it.
 */
export async function indexSession(
	store: ISessionIndexStore,
	prefixedRefreshToken: string,
	{ _id, tier, originalLogin, sessionCapDays }: IRefreshData
) {
	const key = sessionIndexKey(tier, _id)
	const field = hashSessionToken(prefixedRefreshToken)
	const entry: ISessionIndexEntry = { tier, mintedAt: originalLogin }

	await store.hSet(key, { [field]: JSON.stringify(entry) })
	await store.expire(key, SESSION_INDEX_TTL_SECONDS)
	await store.hExpire(key, field, sessionCapRemainingSeconds(originalLogin, sessionCapDays))
}

/**
 * Removes one session from its account's index (E15-S03). Called by rotation for the token it has just
 * consumed, and by logout for the token it has just deleted.
 *
 * ⚠️ **After the session key is gone, never before.** Between the two there is a window, and only one
 * order makes it harmless: unfile-then-delete leaves a live session listed nowhere for the width of that
 * window — invisible to a revocation, which is the one moment the index has to be right — while
 * delete-then-unfile leaves a row naming a key that no longer exists, and the field's own TTL removes
 * that row even if this call never happens.
 *
 * ⚠️ **The token goes in prefixed**, exactly as `indexSession` takes it. The field to remove is the
 * digest of the same string the write hashed; anything else silently deletes nothing, and a `hDel` that
 * matched no field is indistinguishable from one that matched.
 */
export async function unindexSession(
	store: ISessionIndexPruneStore,
	prefixedRefreshToken: string,
	{ _id, tier }: Pick<IRefreshData, '_id' | 'tier'>
) {
	await store.hDel(sessionIndexKey(tier, _id), hashSessionToken(prefixedRefreshToken))
}
