import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertEnvShape, EnvShape } from '../src/others/assertEnvShape.mts'

afterEach(() => {
	vi.unstubAllEnvs()
})

/*
 * The phrase each shape completes "<NAME> must be …" with, asserted verbatim by every rejection below.
 * A boot message is the whole of what an admin has — the process is gone by the time they read it — so an
 * `expected` emptied or reworded still throws, with a sentence that names no format and sends them to the
 * source to find out what the check wanted.
 */
const EXPECTED: Readonly<Record<EnvShape, string>> = {
	absolutePath: 'an absolute path beginning with "/"',
	email: 'an email address',
	flag01: 'exactly "0" or "1"',
	hostname: 'a bare host name, not a URL',
	keyPrefix: 'a key prefix ending in ":"',
	mongoUri: 'a mongodb:// or mongodb+srv:// URI',
	namespace: 'a "<database>.<collection>" namespace',
	origin: 'an http(s) origin with no trailing slash',
	port: 'a TCP port between 0 and 65535',
	redisUrl: 'a redis:// or rediss:// URL'
}

/** Every case is `[shape, value, accepted]`, so a shape that starts accepting everything fails a row here. */
const CASES: ReadonlyArray<readonly [EnvShape, string, boolean]> = [
	// A port is the integer a TCP stack takes, both ends included, and nothing that merely starts like one.
	// `0` is in: it is the ephemeral port `listen(0)` asks the kernel for, and every integration suite here
	// binds on it.
	['port', '0', true],
	['port', '1', true],
	['port', '4027', true],
	['port', '65535', true],
	['port', '65536', false],
	['port', '-1', false],
	['port', '4027x', false],
	['port', ' 4027', false],
	['port', '1e3', false],

	// koa-utils compares against '1'; every other spelling of yes is the single-node branch, silently.
	['flag01', '0', true],
	['flag01', '1', true],
	['flag01', 'true', false],
	['flag01', '2', false],

	// A URL pasted into a host slot carries a scheme separator; a bare IPv6 literal carries colons and no slash.
	['hostname', 'db1', true],
	['hostname', '::1', true],
	['hostname', 'redis://db1', false],
	['hostname', 'db 1', false],

	// The prefix is concatenated, so the separator is part of the value or it is missing from every key.
	['keyPrefix', 'marketplaceDev:', true],
	['keyPrefix', 'marketplaceDev', false],
	['keyPrefix', 'marketplace Dev:', false],

	['absolutePath', '/media/uploads', true],
	['absolutePath', 'media/uploads', false],

	['email', 'noreply@shop.lan', true],
	['email', 'noreply@shop', false],
	['email', 'no reply@shop.lan', false],
	['email', 'noreply.shop.lan', false],
	// Anchored at both ends: unanchored, this one matches its own first sixteen characters and passes.
	['email', 'noreply@shop.lan and one more', false],

	// Split at the first dot: a database name cannot hold one, a collection name may.
	['namespace', 'dbMarketplaceDev.__keyVault', true],
	['namespace', 'dbMarketplaceDev.a.b', true],
	['namespace', '.__keyVault', false],
	['namespace', 'dbMarketplaceDev.', false],
	['namespace', 'dbMarketplaceDev', false],
	['namespace', 'db Marketplace.__keyVault', false],

	// `new URL('redis://')` parses and names no server, which is why the host is tested separately.
	['redisUrl', 'redis://db1:6379', true],
	['redisUrl', 'rediss://db1:6379', true],
	['redisUrl', 'redis://', false],
	['redisUrl', 'mongodb://db1/x', false],
	['redisUrl', 'db1:6379', false],

	['mongoUri', 'mongodb+srv://rs0.lan/dbMarketplaceDev', true],
	['mongoUri', 'mongodb://rs0.lan:27017/dbMarketplaceDev', true],
	// ⚠️ The replica set, spelled the way the driver spells one. `URL` cannot parse this — a port followed
	// by a comma is not a port — which is why `mongoUri` matches the scheme by name instead.
	['mongoUri', 'mongodb://db1:27017,db2:27017,db3:27017/dbMarketplaceDev?replicaSet=rs0', true],
	['mongoUri', 'mongodb://owner:secret@db1:27017,db2:27017/dbMarketplaceDev', true],
	['mongoUri', 'mongodb://rs0.lan', true],
	['mongoUri', 'mongodb+srv://', false],
	// A credential and no server: everything after the last `@` is the server list, and here there is none.
	['mongoUri', 'mongodb://owner:secret@', false],
	['mongoUri', 'mongodb://db1 db2/dbMarketplaceDev', false],
	['mongoUri', 'mongodb://?replicaSet=rs0', false],
	['mongoUri', 'redis://db1:6379', false],
	['mongoUri', 'rs0.lan', false],
	// ⚠️ The scheme is a PREFIX, not a suffix: a value ending in the scheme names nothing.
	['mongoUri', 'db1:27017/mongodb://', false],

	// The trailing slash survives concatenation as `//check/…` in a link that reaches an inbox.
	['origin', 'https://shop.lan', true],
	['origin', 'http://shop.lan', true],
	['origin', 'https://shop.lan/', false],
	['origin', 'ftp://shop.lan', false],
	['origin', 'shop.lan', false]
]

describe('assertEnvShape', () => {
	describe('the shapes themselves', () => {
		it.each(CASES)('%s %s is %s', (shape, value, accepted) => {
			const run = () => assertEnvShape({ SOME_NAME: shape }, { SOME_NAME: value })

			if (accepted) expect(run).not.toThrow()
			else expect(run).toThrow(`ENV_SHAPE_INVALID: SOME_NAME must be ${EXPECTED[shape]}.`)
		})
	})

	/*
	 * Presence is `checkRequiredEnv`'s pass and runs first. Repeating it here would make a *conditional*
	 * variable impossible to shape: `REDIS_URL` is read on one Redis branch and ships empty for the other,
	 * so an empty value has to reach this function and leave it without a fault.
	 */
	it('skips a name that is absent, and one that is present and empty', () => {
		expect(() => assertEnvShape({ REDIS_URL: 'redisUrl' }, {})).not.toThrow()
		expect(() => assertEnvShape({ REDIS_URL: 'redisUrl' }, { REDIS_URL: '' })).not.toThrow()
	})

	it('accepts an empty spec', () => {
		expect(() => assertEnvShape({}, { PORT: 'nonsense' })).not.toThrow()
	})

	it('accepts an environment where every shaped name is well formed', () => {
		const shapes: Record<string, EnvShape> = { PORT: 'port', REDIS_KEY: 'keyPrefix', MONGODB_URI: 'mongoUri' }
		const env = { PORT: '4027', REDIS_KEY: 'marketplaceDev:', MONGODB_URI: 'mongodb+srv://rs0.lan/db' }

		expect(() => assertEnvShape(shapes, env)).not.toThrow()
	})

	/*
	 * Provisioning a machine is when this fires, and one fault per restart turns that into a queue — so the
	 * pass collects rather than throwing at the first offender.
	 */
	it('reports every offending name in one message, separated', () => {
		const shapes: Record<string, EnvShape> = { PORT: 'port', REDIS_KEY: 'keyPrefix', MONGODB_URI: 'mongoUri' }
		const env = { PORT: 'four thousand', REDIS_KEY: 'marketplaceDev', MONGODB_URI: 'mongodb+srv://rs0.lan/db' }

		expect(() => assertEnvShape(shapes, env)).toThrow(
			'ENV_SHAPE_INVALID: PORT must be a TCP port between 0 and 65535; REDIS_KEY must be a key prefix ending in ":".'
		)
	})

	/*
	 * A boot log is the least protected place on the platform, so the message carries the name and the format
	 * and never the string that failed — the same rule `readKek` states for the one value that would matter most.
	 */
	it('never prints the offending value', () => {
		const secret = 'p4ssw0rd-that-should-not-be-logged'

		expect(() => assertEnvShape({ MONGODB_URI: 'mongoUri' }, { MONGODB_URI: secret })).toThrow(
			expect.objectContaining({ message: expect.not.stringContaining(secret) })
		)
	})

	it('reads process.env when no environment is passed', () => {
		vi.stubEnv('REDIS_KEY', 'marketplaceDev')

		expect(() => assertEnvShape({ REDIS_KEY: 'keyPrefix' })).toThrow(/REDIS_KEY must be a key prefix/)

		vi.stubEnv('REDIS_KEY', 'marketplaceDev:')

		expect(() => assertEnvShape({ REDIS_KEY: 'keyPrefix' })).not.toThrow()
	})
})
