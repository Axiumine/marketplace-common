import { Tier } from '@others/Tier.mjs'

/**
 * What the refresh-token session hash holds. The `_id`, the tier, and the three fields that describe
 * the *lineage* this token belongs to — everything else the access token carries is re-read from the
 * database on refresh.
 *
 * `tier` is required. The authorization service that receives a refresh cookie looks the `_id` up in
 * *its own* collection, so a foreign token used to fail only by accident — because that id happened
 * not to exist there. It is now refused on purpose, before any query runs.
 *
 * ⚠️ **Every *lineage* field here is required, and the three E14 fields are required for a reason that is
 * not tidiness.** A session minted before E14 landed carries none of them. Were `familyId` optional, the
 * first rotation after the deploy would write every such session into one shared `family:undefined`
 * set, and a single reuse event would then mass-revoke unrelated accounts across every tier. Refusing
 * structurally converts that into a one-time forced re-login for sessions older than the deploy —
 * loud, bounded and correct — instead of a silent cross-account blast radius. `assertRefreshLineage`
 * is where the refusal happens.
 *
 * ⚠️ **Everything a Redis hash holds is a string**, which is why the two numeric fields are typed as
 * ones. `hSet` stringifies whatever it is handed, and a reader that trusted a `number` here would be
 * reasoning about a type Redis never returns.
 */
export interface IRefreshData {
	_id: string
	tier: Tier
	/**
	 * Constant for the whole rotation chain born of one login, and the handle every key descended from
	 * that login is revoked by. Minted at login, copied unchanged through every rotation.
	 */
	familyId: string
	/** When the *login* happened, epoch millis as a string. Never moved forward by a rotation — that is what makes the cap absolute. */
	originalLogin: string
	/** The absolute age cap in days, resolved from `rememberMe` at login and frozen into the lineage. */
	sessionCapDays: string
	/**
	 * The Redis key of the access token minted beside this refresh token — the whole key, prefix and digest
	 * included, exactly as `sessionKey` built it. Written by the three login writers and re-written by every
	 * rotation, so it always names the *current* half of the pair.
	 *
	 * ⚠️ **A session is a pair, and before this field only the client knew that.** Everything that ends a
	 * session — rotation, logout — could reach the access token only through the `Authorization` header the
	 * call happened to carry. A refresh sent without one therefore left its predecessor alive for the rest of
	 * its 30–91 minutes: in no family, in no index row, and reachable by nothing. That is the ordinary
	 * page-reload path rather than an exotic one, because the access token lives in memory and a reload
	 * discards it. Holding the key here makes the pair a property of the session instead of a property of the
	 * request.
	 *
	 * ⚠️ **A key, never a token.** It is the digest `sessionKey` already produced, so this stores nothing that
	 * could be presented as a credential — the same reason the session index stores field names and not
	 * tokens. Anything that puts a raw `access:…` value here undoes E13-S01 through the side door.
	 *
	 * ⚠️ **The one optional field, and the option is a migration rather than a choice.** A session minted
	 * before this landed carries none, and absent must mean *nothing to retire* — which is exactly the
	 * behaviour those sessions have today. The alternative is the refusal `assertRefreshLineage` makes for
	 * the lineage fields, and that refusal is right there and wrong here: a missing `familyId` would file
	 * unrelated accounts into one revocable set, while a missing access key costs one already-orphaned token
	 * the minutes it had left. Forcing a re-login for that would be a worse trade than the thing it fixes.
	 * The field drains on its own — every rotation writes one — so nothing has to remove this option later.
	 */
	accessKey?: string
}
