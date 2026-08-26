import { GraphQLError } from 'graphql'

/**
 * The error code a client matches on to decide that a `refresh` is worth retrying (E14-S04).
 *
 * ⚠️ **The three SPAs branch on this string.** Changing it silently turns every lost refresh race into a
 * logout, in three repos at once, with nothing failing anywhere — so it is a constant with a name rather
 * than a literal repeated four times.
 */
export const REFRESH_RACE_RETRY_CODE = 'REFRESH_RACE_RETRY'

/**
 * Answers a refresh token that was consumed moments ago by *another tab of the same client*: the loser of
 * an ordinary multi-tab race, not a replay.
 *
 * 409 rather than 498, and a code of its own, because the two mean opposite things to the client. 498 is
 * "log in again"; this is "your cookie jar already holds the winner's token, send the request again". The
 * distinction is the whole reason the grace window exists — without it the loser of a race that happens on
 * every page load with two tabs open would be logged out of every session it has.
 *
 * ⚠️ **Nothing is minted on this path, deliberately.** An earlier design cached the winner's new pair and
 * replayed it to the loser; that stored a directly replayable credential as a Redis *value*, which is
 * precisely what E13 removed from this platform. The retry needs no such cache: by the time the client
 * retries, the winner's `Set-Cookie` has landed in the jar both tabs share.
 */
export const throwRefreshRaceRetry = (): never => {
	throw new GraphQLError('Refresh In Progress', {
		extensions: {
			http: { status: 409 },
			code: REFRESH_RACE_RETRY_CODE,
			description: 'This refresh token was just rotated by another request. Retry with the current cookie.'
		}
	})
}
