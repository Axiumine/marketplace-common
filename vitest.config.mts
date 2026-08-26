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
			all: true,
			include: ['src/**/*.mts'],
			extension: ['.mts'],
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			thresholds: { 100: true }
		}
	}
})
