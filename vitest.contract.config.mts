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
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } }
	}
})
