import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

/*
 * E13-S05 — the assertion that keeps the Redis TLS position honest.
 *
 * Redis carries session material: the hash holds `_id`, `email` and `tier`, and every request reads one.
 * The transport is plaintext, and **not because anyone chose it here** — koa-utils builds its cluster
 * client with a `redis://` scheme written into the source, and every service `env` on this platform
 * selects that branch with `REDIS_IS_CLUSTER=1`. There is no configuration in this workspace that
 * changes it (R45).
 *
 * ⚠️ **This test is not asserting that plaintext is correct — it is asserting that it is still forced.**
 * A recorded "we cannot fix this" turns into a lie the moment the blocker disappears, and a published
 * package can drop the blocker in a patch release nobody here reads. When that happens this test fails,
 * with the migration note below, and the position is revisited rather than left true by inertia.
 *
 * It reads the installed file rather than importing the module: importing it constructs a client and
 * tries to reach a server, and the claim being checked is about the *source*, not about a connection.
 */

const MIGRATION =
	'E13-S05: @axiumine/koa-utils no longer hardcodes `redis://` in its cluster client. Encrypting the Redis leg may now be possible from configuration alone — re-read `dist/dataSources/Redis.mjs`, then update R45 in `docs/devprotocol/phase5/RISK_REGISTER.md` and the auth-model section of `docs/architecture.md`.'

const redisSource = async () =>
	readFile(new URL('../node_modules/@axiumine/koa-utils/dist/dataSources/Redis.mjs', import.meta.url), 'utf8')

describe('the Redis connection scheme koa-utils actually builds', () => {
	// The cluster branch, which is the one production runs. Three rootNodes, three hardcoded schemes.
	it('still hardcodes plaintext redis:// in the cluster rootNodes', async () => {
		const source = await redisSource()

		expect(source.match(/url: `redis:\/\/\$\{process\.env\.REDIS_DB[123]_HOST}/g), MIGRATION).toHaveLength(3)
	})

	// ⚠️ Separate from the case above on purpose. `rediss://` appearing *anywhere* in that file — even in
	// a branch this platform does not take — means the package has an opinion about TLS now, and the two
	// ways out recorded in R45 have to be re-costed before the next audit rediscovers this.
	it('offers no rediss:// anywhere, so TLS is not merely unconfigured', async () => {
		expect(await redisSource(), MIGRATION).not.toContain('rediss://')
	})

	/*
	 * The single-node branch takes its whole URL from `REDIS_URL` and would accept `rediss://` today — so
	 * "koa-utils cannot do TLS" would be the wrong sentence to write down, and this case is what stops
	 * anyone writing it. What is true is narrower: the branch this platform runs cannot, and switching
	 * branches is not a workaround, it is a different deployment.
	 */
	it('leaves the single-node branch taking its scheme from REDIS_URL', async () => {
		expect(await redisSource()).toContain('createClient({ url: process.env.REDIS_URL })')
	})
})
