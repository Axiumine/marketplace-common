import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

/*
 * E13-S05 — the assertion that keeps the Redis TLS position honest.
 *
 * Redis carries session material: the hash holds `_id`, `email` and `tier`, and every request reads one.
 *
 * ⚠️ **This file changed direction on 2026-08-28, because the tripwire it used to be fired.** Until
 * `@axiumine/koa-utils@7.0.0` the cluster client was built with a `redis://` scheme written into the
 * source, every service `env` selected that branch with `REDIS_IS_CLUSTER=1`, and no configuration in
 * this workspace could change it — so the three cases here asserted that the blocker was *still* there,
 * on the reasoning that a recorded "we cannot fix this" turns into a lie the moment it disappears.
 * `7.1.0` removed it: the cluster rootNodes now take their scheme from `redisNodeUrl()`, the single-node
 * URL passes through `resolveRedisUrl()`, and both read the `REDIS_TLS` flag.
 *
 * **What is asserted now is the shape of that capability, not the absence of it.** R45 stays open and the
 * reason moved: the leg is plaintext here because nothing in this workspace sets `REDIS_TLS=true` and the
 * dev Redis serves no TLS — a deployment decision — rather than because an external package forbids it.
 * The three facts below are what the risk row, `docs/architecture.md` and `ADR-039` now say out loud, so
 * a release that quietly reverts any of them must fail here rather than leave three documents wrong.
 *
 * It reads the installed files rather than importing them: `dataSources/Redis.mts` constructs a client at
 * module load and tries to reach a server, and the claim being checked is about the *source*, not about a
 * connection. The two helpers are pure, but they live under `dist/private/` and the package's `exports`
 * map does not publish that subpath, so reading is also the only way in.
 */

const MIGRATION =
	'E13-S05: the Redis TLS surface of @axiumine/koa-utils changed shape again. Re-read `dist/dataSources/Redis.mjs` and `dist/private/dataSources/`, then update R45 in `docs/devprotocol/phase5/RISK_REGISTER.md`, the auth-model section of `docs/architecture.md` and ADR-039 §Context before touching this test.'

const installed = async (path: string) =>
	readFile(new URL(`../node_modules/@axiumine/koa-utils/dist/${path}`, import.meta.url), 'utf8')

describe('the Redis connection scheme koa-utils actually builds', () => {
	/*
	 * The cluster branch, which is the one every service `env` selects. Three rootNodes, and since 7.1.0
	 * not one hardcoded scheme among them — this is the assertion whose previous form failed and forced
	 * the revisit.
	 */
	it('builds the cluster rootNodes through redisNodeUrl instead of a hardcoded scheme', async () => {
		const source = await installed('dataSources/Redis.mjs')

		expect(
			source.match(/url: redisNodeUrl\(process\.env\.REDIS_DB[123]_HOST, process\.env\.REDIS_DB[123]_PORT\)/g),
			MIGRATION
		).toHaveLength(3)
		expect(source, MIGRATION).not.toMatch(/url: `redis:\/\//)
	})

	/*
	 * ⚠️ Separate from the case above, and the reason is the whole of why TLS on a cluster is not one
	 * decision. `rootNodes` only carries topology discovery; node-redis opens its own connections to the
	 * nodes it discovers and does not inherit the rootNodes' TLS setting for them. Without `defaults`
	 * the `rediss://` scheme would be a no-op on every connection that actually serves a request.
	 */
	it('carries the flag into defaults.socket, so the discovered nodes are not left plaintext', async () => {
		expect(await installed('dataSources/Redis.mjs'), MIGRATION).toMatch(
			/socket: isRedisTlsRequired\(\) \? \{ tls: true } : \{ tls: false }/
		)
	})

	/*
	 * The single-node branch always took its whole URL from `REDIS_URL` and would have accepted
	 * `rediss://` at any point. What 7.1.0 added is the refusal: with the flag on, a plaintext URL throws
	 * at module load rather than connecting. Asserted here because "koa-utils can do TLS now" is too
	 * coarse a sentence to hang a risk row on — the two branches gained different things.
	 */
	it('routes the single-node URL through resolveRedisUrl rather than reading REDIS_URL raw', async () => {
		const source = await installed('dataSources/Redis.mjs')

		expect(source, MIGRATION).toContain('createClient({ url: resolveRedisUrl(process.env.REDIS_URL) })')
		expect(source, MIGRATION).not.toContain('createClient({ url: process.env.REDIS_URL })')
	})
})

describe('the flag that decides the scheme', () => {
	/*
	 * `docs/architecture.md` and R45 both state the accepted spelling. The match being exact is what makes
	 * `REDIS_TLS=TRUE` a silent plaintext connection, which is a documented trade-off rather than a bug —
	 * if this ever widens to a truthiness test, every deployment that wrote `false` gets TLS it never
	 * asked for, and both documents are wrong in the more dangerous direction.
	 */
	it('is off unless REDIS_TLS is exactly the string true', async () => {
		expect(await installed('private/dataSources/isRedisTlsRequired.mjs'), MIGRATION).toMatch(
			/process\.env\.REDIS_TLS === 'true'/
		)
	})

	it('picks rediss:// for a cluster node only when that flag is on', async () => {
		expect(await installed('private/dataSources/redisNodeUrl.mjs'), MIGRATION).toMatch(
			/isRedisTlsRequired\(\) \? 'rediss' : 'redis'/
		)
	})

	/*
	 * Fail-closed, and the distinction matters to what R45 can claim: a package that silently rewrote
	 * `redis://` to `rediss://` under an operator who wrote the former would hide the misconfiguration
	 * until a handshake failed against a host that may not be the intended one. Refusing at load is what
	 * lets the risk row say the flag either encrypts the leg or stops the boot, with no third outcome.
	 */
	it('refuses a plaintext REDIS_URL when TLS is required instead of upgrading it', async () => {
		const source = await installed('private/dataSources/resolveRedisUrl.mjs')

		expect(source, MIGRATION).toMatch(/protocol !== 'rediss:'/)
		expect(source, MIGRATION).toMatch(/REDIS_TLS is enabled but REDIS_URL uses scheme/)
	})
})
