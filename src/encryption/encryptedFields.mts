import { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM } from '@encryption/EncryptionAlgorithm.mjs'
import { IEncryptedFieldSpec } from '@encryption/IEncryptedFieldSpec.mjs'

/**
 * The field map of ADR-029, and the only place the algorithm of a field is decided.
 *
 * Read these four lists as the answer to "is this field encrypted, and how" — no call site restates
 * it, and no service is allowed to. The rule behind them, in one line: **encrypt personal data;
 * leave alone what is not personal data, what the platform publishes anyway, and what the database
 * itself has to read.**
 *
 * ⚠️ Adding a personal field to a collection means adding it here *and* declaring it `binData` in
 * `marketplace-db-setup`. Nothing gates that — a `string` field is perfectly valid inside a
 * collection whose neighbours are `binData`, so an omission here is silent and the field simply
 * stays in the clear. `test/encryption.test.mts` walks these lists against the models, which catches
 * a path that does not exist; it cannot catch a path nobody wrote down.
 *
 * ⚠️ **Deterministic is for equality lookups only, and there are exactly five of them.** Every one
 * is a field some flow filters on — three login addresses and the two pending-email-change slots
 * `emailChangeHashVerify` reads by value. Do not extend the deterministic set to make a new query
 * work: deterministic ciphertext supports `$eq`/`$in` and nothing else, so a `sort`, a range or a
 * `$regex` will still fail, and the leak of equality will have been paid for nothing.
 */

/**
 * `admin` — the platform operator.
 *
 * Both names are encrypted, and unlike the shop owner's they cost nothing: there is no operator
 * table over this collection, so nothing sorts or searches them.
 */
export const ENCRYPTED_FIELDS_ADMIN: IEncryptedFieldSpec[] = [
	{ path: 'login.email', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'personalData.firstName', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.lastName', algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
]

/**
 * `shopOwner` — the person who runs shops on the platform.
 *
 * ⚠️ **`personalData.firstName`, `personalData.lastName` and `personalData.address.city` are absent
 * from this list on purpose.** They are personal data and they belong here on every ground except
 * one: `shopOwnersActiveTbl` sorts on all three through `tbl_active_lastName_firstName`,
 * `tbl_active_firstName` and `tbl_active_city`, and prefix-searches them with `/^term/i`. Encrypting
 * them does not slow those paths down, it falsifies them — the table would keep rendering, ordered
 * by ciphertext, and every search would return nothing. ADR-029 records the trade and the conditions
 * for revisiting it. Adding them here without dropping those three indexes in the same change is the
 * one mistake this file exists to prevent.
 *
 * Everything else the shop owner declared about themselves is encrypted, including the point:
 * `position` is an object, so random is the only algorithm defined for it, and nothing queries it —
 * there is no `2dsphere` on this collection.
 */
export const ENCRYPTED_FIELDS_SHOP_OWNER: IEncryptedFieldSpec[] = [
	{ path: 'login.email', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'emailVerify.newEmailTmp', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'personalData.birth.date', algorithm: ALGORITHM_RANDOM, plaintext: 'date' },
	{ path: 'personalData.address.street', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.address.postalCode', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.address.province', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.address.position', algorithm: ALGORITHM_RANDOM, plaintext: 'object' },
	{ path: 'personalData.contacts.mobile', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.contacts.landline', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.contacts.email', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	// What an operator wrote *about* this person, which is why these are the encrypted fields here
	// that the subject never sees. The ShopOwner tier does not load this model at all.
	{ path: 'notes', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	// Why an operator suspended the account. Random, not deterministic: nothing filters on it, and
	// deterministic would make two accounts suspended for the same reason visibly equal. The
	// 1000-character cap it carries is a service-side rule — see the model, and ADR-044.
	{ path: 'disabledReason', algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
]

/**
 * `user` — the end customer.
 *
 * The whole of `personalData` and the whole of every address element, because nothing sorts,
 * searches or geo-queries any of it: a customer reads their own document by `_id`, and there is no
 * operator table over this collection.
 *
 * ⚠️ `addresses.[]._id` and `defaultAddress` stay in the clear and must. The collection validator is
 * `$and: [{ $jsonSchema }, { $expr }]`, and the `$expr` half `$map`s the `_id` of every element and
 * checks `defaultAddress` is one of them. Encrypting either side of that comparison makes the
 * validator unsatisfiable — every write to the collection would be refused. An ObjectId minted by
 * the server is not personal data on its own, so nothing is given up.
 */
export const ENCRYPTED_FIELDS_USER: IEncryptedFieldSpec[] = [
	{ path: 'login.email', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'emailVerify.newEmailTmp', algorithm: ALGORITHM_DETERMINISTIC, plaintext: 'string' },
	{ path: 'personalData.firstName', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.lastName', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.birth.date', algorithm: ALGORITHM_RANDOM, plaintext: 'date' },
	{ path: 'personalData.contacts.mobile', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.contacts.landline', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'personalData.contacts.email', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].label', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].street', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].postalCode', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].city', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].province', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'addresses.[].position', algorithm: ALGORITHM_RANDOM, plaintext: 'object' },
	// Why an operator suspended the account — the one field on `user` the subject never sees. Random:
	// nothing filters on it, and deterministic would make two accounts suspended for the same reason
	// visibly equal. Its 1000-character cap is a service-side rule, see ADR-044.
	{ path: 'disabledReason', algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
]

/**
 * `company` — a legal entity, and two natural persons hiding inside it.
 *
 * Only those two are encrypted. `legalName`, `vatNumber`, `taxCode`, `certifiedEmail`, `uniqueCode`
 * and `registryExtract` describe the *entity* — this platform's `taxCode` is explicitly the
 * 11-character company form and not the 16-character personal one — and `publicName`, `slug`,
 * `description` and the whole of `address` are what the storefront publishes, indexed by
 * `search_text`, `published_city_publicName` and `address.position_2dsphere`. Encrypting any of them
 * would be encrypting data the platform hands to anonymous visitors, at the price of the map, the
 * city listing and the search.
 */
export const ENCRYPTED_FIELDS_COMPANY: IEncryptedFieldSpec[] = [
	{ path: 'contactPerson', algorithm: ALGORITHM_RANDOM, plaintext: 'string' },
	{ path: 'administrator', algorithm: ALGORITHM_RANDOM, plaintext: 'string' }
]

/**
 * One data encryption key per collection, named after it.
 *
 * Not one key for the platform: a DEK that leaks then costs one collection rather than every
 * personal field on the system. Not one key per field either — that is four hundred key-vault
 * lookups' worth of ceremony to protect fields that are read together anyway, in the same document,
 * by the same service.
 */
export const KEY_ALT_NAME_ADMIN = 'admin'
export const KEY_ALT_NAME_SHOP_OWNER = 'shopOwner'
export const KEY_ALT_NAME_USER = 'user'
export const KEY_ALT_NAME_COMPANY = 'company'

export const KEY_ALT_NAMES = [KEY_ALT_NAME_ADMIN, KEY_ALT_NAME_SHOP_OWNER, KEY_ALT_NAME_USER, KEY_ALT_NAME_COMPANY]
