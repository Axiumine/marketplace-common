import { describe, expect, it } from 'vitest'

import { ISentryScrubbableEvent, sentryBeforeSend } from '../src/others/sentryBeforeSend.mts'

/*
 * The scrubber wired as `beforeSend` **and** `beforeSendTransaction` in all nine services.
 *
 * ⚠️ The transaction fixture below is not hand-written. `contexts.trace.data` holds the twenty-eight
 * attribute names a real transaction carried into a local collector, in the order they were captured —
 * `docs/report/sentry-event-capture.md` §6 — with the four measured values transcribed and the rest given
 * plausible ones. E12-S02's original fixture guessed that shape and guessed two things wrong: the
 * network-derived keys live in `contexts.trace.data` **only**, child spans carry none of them, and on an
 * error event under the shipped configuration all three attribute bags are empty. A suite written against
 * the guess passed while `http.user_agent`, `net.peer.ip` and `net.host.ip` shipped unredacted.
 *
 * The error-event fixture stays: it models the shape that ships today, and the capture confirms it.
 */

const TOKEN = '9f2c1b7e-4a55-4d0e-9a3f-7c8de1b04a21'
/** The first `x-forwarded-for` hop, which is what `http.client_ip` was measured holding. */
const IP = '198.51.100.42'
/** The socket peer and this process's own address — nginx and the service in production. */
const LOCAL_IP = '::ffff:127.0.0.1'
const AGENT = 'itest-agent/1.0'
const PASSWORD = 'sentinel-Pa55w0rd!'

/** A GraphQL `login` envelope, the shape §5 of the capture found on `event.request.data`. */
const BODY = `{"query":"mutation{ login(email:\\"probe@example.invalid\\", password:\\"${PASSWORD}\\"){ txt } }","variables":{"password":"${PASSWORD}"}}`

/**
 * The twenty-eight root-span attributes of the captured transaction, verbatim in name and order.
 * Rebuilt per test — the scrubber mutates its argument.
 */
function capturedTraceData(): Record<string, unknown> {
	return {
		'sentry.origin': 'auto.http.otel.http',
		'sentry.op': 'http.server',
		'sentry.source': 'route',
		'sentry.sample_rate': 1,
		'url.full': 'https://api.example/public-authorization',
		'url.path': '/public-authorization',
		'http.url': 'https://api.example/public-authorization',
		'http.method': 'POST',
		'http.target': '/public-authorization',
		'http.host': 'api.example',
		'net.host.name': 'api.example',
		'http.client_ip': IP,
		'http.user_agent': AGENT,
		'http.scheme': 'https',
		'http.flavor': '1.1',
		'net.transport': 'ip_tcp',
		'http.request_content_length_uncompressed': 118,
		'otel.kind': 'SERVER',
		url: 'https://api.example/public-authorization',
		'sentry.graphql.operation': 'mutation login',
		'original-description': 'POST /public-authorization',
		'http.response.status_code': 200,
		'http.status_code': 200,
		'http.status_text': 'OK',
		'net.host.ip': LOCAL_IP,
		'net.host.port': 4028,
		'net.peer.ip': LOCAL_IP,
		'net.peer.port': 51234
	}
}

/** The four names the capture proved leave the process unchanged when no hook removes them. */
const CAPTURED_LEAKS = ['http.client_ip', 'http.user_agent', 'net.peer.ip', 'net.host.ip']

/**
 * A transaction event as the SDK really builds one: every attribute on the root span, the raw body on
 * `event.request`, and child spans carrying only what `graphQL: { document: true }` intends.
 */
function makeTransactionEvent(): ISentryScrubbableEvent {
	return {
		contexts: {
			trace: {
				span_id: 'a1b2c3d4e5f60718',
				trace_id: '0123456789abcdef0123456789abcdef',
				op: 'http.server',
				data: capturedTraceData()
			}
		} as ISentryScrubbableEvent['contexts'],
		spans: [
			{ data: { 'sentry.op': 'graphql.parse', 'graphql.source': 'mutation{ login(email: $email) }' } },
			{ data: { 'sentry.op': 'graphql.execute', 'graphql.operation.type': 'mutation' } }
		],
		request: {
			url: 'https://api.example/public-authorization',
			method: 'POST',
			data: BODY,
			headers: { 'content-type': 'application/json', 'user-agent': AGENT, 'x-real-ip': IP }
		} as ISentryScrubbableEvent['request']
	}
}

/**
 * An error event under the shipped configuration: the attribute bags are empty — `httpHeaders.request` is
 * `false`, which the capture confirms — and everything that carries data is on `request`, `user` and
 * `breadcrumbs`.
 */
function makeErrorEvent(): ISentryScrubbableEvent {
	return {
		contexts: { trace: { span_id: 'a1b2c3d4e5f60718', op: 'http.server', data: {} } } as ISentryScrubbableEvent['contexts'],
		request: {
			url: 'https://api.example/public-authorization',
			method: 'POST',
			data: BODY,
			headers: {
				authorization: `Bearer ${TOKEN}`,
				cookie: `refresh_token=${TOKEN}`,
				'x-real-ip': IP,
				'user-agent': AGENT,
				'content-type': 'application/json'
			},
			cookies: { refresh_token: TOKEN },
			env: { REMOTE_ADDR: IP, SERVER_NAME: 'api.example' }
		} as ISentryScrubbableEvent['request'],
		user: { id: '68b1f4c2a1d3e40012345678', ip_address: IP },
		breadcrumbs: [
			{
				timestamp: 1754870000,
				category: 'console',
				level: 'log',
				message: `catch ${PASSWORD}`,
				data: { arguments: ['catch', PASSWORD], logger: 'console' }
			},
			{
				timestamp: 1754870001,
				category: 'http',
				level: 'info',
				data: { method: 'POST', status_code: 200, 'user-agent': AGENT }
			}
		] as ISentryScrubbableEvent['breadcrumbs']
	}
}

/** The three bags the SDK writes span attributes into, read back after a scrub. */
function attributeBags(event: ISentryScrubbableEvent): Array<Record<string, unknown>> {
	return [
		(event.contexts?.trace?.data ?? {}) as Record<string, unknown>,
		...(event.spans ?? []).map((span) => (span.data ?? {}) as Record<string, unknown>)
	]
}

/** The breadcrumbs of a scrubbed event, as bags. */
function crumbs(event: ISentryScrubbableEvent): Array<Record<string, unknown>> {
	return (event.breadcrumbs ?? []).map((breadcrumb) => breadcrumb as Record<string, unknown>)
}

describe('sentryBeforeSend — the whole-event guarantee', () => {
	// One assertion per sentinel and per event type: `not.toContain` on a serialised event is the only
	// check that fails when a future SDK adds a bag nobody here thought to walk.
	it.each([
		['the credential', TOKEN],
		['the client address', IP],
		['the password from the request body', PASSWORD],
		['the user agent', AGENT]
	])('leaves no trace of %s anywhere in a serialised error event', (_name, sentinel) => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(JSON.stringify(event)).not.toContain(sentinel)
	})

	it.each([
		['the client address', IP],
		['the socket address', LOCAL_IP],
		['the password from the request body', PASSWORD],
		['the user agent', AGENT]
	])('leaves no trace of %s anywhere in a serialised transaction event', (_name, sentinel) => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(JSON.stringify(event)).not.toContain(sentinel)
	})

	it('returns the very object it was handed, as the SDK expects of beforeSend', () => {
		const event = makeErrorEvent()

		expect(sentryBeforeSend(event)).toBe(event)
	})
})

describe('sentryBeforeSend — the captured transaction', () => {
	// The four keys are asserted by name as well as by the serialised check above: a value that changes
	// shape (an address arriving as a number, a header list) would slip past `not.toContain` and not past
	// this.
	it.each(CAPTURED_LEAKS)('removes %s, which the capture measured leaving the process', (key) => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).not.toHaveProperty(key)
	})

	it('keeps the twenty-four attributes that carry no address, agent or credential', () => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(Object.keys(event.contexts?.trace?.data as object)).toStrictEqual(
			Object.keys(capturedTraceData()).filter((key) => !CAPTURED_LEAKS.includes(key))
		)
	})

	it('keeps the values of the attributes it keeps, rather than emptying them', () => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toMatchObject({
			'http.method': 'POST',
			'url.path': '/public-authorization',
			'sentry.op': 'http.server',
			'net.peer.port': 51234
		})
	})

	it('leaves the child spans alone — they carry the GraphQL document and nothing network-derived', () => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(attributeBags(event).slice(1)).toStrictEqual([
			{ 'sentry.op': 'graphql.parse', 'graphql.source': 'mutation{ login(email: $email) }' },
			{ 'sentry.op': 'graphql.execute', 'graphql.operation.type': 'mutation' }
		])
	})

	it('walks all three bags — the trace context and both spans', () => {
		const event = makeTransactionEvent()

		sentryBeforeSend(event)

		expect(attributeBags(event)).toHaveLength(3)
	})

	it('strips a removed attribute from a span too, if one ever appears on one', () => {
		const event: ISentryScrubbableEvent = { spans: [{ data: { 'http.client_ip': IP, keep: 'kept' } }] }

		sentryBeforeSend(event)

		expect(event.spans?.[0]?.data).toStrictEqual({ keep: 'kept' })
	})
})

describe('sentryBeforeSend — the request body', () => {
	// 🔴 E12-S21. `dataCollection.httpBodies: []` gates the span attribute only; `include.data` is
	// hard-wired `true` for events, so the whole GraphQL envelope arrives on `event.request.data`.
	it.each([
		['an error event', makeErrorEvent],
		['a transaction event', makeTransactionEvent]
	])('deletes the raw body from %s', (_name, make) => {
		const event = make()

		sentryBeforeSend(event)

		expect(event.request).not.toHaveProperty('data')
	})

	it('deletes the body whatever it holds — the key is removed for where it sits, not for its value', () => {
		const event: ISentryScrubbableEvent = { request: { data: { variables: { password: PASSWORD } } } }

		sentryBeforeSend(event)

		expect(event.request).toStrictEqual({})
	})

	it('does not delete an attribute called `data` anywhere else', () => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { data: 'kept' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ data: 'kept' })
	})
})

describe('sentryBeforeSend — breadcrumbs', () => {
	it('drops the console arguments, which carry whatever the service printed', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(crumbs(event)[0]?.data).toStrictEqual({ logger: 'console' })
	})

	it('drops every breadcrumb message, console or not', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		for (const breadcrumb of crumbs(event)) expect(breadcrumb).not.toHaveProperty('message')
	})

	it('keeps category, level and timestamp, so the trail still records that the call happened', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(crumbs(event)[0]).toStrictEqual({
			timestamp: 1754870000,
			category: 'console',
			level: 'log',
			data: { logger: 'console' }
		})
	})

	it('applies the removal list inside a breadcrumb data bag as well', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(crumbs(event)[1]?.data).toStrictEqual({ method: 'POST', status_code: 200 })
	})

	it('walks every breadcrumb, not only the first', () => {
		const event: ISentryScrubbableEvent = {
			breadcrumbs: [{ data: { arguments: ['first'] } }, { data: { arguments: ['second'] } }]
		}

		sentryBeforeSend(event)

		expect(event.breadcrumbs?.map((breadcrumb) => breadcrumb.data)).toStrictEqual([{}, {}])
	})

	it('does not delete an attribute called `arguments` outside a breadcrumb', () => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { arguments: 'kept' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ arguments: 'kept' })
	})
})

describe('sentryBeforeSend — the removal list, one key at a time', () => {
	// Written out as literals rather than read back from the module: a test that imports the list it is
	// meant to pin kills no mutant in it.
	const REMOVED = [
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
		'keygrip_kek',
		'http.request.header.authorization',
		'http.request.header.anything-added-later',
		'http.response.header.set_cookie',
		'http.response.header.anything-added-later'
	]

	it.each(REMOVED)('removes %s', (key) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: TOKEN, keep: 'kept' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ keep: 'kept' })
	})

	// Header attribute names arrive lower-cased today. The guarantee must not depend on that.
	it.each(['Authorization', 'X-Forwarded-For', 'HTTP.REQUEST.HEADER.AUTHORIZATION', 'Http.Client_Ip', 'User-Agent'])(
		'removes %s regardless of case',
		(key) => {
			const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: TOKEN, keep: 'kept' } } } }

			sentryBeforeSend(event)

			expect(event.contexts?.trace?.data).toStrictEqual({ keep: 'kept' })
		}
	)

	it.each(['http.method', 'url.path', 'sentry.op', 'net.peer.port', 'http.route', 'server.address'])('keeps %s', (key) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: 'kept' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ [key]: 'kept' })
	})
})

describe('sentryBeforeSend — request and user', () => {
	it('strips the credential, address and agent headers and keeps the rest', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(event.request?.headers).toStrictEqual({ 'content-type': 'application/json' })
	})

	it('drops the parsed cookie bag hanging off request itself', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(Object.keys(event.request as object)).toStrictEqual(['url', 'method', 'headers', 'env'])
	})

	it('drops REMOTE_ADDR from the request environment and keeps the rest', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(event.request?.env).toStrictEqual({ SERVER_NAME: 'api.example' })
	})

	it('drops the user address and keeps the account id', () => {
		const event = makeErrorEvent()

		sentryBeforeSend(event)

		expect(event.user).toStrictEqual({ id: '68b1f4c2a1d3e40012345678' })
	})
})

describe('sentryBeforeSend — events missing the parts it walks', () => {
	// A beforeSend that throws loses the event AND the error that produced it, so every optional step is
	// its own case rather than one "empty event" test that could pass on the first early return.
	it('survives an event with nothing on it at all', () => {
		const event: ISentryScrubbableEvent = {}

		expect(sentryBeforeSend(event)).toStrictEqual({})
	})

	it('survives a missing contexts', () => {
		const event: ISentryScrubbableEvent = { spans: [], request: { headers: {} } }

		expect(sentryBeforeSend(event)).toStrictEqual({ spans: [], request: { headers: {} } })
	})

	it('survives a contexts with no trace', () => {
		const event: ISentryScrubbableEvent = { contexts: {} }

		expect(sentryBeforeSend(event)).toStrictEqual({ contexts: {} })
	})

	it('survives a trace with no data', () => {
		const event: ISentryScrubbableEvent = { contexts: { trace: {} } }

		expect(sentryBeforeSend(event)).toStrictEqual({ contexts: { trace: {} } })
	})

	it('survives an absent spans array', () => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { authorization: TOKEN } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({})
	})

	it('survives an empty spans array', () => {
		const event: ISentryScrubbableEvent = { spans: [] }

		expect(sentryBeforeSend(event)).toStrictEqual({ spans: [] })
	})

	it('survives a span with no data', () => {
		const event: ISentryScrubbableEvent = { spans: [{}] }

		expect(sentryBeforeSend(event)).toStrictEqual({ spans: [{}] })
	})

	it('survives an absent breadcrumbs array', () => {
		const event: ISentryScrubbableEvent = { request: { data: BODY } }

		expect(sentryBeforeSend(event)).toStrictEqual({ request: {} })
	})

	it('survives an empty breadcrumbs array', () => {
		const event: ISentryScrubbableEvent = { breadcrumbs: [] }

		expect(sentryBeforeSend(event)).toStrictEqual({ breadcrumbs: [] })
	})

	it('survives a breadcrumb with neither message nor data', () => {
		const event: ISentryScrubbableEvent = { breadcrumbs: [{}] }

		expect(sentryBeforeSend(event)).toStrictEqual({ breadcrumbs: [{}] })
	})

	it('survives a request with neither headers nor env', () => {
		const event: ISentryScrubbableEvent = { request: {} }

		expect(sentryBeforeSend(event)).toStrictEqual({ request: {} })
	})

	// `null` is not in the declared shape, but a null `data` reaching a scrubber that only checked
	// `typeof bag !== 'object'` would throw on Object.keys — the one case that early return exists for.
	it('survives a null in place of a bag', () => {
		const event = { contexts: { trace: { data: null } } } as unknown as ISentryScrubbableEvent

		expect(sentryBeforeSend(event)).toStrictEqual({ contexts: { trace: { data: null } } })
	})

	it('survives a null in place of the request, which the body deletion also reaches into', () => {
		const event = { request: null } as unknown as ISentryScrubbableEvent

		expect(sentryBeforeSend(event)).toStrictEqual({ request: null })
	})

	it('survives a null in place of a breadcrumb data bag', () => {
		const event = { breadcrumbs: [{ data: null }] } as unknown as ISentryScrubbableEvent

		expect(sentryBeforeSend(event)).toStrictEqual({ breadcrumbs: [{ data: null }] })
	})
})

/*
 * 🔴 E12-S24. The second capture, from a browser: `docs/report/sentry-event-capture.md` §9.
 *
 * ⚠️ The two fixtures below are transcribed from real envelopes a production build of `marketplace-user`
 * sent through the real `@sentry/react` transport into a local collector, trimmed to the bags this
 * scrubber walks. The values are the probe's, verbatim — a query string, a fragment carrying an address
 * and a one-time hash, a `Referer`, a navigation breadcrumb and a span description that is the address bar
 * repeated.
 *
 * What makes it worth a fixture of its own: the browser leak is not a header the configuration forgot,
 * it is `location.href` copied into six places by design, and `dataCollection` has no option that stops
 * any of them.
 */
const RESET_LINK = '/reset-password/confirm?token=E12S24QUERYPROBE#/probe%40example.invalid/MKTS24HASHPROBE'
const RESET_ORIGIN_LINK = `https://marketplace-domain.com${RESET_LINK}`
/** The one-time hash out of the fragment, and the address next to it. */
const RESET_HASH = 'MKTS24HASHPROBE'
const RESET_ADDRESS = 'probe%40example.invalid'
const RESET_QUERY = 'E12S24QUERYPROBE'

/** An error thrown one navigation after the reset link was opened — the case that outlives the page. */
function makeBrowserErrorEvent(): ISentryScrubbableEvent {
	return {
		contexts: { trace: { data: {} } } as ISentryScrubbableEvent['contexts'],
		request: {
			url: 'https://marketplace-domain.com/account/addresses?nav=E12S24QUERYPROBE#navfragmentprobe',
			headers: { 'User-Agent': AGENT, Referer: RESET_ORIGIN_LINK }
		} as ISentryScrubbableEvent['request'],
		breadcrumbs: [
			{
				timestamp: 1786475440,
				category: 'navigation',
				data: { from: RESET_LINK, to: '/account/addresses?nav=E12S24QUERYPROBE#navfragmentprobe' }
			},
			{
				timestamp: 1786475441,
				category: 'fetch',
				level: 'warning',
				data: { method: 'POST', url: '/graphql-user-authorization?probeQuery=E12S24QUERYPROBE', status_code: 404 }
			}
		] as ISentryScrubbableEvent['breadcrumbs']
	}
}

/** The pageload transaction of the reset page itself, `tracesSampleRate` raised to 1 for the capture. */
function makeBrowserTransactionEvent(): ISentryScrubbableEvent {
	return {
		contexts: {
			trace: {
				data: {
					'sentry.origin': 'auto.pageload.browser',
					'sentry.op': 'pageload',
					'url.path': '/reset-password/confirm',
					'url.full': RESET_ORIGIN_LINK,
					effectiveConnectionType: '4g',
					// A CSS selector, and the reason a span description is only sanitised when it starts like
					// a URL: this value carries a `#` and must survive whole.
					'lcp.element': 'div.flex.flex-col.gap-1 > p#password-hint.text-xs.text-tip'
				}
			}
		} as ISentryScrubbableEvent['contexts'],
		spans: [
			{ description: RESET_ORIGIN_LINK, data: { 'sentry.op': 'browser.request' } },
			{
				description: '/assets/index-BkSihIHM.js',
				data: { 'sentry.op': 'resource.other', 'url.full': 'https://marketplace-domain.com/assets/index-BkSihIHM.js' }
			},
			{ description: 'first-contentful-paint', data: { 'sentry.op': 'paint' } }
		],
		request: { url: RESET_ORIGIN_LINK, headers: { 'User-Agent': AGENT } } as ISentryScrubbableEvent['request']
	}
}

describe('sentryBeforeSend — the captured browser event', () => {
	it.each([
		['the one-time hash', RESET_HASH],
		['the address it was mailed to', RESET_ADDRESS],
		['the query string', RESET_QUERY],
		['the user agent', AGENT]
	])('leaves no trace of %s anywhere in a serialised browser error event', (_name, sentinel) => {
		const event = makeBrowserErrorEvent()

		sentryBeforeSend(event)

		expect(JSON.stringify(event)).not.toContain(sentinel)
	})

	it.each([
		['the one-time hash', RESET_HASH],
		['the address it was mailed to', RESET_ADDRESS],
		['the query string', RESET_QUERY],
		['the user agent', AGENT]
	])('leaves no trace of %s anywhere in a serialised browser transaction', (_name, sentinel) => {
		const event = makeBrowserTransactionEvent()

		sentryBeforeSend(event)

		expect(JSON.stringify(event)).not.toContain(sentinel)
	})

	// Truncated, not deleted: which page the customer was on is the context that makes the event readable,
	// and the credential is never in the path.
	it('keeps the path of the page the error happened on', () => {
		const event = makeBrowserErrorEvent()

		sentryBeforeSend(event)

		expect(event.request?.url).toBe('https://marketplace-domain.com/account/addresses')
	})

	it('keeps the reset path on the transaction, on both the request and the trace attribute', () => {
		const event = makeBrowserTransactionEvent()

		sentryBeforeSend(event)

		expect(event.request?.url).toBe('https://marketplace-domain.com/reset-password/confirm')
		expect(event.contexts?.trace?.data).toMatchObject({ 'url.full': 'https://marketplace-domain.com/reset-password/confirm' })
	})

	// `url.path` never held either part, so nothing should happen to it — the assertion is here because a
	// scrubber that sanitised every key starting with `url` would pass every other test in this block.
	it('leaves url.path exactly as it was', () => {
		const event = makeBrowserTransactionEvent()

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toMatchObject({ 'url.path': '/reset-password/confirm' })
	})

	it('leaves the LCP element selector alone, `#` and all', () => {
		const event = makeBrowserTransactionEvent()

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toMatchObject({
			'lcp.element': 'div.flex.flex-col.gap-1 > p#password-hint.text-xs.text-tip'
		})
	})

	it('sanitises a span description that is the address bar, and leaves the other two spans readable', () => {
		const event = makeBrowserTransactionEvent()

		sentryBeforeSend(event)

		expect(event.spans?.map((span) => span.description)).toStrictEqual([
			'https://marketplace-domain.com/reset-password/confirm',
			'/assets/index-BkSihIHM.js',
			'first-contentful-paint'
		])
	})

	// ⚠️ The pair that outlives the page: `from` still holds the reset link on every event of the rest of
	// the session, long after the customer has left it.
	it('sanitises both halves of a navigation breadcrumb', () => {
		const event = makeBrowserErrorEvent()

		sentryBeforeSend(event)

		expect(crumbs(event)[0]?.data).toStrictEqual({ from: '/reset-password/confirm', to: '/account/addresses' })
	})

	it('sanitises the url of a fetch breadcrumb and keeps what the call did', () => {
		const event = makeBrowserErrorEvent()

		sentryBeforeSend(event)

		expect(crumbs(event)[1]?.data).toStrictEqual({ method: 'POST', url: '/graphql-user-authorization', status_code: 404 })
	})

	// `Referer` and `User-Agent` are written by the same unconditional `httpContextIntegration` call, so
	// one assertion covers the two halves of that finding: the agent goes, the previous URL is truncated.
	it('drops the agent header and truncates the referer', () => {
		const event = makeBrowserErrorEvent()

		sentryBeforeSend(event)

		expect(event.request?.headers).toStrictEqual({ Referer: 'https://marketplace-domain.com/reset-password/confirm' })
	})
})

describe('sentryBeforeSend — what a URL-valued attribute keeps', () => {
	it.each([
		['a fragment', 'https://marketplace-domain.com/a#/b/c', 'https://marketplace-domain.com/a'],
		['a query string', 'https://marketplace-domain.com/a?b=c', 'https://marketplace-domain.com/a'],
		['both, fragment first', 'https://marketplace-domain.com/a#b?c', 'https://marketplace-domain.com/a'],
		['neither', 'https://marketplace-domain.com/a', 'https://marketplace-domain.com/a'],
		['a root-relative path with a query', '/a/b?c=d', '/a/b'],
		['a bare origin', 'https://marketplace-domain.com', 'https://marketplace-domain.com']
	])('cuts %s', (_name, url, expected) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { 'url.full': url } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ 'url.full': expected })
	})

	it.each(['url', 'url.full', 'http.url', 'http.target', 'referer', 'referrer', 'Referer', 'URL.FULL'])(
		'sanitises %s, whatever its case',
		(key) => {
			const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: '/a?b=c' } } } }

			sentryBeforeSend(event)

			expect(event.contexts?.trace?.data).toStrictEqual({ [key]: '/a' })
		}
	)

	// The key list is the whole rule. An attribute that merely holds something question-mark-shaped is not
	// a URL, and a scrubber that guessed from the value would truncate a GraphQL document at its first `#`.
	it.each(['graphql.source', 'sentry.op', 'lcp.element'])('does not touch %s', (key) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: '/a?b=c#d' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ [key]: '/a?b=c#d' })
	})

	// A URL attribute has been a string in every capture taken. If one ever is not, the scrubber has to
	// hand it back untouched rather than throw — a beforeSend that throws loses the event under it.
	it.each([[42], [null], [{ href: '/a?b=c' }], [['/a?b=c']]])('passes a non-string url value through: %s', (value) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { url: value } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ url: value })
	})
})

describe('sentryBeforeSend — a span description, which is free text everywhere else', () => {
	it.each([
		['an absolute http URL', 'http://marketplace-domain.com/a?b=c', 'http://marketplace-domain.com/a'],
		['an absolute https URL', 'https://marketplace-domain.com/a#b', 'https://marketplace-domain.com/a'],
		['a root-relative path', '/assets/index.js?import', '/assets/index.js']
	])('cuts %s', (_name, description, expected) => {
		const event: ISentryScrubbableEvent = { spans: [{ description }] }

		sentryBeforeSend(event)

		expect(event.spans?.[0]?.description).toBe(expected)
	})

	it.each(['first-contentful-paint', 'POST /public-authorization?b=c', 'div.flex > p#password-hint', 'httpd-metrics#7'])(
		'leaves %s whole',
		(description) => {
			const event: ISentryScrubbableEvent = { spans: [{ description }] }

			sentryBeforeSend(event)

			expect(event.spans?.[0]?.description).toBe(description)
		}
	)

	// Not `undefined`, and not an added key: a span with no description must come back with none.
	it('adds no description to a span that had none', () => {
		const event: ISentryScrubbableEvent = { spans: [{ data: { 'sentry.op': 'paint' } }] }

		sentryBeforeSend(event)

		expect(event.spans?.[0]).toStrictEqual({ data: { 'sentry.op': 'paint' } })
	})

	it('leaves a non-string description alone', () => {
		const event = { spans: [{ description: 7 }] } as unknown as ISentryScrubbableEvent

		sentryBeforeSend(event)

		expect(event.spans?.[0]?.description).toBe(7)
	})
})

describe('sentryBeforeSend — the two breadcrumb URL names it does not share', () => {
	// `from` and `to` mean a URL on a navigation breadcrumb and mean anything at all elsewhere, which is why
	// they are sanitised there and only there.
	it.each(['from', 'to'])('does not touch %s outside a breadcrumb', (key) => {
		const event: ISentryScrubbableEvent = { contexts: { trace: { data: { [key]: '/a?b=c' } } } }

		sentryBeforeSend(event)

		expect(event.contexts?.trace?.data).toStrictEqual({ [key]: '/a?b=c' })
	})

	// ⚠️ An assignment through an absent name creates it. Without the string check, every breadcrumb of
	// every event would gain `from: undefined` and `to: undefined` — a serialised null apiece, forever.
	it('adds neither name to a breadcrumb that carries neither', () => {
		const event: ISentryScrubbableEvent = { breadcrumbs: [{ data: { method: 'POST' } }] }

		sentryBeforeSend(event)

		expect(event.breadcrumbs?.[0]?.data).toStrictEqual({ method: 'POST' })
	})

	it.each([[42], [null]])('leaves a non-string breadcrumb from alone: %s', (value) => {
		const event: ISentryScrubbableEvent = { breadcrumbs: [{ data: { from: value } }] }

		sentryBeforeSend(event)

		expect(event.breadcrumbs?.[0]?.data).toStrictEqual({ from: value })
	})
})
