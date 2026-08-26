import { throwForbiddenError } from '@axiumine/koa-utils/graphQL/throw/throwForbiddenError'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5000

/**
 * Refuses a request whose Cloudflare Turnstile token does not verify.
 *
 * Turnstile over hCaptcha or reCAPTCHA: no puzzle for the visitor, no cookie planted in their browser,
 * and a free tier that does not meter at the volume a 500K-user platform registers at. It is a bot cost
 * multiplier, not an authentication step — pair it with `assertUnderRateLimit`, which is what actually
 * bounds a determined attacker who has bought solves.
 *
 * ⚠️ **Fails closed in production, bypasses everywhere else.** With no `TURNSTILE_SECRET` set, a
 * production process refuses every gated mutation rather than waving them through — a missing secret is
 * a deployment mistake, and the safe reading of it is "the gate is broken", not "the gate is off". Any
 * other `NODE_ENV` returns silently, because integration suites and local development have no site key
 * and would otherwise be unable to register a user at all. This is also why `TURNSTILE_SECRET` is **not**
 * in any service's `REQUIRED_ENV_VARS`: those abort the process at boot, and a service that cannot start
 * without a captcha secret cannot run its own tests.
 *
 * A network failure or a non-2xx answer from Cloudflare is treated as a failed verification, so an
 * outage there closes registration rather than opening it. The 5 s timeout bounds how long a hung
 * verifier can hold the request open — without it, `fetch` waits on the OS default, which is minutes.
 *
 * ⚠️ **The siteverify body carries `secret` and `response` and nothing else — no `remoteip`, and the
 * parameter to supply one is gone rather than merely unused.** The browser solves the challenge against
 * `challenges.cloudflare.com` directly, which is why the vhosts carry that host in their CSP, so
 * Cloudflare already observed the address at issue time and repeating it server-side buys no signal. It
 * cost something, though: it was the last path on which a client address left this infrastructure. An
 * optional argument that must never be supplied is a defect waiting for its next caller, so
 * reintroducing it is a change to this package rather than a one-word edit in a guard.
 */
export async function assertTurnstile(token: string | undefined) {
	const secret = process.env.TURNSTILE_SECRET

	if (!secret) {
		if (process.env.NODE_ENV === 'production') throw throwForbiddenError()
		return
	}

	if (!token) throw throwForbiddenError()

	const body = new URLSearchParams({ secret, response: token })

	let success = false

	try {
		const res = await fetch(VERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout(TIMEOUT_MS)
		})

		// `fetch` only rejects on a transport failure — a 500 from Cloudflare arrives as a resolved
		// response, and parsing its HTML error page as JSON would throw somewhere much less obvious
		if (res.ok) success = ((await res.json()) as { success?: boolean }).success === true
	} catch {
		// Deliberately swallowed, and deliberately empty. The outcome is already "not verified" — `success`
		// is initialised `false` and is only ever raised on the one line that cannot be reached from here —
		// and the token is attacker-supplied, so neither the error nor the token belongs in a log line.
		// A `success = false` here re-assigns the value it already holds, which is a mutant no test can
		// kill: Stryker empties the block and nothing observable changes. An empty block is not mutated at
		// all, and eslint's `no-empty` accepts one that carries a comment.
	}

	if (!success) throw throwForbiddenError()
}
