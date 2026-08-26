import { defineConfig } from 'vitest/config'

import { buildTestMongoUrl } from './vitest.mongo.mts'
import { nodeNextResolver } from './vitest.shared.mts'

// Integration tests: a REAL MongoDB, reached through the MONGO_TEST_* env block — the platform
// standard set by the seven backend services and by marketplace-db-setup (see CLAUDE.md). This used
// to boot mongodb-memory-server instead; that gave the models a database with no $jsonSchema
// validator at all, so a model that disagreed with the real collection validator (as ShopOwner
// once did) could pass every test here and still be rejected in production. Exercises required-field
// validation, the round-trip save, and the pre-save hash hook firing on a real `.save()`, against
// the same validators and indexes the services write through.
export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/integration/**/*.int.test.mts'],
		// Retimed for a network round-trip to the real cluster, not for booting a local mongod binary.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		fileParallelism: false, // one throwaway database per run; the suite drops it in globalSetup
		globalSetup: ['./test/integration/globalSetup.mts'],
		server: { deps: { inline: ['graphql', 'graphql-scalars'] } },
		// MONGO_TEST_* connection pieces come from .env; the R/W user is the least-privilege grant
		// production uses, so a model that quietly needs more than readWrite fails here too.
		env: {
			MONGODB_URI: buildTestMongoUrl('rw')
		}
	}
})
