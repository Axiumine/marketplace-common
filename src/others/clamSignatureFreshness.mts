/**
 * How old the virus signatures behind a `clamd` are, read from the daemon's own version reply.
 *
 * ⚠️ **A scanner with stale signatures answers `clean` exactly as fast as one with fresh ones**, and
 * nothing upstream of it can tell the difference. `initClamScan` proves a daemon is reachable and the
 * scan path works; it says nothing about when that daemon last learned what a malicious file looks like.
 * On this platform nothing runs `freshclam`, no timer checks it, and no alert fires — RISK_REGISTER R22.
 * A host whose signature database stopped updating six months ago keeps every upload green.
 *
 * The reply this reads is `nVERSION`, which `clamd` answers with three `/`-separated fields:
 *
 * ```
 * ClamAV 0.103.11/27412/Thu Sep  4 08:31:07 2026
 * ```
 *
 * the engine version, the signature database version, and the date that database was built. The third
 * field is the only one that answers the question — a bumped engine with a year-old database is the
 * failure this exists for, so the numeric middle field is deliberately ignored.
 *
 * ⚠️ **Nothing here throws, and nothing here decides what to do.** It is a pure reading: a caller at boot
 * turns a `stale` or `unreadable` verdict into a log line and a Sentry event, and carries on. A helper
 * that threw would take down a service whose scanner is working, over a version string — which is a
 * worse outcome than the risk it reports, and would make the honest call site a `try`/`catch` that
 * swallows everything including its own bugs.
 */

/** What a version reply says about the signature database behind it. */
export type ClamSignatureVerdict =
	| { state: 'fresh'; ageMs: number; builtAt: Date }
	| { state: 'stale'; ageMs: number; builtAt: Date }
	| { state: 'unreadable'; reply: string }

/**
 * The build date out of a `nVERSION` reply, or `undefined` when the reply is not one.
 *
 * ⚠️ **Field 3 onwards by position, not by pattern.** The engine version carries dots and the database
 * version is a bare number, so a "find the date-shaped field" rule would work today and break the first
 * time ClamAV adds a fourth field — while everything past the second `/` on a reply that has changed
 * shape fails to parse and reads as unreadable, which is the safe answer rather than a confident wrong
 * one.
 *
 * ⚠️ **The tail is re-joined on `/` rather than taken as one field**, because a date is allowed to contain
 * the separator: `ClamAV 0.103.11/27412/2026/09/04` is a reply whose build date is `2026/09/04`, and
 * `split('/')[2]` would read it as `2026` alone — which `Date.parse` reads as the first of January, so a
 * database built this morning gets reported eight months stale.
 * A reply with no third field joins to the empty string, which `Date.parse` refuses, so the missing-field
 * case needs no branch of its own — it is already the unreadable case.
 *
 * Nothing here strips the newline, the NUL terminator or the padding a socket adds around the reply:
 * `Date.parse` skips all three on its own, so a `.trim()` or a `.replaceAll('\0', '')` here would be code
 * that cannot change an answer.
 */
export const parseClamSignatureDate = (reply: string): Date | undefined => {
	const builtAtField = reply.split('/').slice(2).join('/')
	const parsed = Date.parse(builtAtField)

	return Number.isNaN(parsed) ? undefined : new Date(parsed)
}

/**
 * Reads a `nVERSION` reply and says whether the signatures behind it are still young enough.
 *
 * `now` and `maxAgeMs` are arguments rather than a clock read and a constant, so a caller owns both and
 * a test can pin the boundary without moving the machine's clock. The boundary itself is `>`: a database
 * built exactly `maxAgeMs` ago is still fresh, so a threshold of one day and a daily rebuild do not
 * alternate between verdicts on rounding alone.
 *
 * ⚠️ **A date in the future is fresh, not an error.** Clock skew between a container and the host that
 * built the signatures is ordinary, and a negative age says the database cannot be stale. Reporting it
 * as a problem would train the reader to ignore this alert, which is the failure mode that matters more
 * than the skew.
 */
export const clamSignatureFreshness = (reply: string, now: number, maxAgeMs: number): ClamSignatureVerdict => {
	const builtAt = parseClamSignatureDate(reply)

	if (builtAt === undefined) return { state: 'unreadable', reply }

	const ageMs = now - builtAt.getTime()

	return { state: ageMs > maxAgeMs ? 'stale' : 'fresh', ageMs, builtAt }
}
