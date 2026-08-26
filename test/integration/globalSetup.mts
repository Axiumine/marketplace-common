import { MongoClient } from 'mongodb'

import { assertTestMongoEnv, buildTestMongoUrl, TEST_DB } from '../../vitest.mongo.mts'

/**
 * Provision this package's throwaway database before the integration project runs.
 *
 * Unlike the backend services, this package has NO migrations to replay: marketplace-db-setup owns
 * the `$jsonSchema` validators and indexes, and only the services' own integration suites need
 * them present to exercise a real write. This suite tests the Mongoose models/schemas that live
 * IN this package — required-field validation, round-trip save, the pre-save hash hook — against
 * a real mongod, but a schema-less throwaway database is enough for that; there is nothing to
 * migrate into it here.
 *
 * Two users, the same split production uses:
 *   - the DB OWNER connects here and drops the database, so every test file starts from empty
 *     collections instead of whatever a previous run (or another package's suite, if it were ever
 *     misconfigured onto the same name) left behind;
 *   - the R/W user is the one the models under test connect with (see vitest.integration.config.mts).
 */
export async function setup(): Promise<void> {
	// First thing: vitest.integration.config.mts evaluates buildTestMongoUrl('rw') at config-load
	// time too, but that call never throws on a missing block — it hands back a URL that is never
	// dialled. This is the one place that actually stops the run with a real message.
	assertTestMongoEnv()

	const client = new MongoClient(buildTestMongoUrl('owner'))
	try {
		await client.connect()
		await client.db(TEST_DB).dropDatabase()
	} finally {
		await client.close()
	}
}
