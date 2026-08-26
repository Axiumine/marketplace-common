/**
 * The shape of a Sentry event this scrubber touches, declared structurally rather than imported.
 *
 * `@sentry/node` is a devDependency of this package and must stay one — nothing under `src/` may import
 * it, or every consumer of a Mongoose model would pull Sentry in behind it. Every field below is a
 * widening of the real `ErrorEvent`, so `ErrorEvent` satisfies this constraint and `sentryBeforeSend`
 * drops straight into `Sentry.init({ beforeSend })` with no cast at the call site.
 *
 * ⚠️ The same structural declaration is what lets the three frontends wire this function into
 * `@sentry/react` (E12-S24). It walks plain object bags and imports nothing, so the module is
 * browser-safe, and `./others/sentryBeforeSend` is a subpath export — a frontend bundle that imports it
 * pulls in this file and no other part of this package.
 */
export interface ISentryScrubbableEvent {
	request?: { headers?: unknown; env?: unknown; data?: unknown } | undefined
	user?: unknown
	contexts?: { trace?: { data?: unknown } | undefined } | undefined
	spans?: ReadonlyArray<{ data?: unknown; description?: unknown }> | undefined
	breadcrumbs?: ReadonlyArray<{ message?: unknown; data?: unknown }> | undefined
}

/**
 * Keys removed wherever they appear, matched **exactly and case-insensitively**.
 *
 * Two spellings of most names, on purpose. `httpHeadersToSpanAttributes` normalises a header name by
 * replacing every `-` with `_` before it becomes a span attribute (`@sentry/core`
 * `utils/request.js:198-200`), so `set-cookie` arrives as `set_cookie` on a span and as `set-cookie` on
 * `event.request.headers`. A list carrying one spelling misses the other half of the event.
 *
 * The four groups:
 *
 * - **credentials** — `authorization`, `proxy-authorization`, `cookie` / `cookies`, `set-cookie`. A
 *   session token in any of these is the whole session.
 * - **the client address as a header** — `x-forwarded-for`, `x-real-ip`. nginx sets the first, so its
 *   value is the real client address.
 * - **the client address as a span attribute** — `http.client_ip`, `client.address`, `client.port`,
 *   `net.peer.ip`, `net.host.ip`. `http.client_ip` is written by `httpServerSpansIntegration.js:69`,
 *   **outside** the `httpHeadersToSpanAttributes` call on `:75`, so no `dataCollection` option and neither
 *   value of `sendDefaultPii` suppresses it. Only this list does. The two `net.*` pairs sit in the same
 *   position: `net.peer.ip` is the socket peer — nginx in production, the end user on a direct call — and
 *   `net.host.ip` is this process's own address. All four were observed on a captured transaction
 *   (`docs/report/sentry-event-capture.md` §6).
 * - **the caller's user agent** — `http.user_agent` (`httpServerSpansIntegration.js:70`), also outside the
 *   `dataCollection` machinery, plus the `user-agent` / `user_agent` spellings it is copied from. An agent
 *   string is a fingerprinting input next to an address, and removing one spelling of a value while another
 *   bag of the same event still carries it removes nothing — the two-spelling rule above, applied to the one
 *   key E12-S02 had left in.
 * - **the client address elsewhere** — `ip_address` on `event.user`, `remote_addr` in `event.request.env`.
 * - **the key-encryption key** — `keygrip_kek`. The odd one out: it is an environment variable name, not
 *   a header or a span attribute, and it is here because `event.request.env` is a bag the SDK fills from
 *   the process environment and this list is what walks it (ADR-034). It unwraps the cookie-signing keys
 *   for all five services at once, so one event carrying it is every session on the platform forgeable.
 *   No second spelling: an environment variable cannot contain a `-`, so there is nothing to normalise.
 */
const REMOVED_KEYS: ReadonlySet<string> = new Set([
	'authorization',
	'proxy-authorization',
	'proxy_authorization',
	'cookie',
	'cookies',
	'set-cookie',
	'set_cookie',
	'x-forwarded-for',
	'x_forwarded_for',
	'x-real-ip',
	'x_real_ip',
	'http.client_ip',
	'client.address',
	'client.port',
	'net.peer.ip',
	'net.host.ip',
	'http.user_agent',
	'user-agent',
	'user_agent',
	'ip_address',
	'remote_addr',
	'keygrip_kek'
])

/**
 * Every header the SDK turns into a span attribute is removed by prefix, not by name.
 *
 * `@sentry/core` 10.69.0 already drops sensitive header names at collection time
 * (`utils/data-collection/filterKeyValueData.js:11` against `filtering-snippets.js:5-27`). That is a
 * second layer, not a substitute: the snippet list is an implementation detail of a minor version, the
 * version is pinned by nothing, and a header this platform adds later would not be on it. Taking the
 * whole prefix means the guarantee does not depend on either.
 */
const REMOVED_PREFIXES: readonly string[] = ['http.request.header.', 'http.response.header.']

/**
 * Keys whose value is a URL and is kept, minus its query string and its fragment.
 *
 * ⚠️ **The browser SDK ships the whole address bar, and no option turns that off.** Measured, not read:
 * `@sentry/browser` 10.69.0 `integrations/httpcontext.js` calls `getHttpRequestData()` in
 * `preprocessEvent` and writes `event.request.url = location.href` with no `dataCollection` gate anywhere
 * on the path, and `@sentry/core` `integrations/requestdata.js:58` says so in a comment — *"No
 * dataCollection equivalent — URL is always included"*. `urlQueryParams: false` gates
 * `event.request.query_string`, a field the browser never fills in. A captured error event carried
 * `.../reset-password/confirm?token=…&email=…#/probe%40example.invalid/MKTS24HASHPROBE` — query string and
 * fragment both — on `event.request.url`, on `contexts.trace.data['url.full']` and on the `description` of
 * every browser-metric span (`docs/report/sentry-event-capture.md` §9).
 *
 * Truncated rather than deleted: `/reset-password/confirm` is the context that makes a browser event worth
 * reading, and the credential is never in the path. `url.path` is left alone — it has neither part.
 *
 * `referer` earns its place here twice: it is the previous page's whole URL, and it is written by the same
 * unconditional `httpContextIntegration` call as the agent string, so `httpHeaders: { request: false }`
 * does not stop it either.
 */
const URL_VALUED_KEYS: ReadonlySet<string> = new Set(['url', 'url.full', 'http.url', 'http.target', 'referer', 'referrer'])

/**
 * Everything from the first `?` or `#` onwards, removed.
 *
 * Both, and not the fragment alone: a fragment is what a reset link carries **since E12-S26**, a query
 * string is what a link built before it carries, and the SDK copies `location.href` whole either way.
 * Non-strings pass through — a `url` attribute is a string in every capture taken so far, and a scrubber
 * that throws on the first event holding something else loses that event and the error under it.
 */
function sanitiseUrl(value: unknown): unknown {
	if (typeof value !== 'string') return value

	const cut = value.search(/[?#]/)

	return cut === -1 ? value : value.slice(0, cut)
}

/**
 * Whether a free-text value is a URL, for the one place the key does not already say so.
 *
 * An absolute URL or a root-relative path, which is every span description the browser SDK builds from an
 * address. Deliberately narrow: this guard is what keeps `sanitiseUrl` off a description that merely
 * contains a `#` or a `?`, and `lcp.element` — a CSS selector, `p#password-hint` in the capture — is proof
 * that such values exist in the same event.
 */
function looksLikeUrl(value: unknown): value is string {
	return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/'))
}

/**
 * Sanitises one named key of one bag, in place, and only if it is already a string.
 *
 * The string check is the point, not a formality: an assignment through a name that is absent from the bag
 * **creates** it, so a scrubber written without it would add `from: undefined` and `to: undefined` to every
 * breadcrumb of every event — a serialised `null` per breadcrumb per event, sent forever, for nothing.
 */
function sanitiseKey(bag: unknown, key: string): void {
	if (typeof bag !== 'object' || bag === null) return

	const record = bag as Record<string, unknown>
	const value = record[key]

	if (typeof value === 'string') record[key] = sanitiseUrl(value)
}

/**
 * Whether a key is removed. Lower-cased first: header attribute names arrive lower-cased today, and the
 * guarantee must not depend on that staying true.
 */
function isRemovedKey(key: string): boolean {
	const lowerKey = key.toLowerCase()

	return REMOVED_KEYS.has(lowerKey) || REMOVED_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))
}

/**
 * Deletes every removed key from one bag of key/value pairs, in place.
 *
 * Takes `unknown` because it is pointed at seven different places in an event whose declared types share
 * nothing, and every one of them is optional — a missing `contexts`, a missing `trace`, a missing `data`
 * and an absent `spans` all have to be a no-op rather than a throw. A `beforeSend` that throws loses the
 * event **and** the error that produced it.
 */
function scrubBag(bag: unknown): void {
	if (typeof bag !== 'object' || bag === null) return

	const record = bag as Record<string, unknown>
	for (const key of Object.keys(record)) {
		if (isRemovedKey(key)) delete record[key]
		else if (URL_VALUED_KEYS.has(key.toLowerCase())) record[key] = sanitiseUrl(record[key])
	}
}

/**
 * Deletes one named key from one bag, in place, whatever it holds.
 *
 * Separate from `REMOVED_KEYS` on purpose: the two keys removed this way — `data` on `event.request` and
 * `arguments` on a breadcrumb — are removed **because of where they sit**, not because of what they are
 * called. `data` is the SDK's name for the raw request body on `event.request` and equally the name of the
 * attribute bag on a span; `arguments` is the console argument list on a breadcrumb and could be an
 * ordinary attribute anywhere else. Putting either name in the shared list would delete every bag the
 * scrubber walks, or an unrelated attribute that happens to share the name.
 *
 * The guard is repeated rather than shared with `scrubBag` through a `bag | null` helper: `null` is both
 * the value being guarded against and the only sentinel such a helper could return, so a caller checking
 * the sentinel keeps working when the guard is deleted — the check becomes unobservable, which is a
 * permanent mutation survivor. Here, dropping either half of the condition throws on the first event with
 * a missing or null bag, and a test says so.
 */
function deleteKey(bag: unknown, key: string): void {
	if (typeof bag !== 'object' || bag === null) return

	delete (bag as Record<string, unknown>)[key]
}

/**
 * Removes every credential-bearing and network-derived value from a Sentry event, then returns it.
 *
 * Wired as `beforeSend` in each service's `src/instrument.mts` and in each frontend's
 * `src/instrument.ts`. Mutates and returns the same object, the shape the SDK expects.
 *
 * ⚠️ **`event.request` is not where the leak is.** `httpServerSpansIntegration` writes the request's
 * headers onto the **server span**, so they reach the collector as `http.request.header.*` attributes on
 * `event.contexts.trace.data`. A scrubber that walks `event.request` alone closes nothing at all, which is
 * why all seven bags below are walked and why the suite's fixture is built from a captured event's real
 * attribute shape rather than from a hand-written `event.request`.
 *
 * ⚠️ **Wire it as `beforeSendTransaction` as well as `beforeSend`.** The SDK routes transaction events to
 * the second hook only, and the four network-derived attributes above are on the transaction — measured
 * leaving the process unchanged while this function was configured (`sentry-event-capture.md` §6). One hook
 * without the other means turning on a sample rate turns off the redaction.
 *
 * ⚠️ **In a browser the leak is the URL itself**, and it is a different kind of leak from the header one:
 * nothing is added to the event by a misconfiguration, the address bar is simply copied — query string,
 * fragment and all — into `event.request.url`, `contexts.trace.data['url.full']`, eight span descriptions
 * and both `from` and `to` of every navigation breadcrumb. `dataCollection` has no option that stops it.
 * Everything from the first `?` or `#` is therefore removed from each of those, and the path is kept
 * (§9 of the capture).
 */
export function sentryBeforeSend<TEvent extends ISentryScrubbableEvent>(event: TEvent): TEvent {
	scrubBag(event.request)
	scrubBag(event.request?.headers)
	scrubBag(event.request?.env)
	scrubBag(event.user)
	scrubBag(event.contexts?.trace?.data)
	// The raw request body, whole. `@sentry/core` hard-wires `include.data = true` for events
	// (`integrations/requestdata.js:27-28`) and `dataCollection.httpBodies` gates the span attribute only,
	// so every GraphQL POST this platform serves — passwords in `variables` included — arrives here. The
	// services additionally set `httpIntegration({ maxRequestBodySize: 'none' })`, which is the real gate;
	// this deletion is the second layer, for the events that reach a hook the first layer never covered.
	deleteKey(event.request, 'data')
	// A guard rather than `event.spans ?? []`: the elements of that fallback are never read, so any
	// array at all satisfies it and the default is unobservable — untestable by construction, and a
	// permanent mutation survivor. An `if` puts the absent case back under a test that can fail.
	if (event.spans) {
		for (const span of event.spans) {
			scrubBag(span.data)
			// The description of a browser-metric span is the address bar, verbatim — `browser.request`,
			// `browser.connect`, `browser.loadEvent` and five more all carry it (§9 of the capture). It is a
			// free-text field everywhere else, so only a value that starts like a URL is touched: a
			// description of `first-contentful-paint` or `POST /public-authorization` has to survive whole,
			// and one of the capture's own attribute values — the LCP element selector — contains a `#`.
			if (looksLikeUrl(span.description)) span.description = sanitiseUrl(span.description)
		}
	}
	// Breadcrumbs carry the process's own `console` output, arguments verbatim, under `data.arguments` and
	// `message`. Console output is telemetry the moment the request errors, and part of it is caller-
	// supplied. `message` goes on every breadcrumb rather than on the console ones alone: the scrubber
	// cannot tell which breadcrumb text was built from a request, and what survives — category, level,
	// timestamp, the non-removed `data` keys — still records that the call happened, in order.
	if (event.breadcrumbs) {
		for (const breadcrumb of event.breadcrumbs) {
			delete breadcrumb.message
			scrubBag(breadcrumb.data)
			deleteKey(breadcrumb.data, 'arguments')
			// `from` and `to` on a `navigation` breadcrumb, the pair `url` in `URL_VALUED_KEYS` does not
			// name. Sanitised here and not in the shared set for the reason `arguments` is deleted here:
			// two words that mean a URL on this one breadcrumb category and mean anything at all on any
			// other bag the scrubber walks. ⚠️ This is the pair that outlives the page — a reset link's
			// credential sits in `from` on **every event of the rest of that session**, measured on both a
			// later error and a later transaction (§9).
			sanitiseKey(breadcrumb.data, 'from')
			sanitiseKey(breadcrumb.data, 'to')
		}
	}

	return event
}
