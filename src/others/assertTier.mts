import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'
import { Tier } from '@others/Tier.mjs'

/**
 * Refuses a session that was minted for a different tier.
 *
 * ⚠️ Every service on the platform shares one `REDIS_KEY` prefix, deliberately — the single logout
 * service deletes a session by token content and cannot know which tier issued it. The cost of that
 * choice is that a session key from any tier is *findable* by any service, so the tier check is the
 * only thing standing between an Admin access token and the ShopOwner resource API. Before this
 * existed, that token was simply accepted.
 *
 * **A missing `tier` is invalid, not a wildcard.** Sessions minted before the field existed carry no
 * tier, and `undefined !== expected` rejects them — deliberately, without a branch of their own.
 * Treating them as trusted would keep the hole open for the whole refresh-token lifetime
 * (`REFRESH_TOKEN_EXPIRY`, 90 days); rejecting them costs those sessions one re-login.
 *
 * 403 rather than 401: the caller authenticated correctly, it simply authenticated somewhere else.
 * The distinction matters to the client, which must not try to refresh its way out of this.
 */
export function assertTier(actual: string | undefined, expected: Tier): void {
	if (actual !== expected) throw throwForbiddenError()
}
