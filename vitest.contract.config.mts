import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Contract tests: package.json `exports` map integrity + smoke-import of the built dist.
// Requires a fresh `dist/` (the `test:contract` script builds first).
export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/contract/**/*.test.mts'],
		testTimeout: 30_000,
		// Caps how long a test's name may be — the mutation gate selects tests by name, and past a
		// size it cannot; see the file.
		setupFiles: ['./vitest.testNames.mts'],
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } }
	}
})
