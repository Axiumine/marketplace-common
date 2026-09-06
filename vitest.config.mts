import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Unit tests + coverage gate. Top-level `test/*.test.mts` only — the heavier suites
// (contract, integration, types) live in subdirs and run under their own configs.
export default defineConfig({
	plugins: [nodeNextResolver],
	// graphql throws "from another module or realm" if two copies load; keep a single instance.
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		testTimeout: 30_000, // bcrypt with SALT_ROUNDS=14 is intentionally slow
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } },
		coverage: {
			provider: 'v8',
			// ⚠️ `include` is what makes the thresholds below mean anything, and it is not
			// optional. Without it the v8 provider reports only the files a test actually imported:
			// a source file no suite ever loads is ABSENT from the report rather than listed at 0%,
			// so a 100% gate passes over it (RISK_REGISTER R07). The glob names every shipped source
			// file, so a new one is force-listed at 0% and takes the run red until it has a test.
			//
			// ⚠️ `all: true` and `extension: ['.mts']` used to sit either side of this line and did
			// nothing at all. vitest 4 removed both from CoverageOptions, no runtime path reads them,
			// and an unchecked spread swallowed them without a warning — so the safety net a reader
			// took them for was never there. Do not bring either back: a non-null `include` is the
			// entire mechanism, and `all` is not a synonym for it.
			include: ['src/**/*.mts'],
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			thresholds: { 100: true }
		}
	}
})
