import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Vitest config used by Stryker's vitest-runner. Same unit tests as the main config but with
// NO coverage gate — mutants deliberately change code, so line-coverage thresholds are irrelevant.
export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		testTimeout: 30_000,
		// Caps how long a test's name may be — the mutation gate selects tests by name, and past a
		// size it cannot; see the file.
		setupFiles: ['./vitest.testNames.mts'],
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } }
	}
})
