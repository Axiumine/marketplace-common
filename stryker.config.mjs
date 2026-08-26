/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 352 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 20s
	 *   concurrency 28 → 11s
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same zero non-killed mutants — no survivor, no timeout, nothing to compare away.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. `.qodana/` alone is ~23 MB here
	 * and Stryker's always-ignored list covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`,
	 * `/stryker.log` and `.stryker-tmp` — `ignorePatterns` itself defaults to empty.
	 *
	 * It is not just wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		'!src/**/MongoDBInterfaces/**',
		'!src/others/Redis/**',
		'!src/others/IRefreshData.mts',
		'!src/schema/interfaces/**'
	]
}
