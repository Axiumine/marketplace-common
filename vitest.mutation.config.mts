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
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } }
	}
})
