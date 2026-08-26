import { IContextLogin } from '@axiumine/koa-utils/graphQL/schema/context/IContextLogin'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import {
	accessTokenExpiry,
	generateAccessToken,
	generateRefreshToken,
	REFRESH_TOKEN_EXPIRY
} from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IRefreshData } from '@others/IRefreshData.mjs'
import { ITombstoneData } from '@others/ITombstoneData.mjs'
import { guardFamilyMintRate } from '@others/refreshRateLimit.mjs'
import { TAuthorizationSession } from '@others/resolveAuthorizationSession.mjs'
import { deleteSession, familyKey, indexSession, sessionKey, tombstoneKey, unindexSession } from '@others/sessionKeys.mjs'
import { GraphQLError } from 'graphql'

/**
 * The six Redis commands the rotation issues, and nothing else. A parameter rather than an
 * import, for the reason spelled out on `ISessionReadStore`.
 *
 * `sAdd` arrived with E14-S02: every rotation files the pair it mints into the lineage's set, which is
 * what `revokeSessionFamily` walks when a consumed token is replayed. It is one key with two members,
 * not a multi-key command — BCON-08 is about the keys.
 *
 * `incr` and `ttl` arrived with E14-S08, and they are the reason this interface is not `Pick`ed down per
 * call site: with those two present it satisfies `IRateLimitStore` structurally, so the per-family mint
 * limiter needs no second injection point and a unit test passes one stub for both roles.
 *
 * `hExpire` and `hDel` arrived with E15-S03: the index field the successor is written under carries the
 * session's absolute cap, and the predecessor's field is removed once the token it names is gone. Both
 * address one key.
 */
export interface ISessionWriteStore {
	hSet(key: string, value: Record<string, string>): Promise<unknown>
	expire(key: string, seconds: number): Promise<unknown>
	del(key: string): Promise<unknown>
	sAdd(key: string, members: string[]): Promise<unknown>
	incr(key: string): Promise<number>
	ttl(key: string): Promise<number>
	hExpire(key: string, fields: string, seconds: number): Promise<unknown>
	hDel(key: string, field: string): Promise<unknown>
}

export interface IRefreshSessionTokensInput<TAccountData extends object> {
	store: ISessionWriteStore
	/** Only the cookie jar is touched — `setLoginCookies` needs nothing else off the Koa context. */
	ctx: IContextLogin
	/** `ctx.state.user`, as the authorization middleware built it. */
	session: TAuthorizationSession<TAccountData>
	/**
	 * The access token the call arrived with, `access:` prefix included — `ctx.request.header.authorization`
	 * with `Bearer ` stripped, exactly as `authorizationLogoutHandler` reads it (E14-S06).
	 *
	 * Optional, and tolerated when absent: a client refreshing after its access token expired has none to
	 * send, which is the ordinary case rather than an error.
	 */
	presentedAccessToken?: string
	/**
	 * `Sentry.captureException`. Injected because `@sentry/node` is a dependency of the *services*;
	 * importing it here would make every consumer of a Mongoose model install Sentry.
	 */
	captureException: (e: unknown) => void
}

/**
 * Mints a new access/refresh pair for an already-authorized session, stores both in Redis, sets the
 * refresh cookie and **deletes the refresh token the call was made with**.
 *
 * The three `*-authenticated-authorization` services carried a copy of this each, identical down to
 * the comments. Three properties are worth stating once here rather than three times there:
 *
 * - **It rotates, it does not re-issue.** Both old keys are deleted on the way out — the refresh key
 *   and, since E14-S06, the access token that pair carried — so a stolen pair is worthless the
 *   moment the legitimate client refreshes, rather than half-worthless for another hour. The access half
 *   is found through the key the session records and no longer only through the `Authorization` header,
 *   which is what makes a headerless refresh — the ordinary page reload — rotate both halves instead of
 *   one.
 * - **The refresh hash records the access key it minted**, which is the whole of `accessKey` on
 *   `IRefreshData`: a session is a pair, and everything that ends one has to be able to find both halves
 *   without holding either token.
 * - **The access hash is the session minus its refresh token and minus the lineage.** Stripping the
 *   refresh token is what keeps it unreadable from an access-token lookup, which is the whole point of
 *   holding two; stripping the lineage is what keeps a rotated session's access hash identical in shape
 *   to a freshly logged-in one.
 * - **The refresh hash keeps `_id`, `tier` and the lineage.** Everything else is re-read from the
 *   database on the next refresh, so a stale email or a since-revoked onboarding step cannot survive in
 *   it. The tier is carried because the *next* refresh asserts it before it queries anything — and the
 *   value propagated here is the one the middleware already checked, not one re-derived from the hash.
 * - **The old token is tombstoned before it is deleted, and the new pair is filed into the family
 *   first** (E14-S02). Both orderings are load-bearing and both are asserted: a marker written after
 *   the delete can be lost to a process death, and a pair filed after its own tombstone could be
 *   replayed against a family that does not yet name it.
 * - **The lineage is metered before anything is minted** (E14-S08). Twenty pairs an hour per family,
 *   counted on entry so that only real mints count — see `guardFamilyMintRate` for why a request that
 *   mints nothing must not.
 *
 * ⚠️ On any failure both freshly-written session keys are deleted before the error is rethrown. A
 * session stored without its TTL would never expire, so a half-written rotation must leave nothing
 * behind. Those two deletes name the hashed keys directly rather than going through `deleteSession`:
 * this call minted them moments ago, so no raw-shape twin can exist and looking for one would be a
 * second round trip on the error path for a key that is provably absent.
 *
 * ⚠️ **The rollback does not unwind the tombstone or the family entry, deliberately.** A rotation that
 * failed left the old refresh key alive, so the tombstone is unreachable — nothing reads one until a
 * live-key miss — and it is overwritten by the rotation that eventually succeeds. The family members it
 * added point at keys the rollback has just deleted, and deleting an absent key is a no-op. Unwinding
 * either would add commands to an error path to tidy state that is already inert.
 */
export async function refreshSessionTokens<TAccountData extends object>({
	store,
	ctx,
	session,
	presentedAccessToken,
	captureException
}: IRefreshSessionTokensInput<TAccountData>): Promise<{ status: boolean; accessToken: string }> {
	// ⚠️ **First statement in the function, and that is the point** (E14-S08). This is the mint path — the
	// grace branch and every rejection throw inside `resolveAuthorizationSession` and never arrive here —
	// so counting on entry counts mints and nothing else. It also runs before a single token is generated
	// or a single key written, so a refused rotation costs one `INCR` and leaves no state to unwind.
	await guardFamilyMintRate(store, session.familyId)

	// `status` is only ever read once, in the `return` below. The try block's only exit
	// before that return sets it to `true`, and the catch block's last statement,
	// tryCatchRethrow(e), throws unconditionally in every branch (GraphQLError, Mongo
	// error, or anything else) — so a caught error never reaches `return` at all. There is
	// no path on which this declared value is observable: flipping it cannot change any
	// output. Equivalent mutant.
	// Stryker disable next-line BooleanLiteral: initial value is provably unobservable, see comment above
	let status = false // default

	let accessToken = generateAccessToken()
	const refreshToken = generateRefreshToken()
	// Digests, not tokens (E13-S01), and of the **prefixed** value: `access:…` and `refresh:…` are what
	// every reader presents, so hashing the bare uuid here would mint a session nothing can ever find.
	const keyAccess = sessionKey(`access:${accessToken}`)
	// Built once and kept: `sessionKey` and the account index both take the prefixed value, and the index
	// field has to be the digest of *this* string or it names a key nothing can rebuild (E15-S02).
	const prefixedRefresh = `refresh:${refreshToken}`
	const keyRefresh = sessionKey(prefixedRefresh)

	// Destructured rather than `delete session.refreshToken`, which is what the three copies did:
	// that mutated `ctx.state.user` in place — the caller's object — to build a payload nobody reads
	// afterwards, and needed a `@ts-expect-error` to do it. The rest object carries exactly the same
	// fields the delete left behind.
	//
	// ⚠️ The three lineage fields come out here too, so the **access hash keeps exactly the shape the
	// login writers give it**. They describe the refresh lineage and belong to the refresh hash; letting
	// them fall into the rest object would mean a session minted by a rotation and one minted by a login
	// looked different to every resource service that reads the access hash.
	//
	// ⚠️ `accessKey` comes out for the same reason and one more: it is the key of the access token this
	// rotation is *retiring*, so writing it into the successor's access hash would leave every access
	// session naming a key that has just been deleted.
	const {
		refreshToken: oldRefresh,
		familyId,
		originalLogin,
		sessionCapDays,
		accessKey: boundAccessKey,
		...accessTokenData
	} = session

	// The tier is carried into both new hashes. `session` is what the authorization middleware built
	// *after* asserting the tier of the incoming refresh session — so this propagates a value that
	// has already been checked, it does not re-derive one.
	//
	// The lineage is propagated, never re-minted: `familyId` is what makes the whole chain revocable as
	// one unit, and `originalLogin` is what makes the age cap absolute. A rotation that stamped either
	// afresh would hand every session an unlimited life one refresh at a time.
	//
	// `accessKey` is the one field re-stamped rather than propagated: it names the access token minted on
	// *this* call, which is the half a later logout or rotation will have to retire. Carrying the
	// predecessor's forward would leave every session pointing one rotation behind.
	const refreshTokenData: IRefreshData = {
		_id: session._id,
		tier: session.tier,
		familyId,
		originalLogin,
		sessionCapDays,
		accessKey: keyAccess
	}

	const keyFamily = familyKey(familyId)
	const keyTombstone = tombstoneKey(oldRefresh)
	// The account goes onto the marker with the lineage (E17-S05). It is read from the session this
	// rotation is consuming, which the middleware has already tier-asserted — so the tombstone names the
	// account the *token* belonged to, not the account whichever service later reads it happens to serve.
	const tombstoneData: ITombstoneData = {
		familyId,
		consumedAt: `${Date.now()}`,
		_id: session._id,
		tier: session.tier
	}

	try {
		await Promise.all([
			store.hSet(keyAccess, accessTokenData as unknown as Record<string, string>),
			store.hSet(keyRefresh, refreshTokenData as unknown as Record<string, string>)
		])

		const accTokenExp = accessTokenExpiry()

		await Promise.all([store.expire(keyAccess, accTokenExp), store.expire(keyRefresh, REFRESH_TOKEN_EXPIRY)])

		// File the successor under its account (E15-S02). The lineage carried in `refreshTokenData` is the
		// predecessor's, unchanged — so the entry keeps naming the login this chain started from rather than
		// the moment of this rotation.
		//
		// ⚠️ The rollback below does not remove this field, deliberately, and for the same reason it leaves
		// the tombstone alone: it names two keys the rollback has just deleted, so it grants nothing — and
		// the field's own TTL (E15-S03) bounds it whatever happens next.
		//
		// ⚠️ **The field TTL is not extended by this call**, because `refreshTokenData` carries the
		// predecessor's `originalLogin` and `sessionCapDays` unchanged: the successor's field expires when
		// the *session* does, not thirty days after this rotation. A rotation that re-based it would give a
		// client refreshing every fifteen minutes a row that never ages out.
		await indexSession(store, prefixedRefresh, refreshTokenData)

		// File the new pair into the lineage, and give the set the *physical* TTL rather than the access
		// token's: the set has to outlive every member it names, or a live session would be left with no
		// record of which family it belongs to and no way to be revoked with it.
		await store.sAdd(keyFamily, [keyAccess, keyRefresh])
		await store.expire(keyFamily, REFRESH_TOKEN_EXPIRY)

		// ⚠️ **The tombstone goes down before the old key comes up, and the order is the whole control**
		// (E14-S02). Delete-then-tombstone leaves a window in which a process death produces a consumed
		// token with no marker, and a later replay of it then looks exactly like ordinary expiry. Written
		// first, the marker is simply invisible until the delete lands: the old key still resolves, and
		// `resolveAuthorizationSession` consults a tombstone only after a miss.
		await store.hSet(keyTombstone, tombstoneData as unknown as Record<string, string>)
		await store.expire(keyTombstone, REFRESH_TOKEN_EXPIRY)

		setLoginCookies(ctx, refreshToken)

		// Retire the access token this rotation supersedes (E14-S06). Without it the old access token lives
		// out its remaining 30–91 minutes in parallel with its successor, so a stolen pair keeps working
		// through a rotation the legitimate client made.
		//
		// ⚠️ **Two names can reach that token and only one of them is reliable.** `presentedAccessToken` is
		// whatever the request carried, and the ordinary page-reload path carries nothing: an access token
		// lives in memory, so a reloaded SPA refreshes with a cookie and no `Authorization` header. For as
		// long as this was the only name, every one of those reloads orphaned a live access token — in no
		// family, in no index row, and reachable by no logout and no revocation. `boundAccessKey` is the key
		// the session itself records, so it is right whatever the request looked like.
		//
		// Both are still used, and the set is what keeps that honest: they name the same key in the ordinary
		// case, they differ when a client presents an access token older than the one its session records,
		// and a pre-deploy session has no bound key at all. Deleting a set of names costs one `del` per
		// *distinct* key — never two commands for one key, and never the multi-key `del` BCON-08 refuses.
		const accessKeysToRetire = new Set<string>()

		if (boundAccessKey !== undefined) accessKeysToRetire.add(boundAccessKey)
		if (presentedAccessToken) accessKeysToRetire.add(sessionKey(presentedAccessToken))

		await Promise.all([...accessKeysToRetire].map((key) => store.del(key)))

		// Delete the refresh token this call was made with. One key, one shape, since E13-S10 — a rotation
		// that leaves the old refresh key alive is exactly the replay this function rotates to prevent, and
		// the digest is now the only name that key has ever had.
		await deleteSession(store, oldRefresh)

		// Unfile the token that has just been deleted (E15-S03), so one session is one row rather than one
		// row per rotation. **After the delete, never before**: between the two commands there is a window,
		// and only this order makes it harmless — the reverse leaves a still-usable refresh token listed
		// nowhere, which is precisely the session a revocation would miss.
		//
		// `refreshTokenData` names the same account as `session`: the tier and `_id` are propagated, not
		// re-derived, so the predecessor's field is looked for in the key it was written to.
		await unindexSession(store, oldRefresh, refreshTokenData)

		status = true
	} catch (e) {
		captureException(e)
		// Clears the just-minted access token, so that the one path on which this function could
		// still return after a failure — `tryCatchRethrow` is declared `void`, not `never` —
		// hands back an empty string rather than a token whose Redis keys have just been
		// deleted. Defence in depth: `tryCatchRethrow(e)` does throw in every branch it has, so
		// no test can reach that return and no test can observe this value either. Equivalent
		// mutant.
		//
		// ⚠️ The three services this came from cleared `refreshToken` here as well, and cleared
		// `accessToken` a second time after the two `del`s. Both were dead in a way no test
		// could show and Qodana could: nothing reads `refreshToken` after this point at all, and
		// the second `accessToken = ''` was the only reachable read of the first one. Do not
		// restore either — a cleared variable nobody reads is not defence, it is noise around
		// the one clear that is.
		// Stryker disable next-line StringLiteral: cleared value is provably unobservable, see comment above
		accessToken = ''
		// delete keys
		await Promise.all([store.del(keyAccess), store.del(keyRefresh)])
		tryCatchRethrow(e as GraphQLError | Error)
	}

	return {
		status,
		accessToken
	}
}
