/**
 * The shapes a boot-time environment value can be asked to have.
 *
 * Each name is a *format*, never a range of acceptable deployments: `port` says "an integer a TCP stack
 * would accept", not "4027". Nothing here pins a value, because a value pinned in TypeScript stops being
 * an environment variable — the service could no longer be moved to another port or another host without
 * a release, which is the property `.env` exists to provide.
 */
export type EnvShape =
	'absolutePath' | 'email' | 'flag01' | 'hostname' | 'keyPrefix' | 'mongoUri' | 'namespace' | 'origin' | 'port' | 'redisUrl'

interface IEnvShapeCheck {
	/** Human phrase completing "<NAME> must be …", printed in the boot error. */
	readonly expected: string
	readonly accepts: (value: string) => boolean
}

/**
 * `URL` is the parser, so a scheme this platform does not speak is rejected by name rather than by a regex
 * nobody can read. The host test is not redundant: `new URL('redis://')` parses and yields an empty host,
 * which is a string that looks like a server and names none.
 *
 * ⚠️ `URL.canParse` rather than a `try`/`catch` around the constructor, deliberately. The two behave
 * identically here, but a `catch { return false }` is a block whose *only* observable effect is a falsy
 * value — emptying it returns `undefined`, which every caller below reads exactly as `false`. That is an
 * equivalent mutant by construction: nothing a test can assert tells the two apart. A guard clause has a
 * return value the suite can see.
 */
const parsesAs =
	(protocols: readonly string[]) =>
	(value: string): boolean => {
		if (!URL.canParse(value)) return false

		const url = new URL(value)

		return protocols.includes(url.protocol) && url.host !== ''
	}

/** Matched by name rather than by `URL` — see `mongoUri` below for why that one cannot use the parser. */
const MONGO_SCHEMES = ['mongodb://', 'mongodb+srv://'] as const

const CHECKS: Readonly<Record<EnvShape, IEnvShapeCheck>> = {
	/** A path resolved from nothing — a relative one resolves against the process's cwd, which differs per launcher. */
	absolutePath: { expected: 'an absolute path beginning with "/"', accepts: (value) => value.startsWith('/') },
	email: { expected: 'an email address', accepts: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) },
	/**
	 * koa-utils compares `REDIS_IS_CLUSTER === '1'` and treats every other value — `true`, `yes`, `TRUE` —
	 * as the single-node branch. That default is silent and it is a branch of the platform, so the two
	 * strings that mean something are the only two accepted.
	 */
	flag01: { expected: 'exactly "0" or "1"', accepts: (value) => value === '0' || value === '1' },
	/**
	 * A host, not a URL. `/` is the character that separates the two: a `redis://db1:6379` pasted into a
	 * `REDIS_DB1_HOST` slot carries one and a bare `db1` never does. `:` is deliberately allowed so a bare
	 * IPv6 literal still passes.
	 */
	hostname: { expected: 'a bare host name, not a URL', accepts: (value) => !/[\s/]/.test(value) },
	/**
	 * `REDIS_KEY` is concatenated, never joined: `sessionKeys.mts` builds `` `${REDIS_KEY}keygrip` ``. A
	 * prefix missing its separator therefore names `marketplaceDevkeygrip` — a legal Redis key in a
	 * namespace nobody else writes, which is `assertRedisNamespace`'s failure arriving one layer earlier.
	 */
	keyPrefix: { expected: 'a key prefix ending in ":"', accepts: (value) => value.endsWith(':') && !/\s/.test(value) },
	/**
	 * ⚠️ **Not `URL`, unlike every other URL shape here, and the exception is the driver's own grammar.** A
	 * connection string names *every* member of a replica set, comma-separated —
	 * `mongodb://a:27017,b:27017,c:27017/db?replicaSet=rs0` — and WHATWG `URL` refuses that string outright:
	 * a port followed by a comma is not a port it can parse, so `URL.canParse` answers `false` for the exact
	 * value a replica set is reached with. A check meant to catch a Redis URL in the Mongo slot would have
	 * refused the correct value instead, on the one deployment shape this platform actually runs.
	 *
	 * So the scheme is matched by name and the server list is required to name something. `@` splits off the
	 * optional `user:password` — what has to be non-empty is the part after it, because `mongodb://u:p@` is
	 * a credential and no server.
	 */
	mongoUri: {
		expected: 'a mongodb:// or mongodb+srv:// URI',
		accepts: (value) => {
			const scheme = MONGO_SCHEMES.find((candidate) => value.startsWith(candidate))

			if (scheme === undefined) return false

			// Everything before the database path or the option string: `[user:password@]host[,host…]`.
			const authority = value.slice(scheme.length).split(/[/?]/)[0]
			const hosts = authority.split('@').pop() as string

			return hosts !== '' && !/\s/.test(hosts)
		}
	},
	/**
	 * `<database>.<collection>`, split at the FIRST dot: a database name cannot contain one, a collection
	 * name can. Both halves must be non-empty, which is what a bare database name pasted here fails.
	 */
	namespace: {
		expected: 'a "<database>.<collection>" namespace',
		accepts: (value) => {
			const dot = value.indexOf('.')

			return dot > 0 && dot < value.length - 1 && !/\s/.test(value)
		}
	},
	/**
	 * An origin the code appends a rooted path to — `${APP_DOMAIN}/check/verify-email/…`. A trailing slash
	 * is refused because it survives concatenation as `//check/…`: still routable on most servers, and the
	 * link that reaches a customer's inbox is the one place a cosmetic defect is expensive to withdraw.
	 */
	origin: {
		expected: 'an http(s) origin with no trailing slash',
		accepts: (value) => parsesAs(['http:', 'https:'])(value) && !value.endsWith('/')
	},
	/**
	 * ⚠️ **`0` is accepted, and it is not sloppiness.** `listen(0)` asks the kernel for a free port, which is
	 * what every integration project in this workspace binds on so seven suites can run at once against a
	 * machine already serving the dev fleet. Refusing it would refuse the harness rather than a
	 * misconfiguration. There is no lower bound in the predicate for the same reason there is no negative
	 * check: `\d+` already excludes everything below zero, and a bound that can never fail is a condition no
	 * test can distinguish from `true`.
	 */
	port: {
		expected: 'a TCP port between 0 and 65535',
		accepts: (value) => /^\d+$/.test(value) && +value <= 65535
	},
	redisUrl: { expected: 'a redis:// or rediss:// URL', accepts: parsesAs(['redis:', 'rediss:']) }
}

/**
 * Refuses to boot when a set environment value is the wrong *kind* of thing (`RISK_REGISTER` R04).
 *
 * ⚠️ **This is a shape check, never a presence check, and the two are deliberately separate passes.** A
 * name absent from the environment, or present and empty, is skipped here — `checkRequiredEnv`'s own loop
 * owns that question and answers it first. Keeping them apart is what lets a *conditional* variable be
 * shaped without being required: `REDIS_URL` is read on one Redis branch and ignored on the other, and the
 * committed `env` templates ship it empty for the branch that ignores it.
 *
 * ⚠️ **It reports every offending name at once, and prints no value, ever.** Provisioning a machine is the
 * moment this fires, and a check that names one fault per restart turns that into a queue. The message
 * carries names and expected formats because a boot log is the least protected place on the platform —
 * `readKek` states the same reasoning at length for the one value that would matter most.
 *
 * ⚠️ **What it catches is a value from somewhere else, not a value that is merely wrong.** R04's trigger is
 * an `env` provisioned by copy from an unrelated project, and most of what that produces is the wrong
 * *type* of string in a slot: a Mongo URI where a Redis URL belongs, `true` where koa-utils compares
 * against `'1'`, a host name carrying a scheme. A plausible-but-incorrect value of the right shape — the
 * right-looking password for the wrong server — passes every check here and always will, because no
 * predicate a single process can run knows what the rest of the fleet was pointed at. That residual is the
 * open half of R04 and the reason the row does not close.
 *
 * ⚠️ **`KEYGRIP_KEK` has no shape here on purpose.** Its length rule lives in `readKek` and belongs to the
 * one decode site, which is what makes it impossible for the rule to be present in one place and missing in
 * another. Adding a second spelling of it to a service's spec would create exactly the drift that comment
 * exists to prevent.
 */
export function assertEnvShape(shapes: Readonly<Record<string, EnvShape>>, env: NodeJS.ProcessEnv = process.env): void {
	const faults: string[] = []

	for (const [name, shape] of Object.entries(shapes)) {
		const value = env[name]
		const check = CHECKS[shape]

		if (value !== undefined && value !== '' && !check.accepts(value)) faults.push(`${name} must be ${check.expected}`)
	}

	if (faults.length > 0)
		throw new Error(
			`ENV_SHAPE_INVALID: ${faults.join('; ')}. No value is printed — read the names above out of this repo's own env file.`
		)
}
