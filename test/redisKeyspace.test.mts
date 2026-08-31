import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HASH_FIELD_TTL_PROBE_KEY } from '../src/others/assertHashFieldTTLSupport.mts'
import { assertUnderRateLimit, IRateLimitStore } from '../src/others/assertUnderRateLimit.mts'
import {
	familyKey,
	graceHitsKey,
	keygripChannel,
	keygripHoldersKey,
	keygripKey,
	reuseEventsKey,
	sessionIndexKey,
	sessionKey,
	sessionKeyFromIndexField,
	tombstoneKey
} from '../src/others/sessionKeys.mts'
import { Tier } from '../src/others/Tier.mts'

/*
 * The Redis keyspace, enumerated once and asserted from two directions.
 *
 * Three mechanical checks meet here, because all three are questions about the same list: *no raw token as
 * a Redis key*, *no network-derived value in a bucket key* and *no undocumented key shape* (BCON-03). Each
 * of them was answered by reading the source, once, by hand — which is how the audit that found them was
 * run and exactly what this registry exists to stop repeating.
 *
 * The registry below is the list. It is duplicated, on purpose, from the table in
 * `docs/data-model.md` §Key shapes — the docs live in the parent workspace and no test on this platform
 * can read across a repo boundary (`docs/testing.md`, *Traps that make a green run lie*), so the
 * enforcement this file can offer is narrower and blunter than "the table is right": **a key shape that
 * is not in this registry fails the suite**, and the developer who adds it here is standing one comment
 * away from the sentence telling them to add the row.
 *
 * ⚠️ **The count assertion is the load-bearing one.** Naming ten builders proves nothing about an
 * eleventh; counting the `process.env.REDIS_KEY` occurrences in each file and comparing that number to
 * the registry is what makes a new key shape impossible to add quietly, whether it is exported, inlined
 * in a function body, or written into a file that never built a key before.
 *
 * ⚠️ **Two rows left this registry with the dual-read fallback**: `legacySessionKey`, the last
 * raw-token key shape on the platform, and `dualReadHitsKey`, the counter that measured it. The count
 * assertion above is what turned their removal into a failing test rather than a thing to remember —
 * `sessionKeys.mts` dropped from twelve interpolations to ten in the same commit.
 */

const PREFIX = 'test:'

/** A stand-in for whatever the caller hands a builder: a token, an id, a field name. */
const INPUT = 'e7d4c1a09b6f4e2d8a3c5b7f1e9d0c2a'

const ACCOUNT_ID = '68b1f2c4a9d0e1f2a3b4c5d6'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/**
 * Every place on this platform that builds a Redis key, and what happens to the caller's input on the
 * way in.
 *
 * `digests` is the property that matters: a builder marked `true` must not leave its argument legible in
 * the key, and one marked `false` carries the sentence saying why passing it through is not a credential
 * leak. There is no third state — "it does not take one" is `digests: null`, a key with no input at all,
 * asserted as a literal instead.
 */
const KEY_SHAPES = [
	{ file: 'others/sessionKeys.mts', name: 'sessionKey', build: () => sessionKey(INPUT), digests: true },
	{ file: 'others/sessionKeys.mts', name: 'tombstoneKey', build: () => tombstoneKey(INPUT), digests: true },
	{
		file: 'others/sessionKeys.mts',
		name: 'familyKey',
		build: () => familyKey(INPUT),
		digests: false,
		why: 'a randomUUID lineage id, never derived from a token — presenting one grants nothing'
	},
	{
		file: 'others/sessionKeys.mts',
		name: 'sessionIndexKey',
		build: () => sessionIndexKey(Tier.User, ACCOUNT_ID),
		digests: false,
		why: 'a tier and an account _id, both of which every resource query already carries'
	},
	{
		file: 'others/sessionKeys.mts',
		name: 'sessionKeyFromIndexField',
		build: () => sessionKeyFromIndexField(INPUT),
		digests: false,
		why: 'the field is already the digest that filed the session — rehashing it would name a key that has never existed'
	},
	{
		file: 'others/sessionKeys.mts',
		name: 'reuseEventsKey',
		build: () => reuseEventsKey(Tier.Admin, ACCOUNT_ID),
		digests: false,
		why: 'a tier and an account _id, as the session index above'
	},
	{ file: 'others/sessionKeys.mts', name: 'graceHitsKey', build: graceHitsKey, digests: null },
	{ file: 'others/sessionKeys.mts', name: 'keygripKey', build: keygripKey, digests: null },
	{ file: 'others/sessionKeys.mts', name: 'keygripHoldersKey', build: keygripHoldersKey, digests: null },
	{ file: 'others/sessionKeys.mts', name: 'keygripChannel', build: keygripChannel, digests: null },
	{
		file: 'others/assertHashFieldTTLSupport.mts',
		name: 'HASH_FIELD_TTL_PROBE_KEY',
		build: HASH_FIELD_TTL_PROBE_KEY,
		digests: null
	},
	{ file: 'others/assertUnderRateLimit.mts', name: 'assertUnderRateLimit', build: null, digests: true }
] as const

/** How many `process.env.REDIS_KEY` interpolations each source file is allowed to carry. */
const ALLOWED_PER_FILE = KEY_SHAPES.reduce<Record<string, number>>(
	(counts, shape) => ({ ...counts, [shape.file]: (counts[shape.file] ?? 0) + 1 }),
	{}
)

const mtsFilesUnder = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? mtsFilesUnder(join(dir, entry.name)) : entry.name.endsWith('.mts') ? [join(dir, entry.name)] : []
	)

/** Every source file that interpolates the prefix, with how many times it does it. */
const keyBuildingFiles = () => {
	const found: Record<string, number> = {}

	for (const path of mtsFilesUnder(SRC)) {
		const occurrences = readFileSync(path, 'utf8').match(/\$\{process\.env\.REDIS_KEY}/g)

		if (occurrences) found[path.slice(SRC.length).replaceAll('\\', '/')] = occurrences.length
	}

	return found
}

beforeEach(() => {
	vi.stubEnv('REDIS_KEY', PREFIX)
})

describe('the registry is the whole keyspace', () => {
	it('finds no file building a key that the registry does not name', () => {
		expect(Object.keys(keyBuildingFiles()).sort()).toStrictEqual(Object.keys(ALLOWED_PER_FILE).sort())
	})

	// The count, not the names — see the ⚠️ at the top. An eleventh builder in sessionKeys.mts fails
	// here whether or not it is exported, which is the only version of this check worth having.
	it.each(Object.entries(ALLOWED_PER_FILE))('%s builds exactly %s key shapes', (file, allowed) => {
		expect(keyBuildingFiles()[file]).toBe(allowed)
	})
})

describe('no raw token reaches a key name', () => {
	it.each(KEY_SHAPES.filter((shape) => shape.digests === true && shape.build).map((shape) => [shape.name, shape.build]))(
		'%s digests its argument',
		(_name, build) => {
			const key = build!()

			expect(key).not.toContain(INPUT)
			expect(key.slice(PREFIX.length)).toMatch(/(^|:)[0-9a-f]{64}$/)
		}
	)

	// `assertUnderRateLimit` builds its key inline rather than through a builder, so it is driven instead
	// of called. The bucket name stays legible on purpose — an admin counts a bucket without being able
	// to name anybody in one — and the identity, which is the half a caller could get wrong, does not.
	it('assertUnderRateLimit digests the identity and leaves the bucket readable', async () => {
		const store = {
			incr: vi.fn().mockResolvedValue(1),
			expire: vi.fn().mockResolvedValue(1),
			ttl: vi.fn().mockResolvedValue(-1)
		} satisfies IRateLimitStore

		await assertUnderRateLimit(store, 'login', INPUT, 5, 60)

		const key = store.incr.mock.calls[0]![0] as string

		expect(key).not.toContain(INPUT)
		expect(key.startsWith(`${PREFIX}rl:login:`)).toBe(true)
		expect(key.slice(`${PREFIX}rl:login:`.length)).toMatch(/^[0-9a-f]{64}$/)
	})

	/*
	 * ⚠️ The check this pair cannot make: *whether the caller passed something network-derived*. Nothing
	 * here can see a client address arriving as an `identity` — the digest would hide it just as well as it
	 * hides an email. What holds that line is one layer up and structural: `app.proxy` stays off in all
	 * nine services, so a resolver has no client address to pass. That is a manual check, and
	 * `docs/testing.md` says so rather than implying this suite covers it.
	 */
	it('lets a builder pass its argument through only with a written reason, never an empty cell', () => {
		const passThrough = KEY_SHAPES.filter((shape) => shape.digests === false)

		expect(passThrough.map((shape) => shape.name)).toStrictEqual([
			'familyKey',
			'sessionIndexKey',
			'sessionKeyFromIndexField',
			'reuseEventsKey'
		])
		expect(passThrough.filter((shape) => !shape.why?.trim())).toStrictEqual([])
	})
})

describe('the constant key shapes', () => {
	it('are the prefix and a word, with nothing interpolated', () => {
		const constants = KEY_SHAPES.filter((shape) => shape.digests === null)

		expect(constants.map((shape) => shape.build!())).toStrictEqual([
			`${PREFIX}grace-hits`,
			`${PREFIX}keygrip`,
			`${PREFIX}keygrip:holders`,
			`${PREFIX}keygrip:rotated`,
			`${PREFIX}hash-field-ttl-probe`
		])
	})
})
