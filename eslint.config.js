import eslintConfig from '@axiumine/eslint-config-be'
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import simpleImportSort from 'eslint-plugin-simple-import-sort'

// The shared config only covers `src/**`, so the test files and the vitest configs (outside src/)
// would be left without a TS parser. Here we reuse the same rules as the shared TypeScript block,
// but without `project`: tsconfig.json only includes `src/**/*.mts`.
const sharedTsBlock = eslintConfig.find((c) => c.files?.includes('src/**/*.{d.ts,ts,cts,mts}'))

export default [
	// Build and tool output, not sources. `.stryker-tmp` is the sandbox Stryker copies the whole repo
	// into and only removes on a clean exit, so an interrupted run leaves a second copy of every test
	// file behind; `.qodana` is the SARIF and the bundled HTML report `--results-dir` writes. Both
	// blocks below are scoped tightly enough that none of it is reachable anyway — this is the second
	// lock, and it keeps this file comparable with the seven services, which list the same paths.
	{ ignores: ['dist/**', 'coverage/**', '.stryker-tmp/**', 'reports/**', '.qodana/**'] },
	...eslintConfig,
	// The six test suites and the seven vitest configs. Until this block existed they were linted by
	// **nothing**: `@axiumine/eslint-config-be` matches `src/**` only, `test/**/*.mts` matched no
	// entry at all, and eslint answers an unmatched path by checking zero rules and exiting 0 —
	// `eslint --print-config <any test file>` printed `undefined`. Silence read as a pass for
	// as long as that was true. The glob covers test/, test/contract/, test/integration/ and
	// test/types/; the seven root `vitest.*.mts` files are the second half of the same hole.
	//
	// The seven services have carried this block for a while and this package did not, which is the
	// usual shape of drift here: near-duplicate configs, fixed one at a time.
	{
		files: ['test/**/*.mts', 'vitest.*.mts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
		},
		plugins: sharedTsBlock.plugins,
		rules: sharedTsBlock.rules
	},
	// The root-level JS config files — this file and stryker.config.mjs. The shared config's JS block
	// is scoped to `src/**/*.{js,cjs,mjs}`, and a package whose sources are all .mts has no JS under
	// src/ at all, so without this block the two files that decide how everything else is linted and
	// mutated are themselves checked by nothing while `yarn lint:check` reports green.
	//
	// `marketplace-dev-public-resource` was the only repo that noticed: it carried a `.eslintrc.json`
	// declaring exactly this intent — eslint:recommended plus simple-import-sort, node, `*.mjs` as
	// module — and it never once ran. eslintrc was already inert under eslint 9's flat-config default,
	// and eslint 10 (`^10.8.0` here) dropped the format outright, so the file was decoration. It is
	// deleted; this block is what it meant to be, and it lives in all seven services and here because
	// the gap was never specific to the one repo that documented it.
	//
	// `*.js` in flat config matches the config file's own directory only — it is NOT expanded to
	// `**/*.js`. That is the whole reason this is safe: a repo-wide JS block would also pick up the
	// minified browser bundle Qodana writes under .qodana/ and any leftover .stryker-tmp/ sandbox,
	// which is precisely how marketplace-admin's config arrived at 1600 `no-undef` errors. Both paths are
	// in the `ignores` above as well — belt and braces, since the glob alone already excludes them.
	//
	// No `globals` entry: neither root file references a node global. Every `process` and `module`
	// that greps out of stryker.config.mjs across these repos is inside a comment. Add one here if
	// that stops being true — do not reach for a wider glob.
	{
		files: ['*.js', '*.mjs', '*.cjs'],
		languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		plugins: { 'simple-import-sort': simpleImportSort },
		rules: {
			...js.configs.recommended.rules,
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error'
		}
	},
	// E12-S04 — neither setting this audit removed can come back by accident.
	//
	// Core `no-restricted-syntax`, in this file rather than in `@axiumine/eslint-config-be`: the shared
	// package is a repo outside these sixteen and ships to unrelated consumers, so a Sentry-specific rule
	// there would cost a publish, a version bump in ten dependents, and a rule everyone else carries for
	// nothing. One block duplicated into ten repos is the cheaper half of that trade, and it follows the
	// idiom the two blocks above already established.
	//
	// No `files` key, so this applies to every file eslint looks at here. Three selectors for
	// `rejectUnauthorized` because the defect actually in the tree was an assignment
	// (`options.rejectUnauthorized = false`), not an object literal — a `Property`-only rule passes the
	// exact code it exists to catch — and the computed form has a `key.value` where the plain one has a
	// `key.name`. Two for `NODE_TLS_REJECT_UNAUTHORIZED` for the same reason one level up:
	// `process.env.X` parses as an Identifier, `process.env['X']` as a Literal, and a rule carrying one
	// misses the other.
	{
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: "AssignmentExpression[left.property.name='rejectUnauthorized']",
					message:
						'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
				},
				{
					selector: "Property[key.name='rejectUnauthorized']",
					message:
						'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
				},
				{
					selector: "Property[key.value='rejectUnauthorized']",
					message:
						'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
				},
				{
					selector: "Property[key.name='sendDefaultPii']",
					message:
						'E12-S04: the blanket Sentry PII flag is absent by decision, not set to false. Name the individual dataCollection categories instead — the observability section of docs/architecture.md says which, and why.'
				},
				{
					selector: "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
					message:
						'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
				},
				{
					selector: "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
					message:
						'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
				}
			]
		}
	}
]
