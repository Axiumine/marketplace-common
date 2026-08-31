# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

What "notable" means for a published library: an entry earns a place here if it changes what a consumer
sees — an `exports` entry, an exported symbol, a schema path, a peer dependency, a runtime behaviour. Repo
plumbing that never reaches the tarball (`files` is `["dist"]`) is recorded under the release it landed in,
marked as shipping no change to `dist/`, so that a reader deciding whether to publish can tell the two
apart without reading the diff.

## [Unreleased](https://github.com/Axiumine/marketplace-common/compare/v4.2.0...HEAD)

Nothing yet.

## [4.2.0](https://github.com/Axiumine/marketplace-common/releases/tag/v4.2.0) - 2026-08-31

### Added

- **`others/assertEnvShape` — a boot check that refuses an environment value of the wrong *kind*.** Every
  service until now asked one question of its environment, `checkRequiredEnv`'s `if (!env[name])`, and a
  string answers it. `4027x`, `true` where koa-utils compares against `'1'`, a `mongodb://` URI in the
  Redis slot and a `redis://` URL in the Mongo one are all truthy, so all four booted a service that then
  failed somewhere that does not name the cause — or, worse, did not fail at all. This is the shape half
  of `RISK_REGISTER` R04, whose trigger is an `.env` provisioned by copy from an unrelated project.

  Ten shapes, named for the format rather than for any deployment: `absolutePath`, `email`, `flag01`,
  `hostname`, `keyPrefix`, `mongoUri`, `namespace`, `origin`, `port`, `redisUrl`. `URL.canParse` plus the
  `URL` constructor is the parser for the four that are URLs, so an unspoken scheme is rejected by name
  instead of by an unreadable regex, and the host is tested separately because `new URL('redis://')` parses
  and names no server.

  ⚠️ **Shape and presence are two passes and stay two passes.** A name absent, or present and empty, is
  skipped here — `checkRequiredEnv`'s own loop owns that question and answers it first. That separation is
  what lets a *conditional* variable be shaped without being required: `REDIS_URL` is read on one Redis
  branch and ignored on the other, and the committed `env` templates ship it empty for the branch that
  ignores it.

  Every fault is reported in one message, and **no value is ever printed** — provisioning a machine is when
  this fires, one fault per restart turns that into a queue, and a boot log is the least protected place on
  the platform. `KEYGRIP_KEK` carries no shape here on purpose: its length rule belongs to `readKek`, the
  single decode site, and a second spelling of it is the drift that comment exists to prevent.

  ⚠️ **It catches a value from somewhere else, not a value that is merely wrong.** The right-looking
  password for the wrong server passes every check here and always will, because no predicate one process
  can run knows what the rest of the fleet was pointed at. That residual is the open half of R04.

## [4.1.0](https://github.com/Axiumine/marketplace-common/releases/tag/v4.1.0) - 2026-08-31

### Added

- **`others/assertRedisNamespace` — a boot probe that refuses a `REDIS_KEY` naming a namespace this
  platform was never seeded into.** `REDIS_KEY` is a prefix, so no wrong value is one Redis will refuse:
  the five services that call `loadKeygrip` already fail their boot on a wrong prefix, because the record
  they need is not there, but the four **resource** services read no such record and a wrong prefix cost
  them nothing — every session lookup missed in a namespace nobody writes, every request answered 401, and
  the service reported itself healthy throughout.

  Presence only: it reads `<REDIS_KEY>keygrip` through `keygripKey()` and asks whether `wrapped` is there.
  It never reads the KEK and never unwraps anything, because three of its four callers hold no
  `KEYGRIP_KEK` at all — they verify access tokens rather than cookies, and handing them key material to
  answer a question about a *prefix* would widen what a resource service holds for no reason.
  `readKeygrip` keeps the record's well-formedness on behalf of the services that open it.

  It throws `readKeygrip`'s own `KEYGRIP_RECORD_MISSING` code, deliberately — one string to grep — with a
  remedy line naming both causes, since from inside the process a wrong prefix and an unseeded platform are
  indistinguishable. ⚠️ **It cannot see a fleet-wide wrong prefix and is not meant to**: a seed that ran
  under the same wrong `REDIS_KEY` puts the record exactly where every service looks, which is the
  provisioning failure `RISK_REGISTER` R04 names and which no check comparing the platform against itself
  can catch.

## [4.0.0](https://github.com/Axiumine/marketplace-common/releases/tag/v4.0.0) - 2026-08-31

### Removed

- **BREAKING — the `x-introspectioncode` request bypass is gone, and with it the
  `others/isIntrospectionBypassAllowed` `exports` entry.** The header let a caller holding a shared secret
  reach the resolvers with no session at all; it was never a read-only introspection switch, and nothing in
  the platform consumed it. Schema introspection itself is unaffected — it is refused in production by
  `NoSchemaIntrospectionCustomRule` in each service's validation rules, which is a separate control and
  stays exactly as it is.

  A consumer upgrading deletes the header read from its authorization middleware, drops
  `INTROSPECTION_CODE` from `REQUIRED_ENV_VARS` and from its `env` template, and removes any import of the
  predicate. Leaving the variable set is harmless — nothing reads it — but a service that still lists it in
  `REQUIRED_ENV_VARS` will refuse to boot without a value it no longer has a use for.

### Changed

- **BREAKING — `resolveAuthorizationSession` no longer takes `introspectionCode`, and no longer answers
  `null`.** Its return type narrows from `TAuthorizationSession<TAccountData> | null` to
  `TAuthorizationSession<TAccountData>`: a refresh token that resolves to no live session is now refused
  with the same 498 it earned before, in every case, so the caller has no empty-session branch left to
  write. A consumer that narrowed the union — an `if (!session)`, a non-null assertion, a `?? ` fallback —
  can delete that code; TypeScript flags what is now unreachable.
- **BREAKING — `AUTH_BOUNDARY_CASES` is seven cases, not eleven.** `AB-08`, `AB-09`, `AB-10` and `AB-11`
  described the removed bypass and are gone. `AB-01`..`AB-07` keep their ids and their wording, so a suite
  proving those needs no edit; a suite carrying one of the four retired ids in a comment should drop that
  test with the marker. `requiredAuthBoundaryCases` and the exemption map are otherwise unchanged.
- **`constantTimeEquals` stays, with its documentation rewritten.** It is the timing-safe comparison
  primitive, not a piece of the removed feature, and it keeps its own tests. The docblock no longer names a
  particular caller, and it now states plainly the trap a call site inherits: two absent operands compare
  equal, so comparing against a secret read from configuration requires checking that the secret exists.

## [3.1.0](https://github.com/Axiumine/marketplace-common/releases/tag/v3.1.0) - 2026-08-30

### Added

- **`exports`: `./others/unpublishOwnerStorefront`** — the storefront cascade ADR-045 requires, moved here
  from the two resource services that each carried an identical copy of it. It takes an inactive shop
  owner's companies and every item filed under one of them off air, inside the caller's transaction, and
  has no inverse by design. Three call sites reach it across two services — an admin suspension and an
  admin closure on the Admin resource service, the owner's own closure on the ShopOwner one — and the
  platform owner's ruling names both hands at once: *"so disable a shop owner, by shop owner or by admin,
  unpublish companies and items"*. The body is byte-for-byte what both services already ran, so nothing
  changes for a consumer that has not yet deleted its copy.

  ⚠️ **The first `others/` module that imports models.** `Company` and `Item` come from this package's own
  `@MongoDB/` sources, which makes importing it enough to register both models on the default mongoose
  connection. Every consumer of this symbol already imports both models directly, so no consumer gains a
  connection it did not have — but a service that wanted the helper and not the collections cannot have
  one, and that is the trade the move accepts.

## [3.0.0](https://github.com/Axiumine/marketplace-common/releases/tag/v3.0.0) - 2026-08-30

### Changed

- **`deploy-local.sh` is deleted.** It built the package and copied the result into every consumer's
  `node_modules`, which left twelve repos running a build that no version number and no lockfile named,
  and that any `yarn install` silently reverted. A change consumers need is published, always — the
  release flow in `CLAUDE.md` is the only route (platform owner, 2026-08-30). Ships no change to `dist/`.

- ⚠️ **BREAKING — `exports`: `./others/operatorOnlyFields` is now `./others/adminOnlyFields`**, and the
  exported `OPERATOR_ONLY_FIELDS_SHOP_OWNER` is now `ADMIN_ONLY_FIELDS_SHOP_OWNER`. The platform owner
  ruled on 2026-08-29 that there are three human roles — admin, shop owner, customer — and that
  "operator" names none of them; the word is gone from all sixteen repos. Nothing about the *set* of
  fields changed: it is the same `notes` and `waitApprov` pair an admin may read and a shop owner may
  not. Reaches `dist/`. **The next release is therefore a major, 3.0.0**, and every consumer's
  `^2.0.0` range moves with it. Two test files import this subpath today
  (`marketplace-dev-authenticated-authorization`, `marketplace-dev-public-authorization`).
  ⚠️ A MongoDB *update operator* (`$set`, `$pull`) keeps the word — `src/encryption/` is untouched,
  and the three deterministic-encryption messages that name a refused operator still say "operator",
  because there they mean `$gt`, not a person.

- **`rotateKeygripKeys` carries a one-line `Stryker disable` and the argument behind it.** The floor on
  retirement is `>` and never `>=`: at two entries the key whose demotion instant the age test reads is
  the one the same call has just minted, so its age is zero and the test is false whichever comparison
  stands there. Reaches `dist/` — `removeComments` is off, so the comment ships. Behaviour unchanged.

### Added

- **Four account-lifecycle paths on `shopOwner` and on `user`** (`ADR-041`, `ADR-044`, `ADR-045`):
  `deletedBy` and `disabledBy` (plain `ObjectId`, deliberately **without** `ref` — the actor is an `admin`
  for an admin's decision and the account holder itself for a self-closure, and one path cannot point at
  two collections), `disabledReason` (**encrypted**, `ALGORITHM_RANDOM`) and `scrubbedAt` (plain `Date`).
  All four are optional here. Reaches `dist/`.
  ⚠️ **The five deterministic fields `ADR-029` pins are unchanged.** `ENCRYPTED_FIELDS_SHOP_OWNER` and
  `ENCRYPTED_FIELDS_USER` each gain exactly one `ALGORITHM_RANDOM` entry, which is queryable by nothing
  and equality-comparable by nothing; `test/encryption.test.mts` still asserts the same five deterministic
  paths, by whole-set equality.
  ⚠️ **A consumer cannot write these paths on `marketplace-common` alone.** The collection validators carry
  `additionalProperties: false`, so MongoDB refuses an insert or update naming an unknown path until
  `marketplace-db-setup`'s matching `collMod` migration has run against that database. *Reason mandatory
  when `disabled` is true* is that validator's `dependencies` clause, not a Mongoose `required`, so it is
  absent until the same migration lands.

- **`exports`: `./others/accountScrub`** (`ADR-041`). `buildAccountScrub(tier, accountId, at, disabled)`
  returns the one update a retention scrub is — a `$set` that overwrites every personal value a closed
  `user` or `shopOwner` holds, and a `$unset` that removes the rest — beside the placeholder constants it
  writes (`scrubbedEmail`, `SCRUBBED_PASSWORD_HASH`, `SCRUBBED_FIRST_NAME`, `SCRUBBED_LAST_NAME`,
  `SCRUBBED_TEXT`, `SCRUBBED_DISABLED_REASON`, `SCRUBBED_POSTAL_CODE`, `SCRUBBED_PROVINCE`,
  `scrubbedBirthDate`, `SCRUBBED_EMAIL_HOST`). Reaches `dist/`.
  ⚠️ **The values it hands back are plaintext and must reach MongoDB through Mongoose.**
  `fieldEncryptionPlugin` encrypts `$set` operands on the way past, including the whole-object `$set` on
  `personalData`; a caller that writes them with `Model.collection.updateOne` puts readable personal data
  into `binData` paths.
  ⚠️ **It overwrites, it does not delete.** `deleted`, `deletedBy`, `disabled`, `disabledBy` and
  `registeredAt` are in neither half — they are the record that a person held an account, which `ADR-041`
  keeps for ever. `login.email` moves to `deleted-<id>@invalid.local`, which is what frees the address for
  a fresh registration without removing a row.
  ⚠️ **The fourth argument is the document's own `disabled`, and the caller has to read it.**
  `disabledReason` is the one path that cannot simply be removed: the collection validator's
  `dependencies: { disabled: ['disabledReason'] }` clause refuses a suspended document that lacks it, and
  `disabled` survives a scrub by design. So the reason is `$set` to `SCRUBBED_DISABLED_REASON` on an account
  that was parked and `$unset` on one that never was. Passing the wrong value builds an update MongoDB
  rejects with `Document failed validation`, on exactly the accounts most likely to reach the sweep.
  ⚠️ **One caller by design: the day-30 sweep.** `ADR-046` made the retention window an *undo* window, so
  the registration confirm no longer reclaims an address early — a closed account still holding its address
  is handed back to the person rather than overwritten.

## [2.0.3](https://github.com/Axiumine/marketplace-common/releases/tag/v2.0.3) - 2026-08-28

**Recorded late.** `2.0.3` reached the registry with no entry on this page; it is written up here from the
diff rather than backdated silently. One new export, and one exception type that consumers see change.

### Added

- **`exports`: `./others/readKek`.** `readKek()` decodes `KEYGRIP_KEK` from base64 and returns the raw
  AES-256 key, or throws `KEYGRIP_KEK_MISMATCH` naming only the length it decoded to. It is the single
  decode site for the fleet, which is what makes the secrets-manager swap in `docs/PRODUCTION_HARDENING.md`
  §1 one line rather than three. Reaches `dist/`.

### Changed

- **`encryption`/`others/readKeygrip` decodes through `readKek` instead of inline.** The length check and
  its thrown message moved without alteration, so `loadKeygrip` and `readKeygrip` throw exactly what they
  threw in `2.0.2`. Reaches `dist/`.
  ⚠️ **Behaviour a consumer can see, once it adopts the export.** A caller that decoded the KEK itself with
  `Buffer.from(process.env.KEYGRIP_KEK as string, 'base64')` threw `ERR_INVALID_ARG_TYPE` when the variable
  was unset — `as string` lies to the compiler and `undefined` reaches `Buffer.from`. Calling `readKek`
  instead yields `KEYGRIP_KEK_MISMATCH`, the same refusal every other caller already got. The two reseal
  mutations in `marketplace-dev-admin-authenticated-resource` were switched over in the companion commit.
  ⚠️ **This does not make the KEK agree across processes.** `ADR-040` and the hardening page still own that;
  one decode site is not one resolution.

## [2.0.2](https://github.com/Axiumine/marketplace-common/releases/tag/v2.0.2) - 2026-08-28

**A rotation could log out the customers who asked not to be logged out.** `rotateKeygripKeys` measured its
retirement window from a key's own `createdAt`, when what the window has to cover is how long the key kept
*signing* — from its `createdAt` until the rotation that pushed it off index 0. On any cadence faster than
monthly the two diverge, and the rule dropped keys that were still verifying idle remembered sessions. The
release also carries the `@axiumine/koa-utils@7.1.0` devDependency bump that had been sitting unreleased.

### Fixed

- **`encryption/rotateKeygripKeys` — the retirement clock runs from demotion, not from minting.**
  `isTailRetirable` compares `now` against the `createdAt` of the key **in front of** the tail, which is the
  instant that demoted it — minting a key is the only thing that demotes another, so the instant was always
  in the record and `IKeygripKeyMaterial` keeps its three fields. A key minted on day 0 and demoted on day 7
  signed cookies alive until day 37; the old rule retired it on day 30. Reaches `dist/`.
  ⚠️ **Behaviour a consumer can see, in two places.** A rotation now keeps a key the previous build would
  have dropped, and `KEYGRIP_ROTATE_CAP` therefore refuses a sixth key in situations where the old rule made
  room — correctly: the room it made came out of somebody's session. The thrown message changed with it, to
  *"none of them stopped signing more than 30 days ago"*, and `marketplace-dev-admin-authenticated-resource`
  asserts it verbatim. `ADR-034` carries the amendment (2026-08-28).
- **`encryption/retireKeygripKey` — JSDoc only**, following the same correction. Reaches `dist/`.

### Changed

- **`devDependencies`: `@axiumine/koa-utils` `^7.0.0` → `^7.1.0`** (2026-08-28). Ships no change to `dist/`,
  and a consumer never installs this package's `devDependencies`. The `peerDependencies` range is left at
  `>=6` deliberately: nothing on a path this package compiles reaches the new capability, so narrowing it
  would refuse installs for no gain.
- **`test/redisScheme.test.mts` retargeted, not deleted.** Its three cases asserted that koa-utils *still*
  forced plaintext `redis://` on the cluster branch — a recorded "we cannot fix this" turns into a lie the
  moment the blocker disappears, which is what the assertion existed to catch. `7.1.0` removed it, all three
  failed, and six cases now assert the shape of the capability instead: no hardcoded scheme in the rootNodes,
  the flag carried into `defaults.socket`, the single-node URL routed through `resolveRedisUrl()`, the exact
  `=== 'true'` match, the `rediss`/`redis` choice, and the fail-closed refusal of a plaintext `REDIS_URL`.
  ⚠️ **R45 does not close** — nothing in the consuming workspace sets the flag and the dev Redis serves no
  TLS listener, so the leg is still cleartext, now by deployment rather than by upstream constraint.

## [2.0.1](https://github.com/Axiumine/marketplace-common/releases/tag/v2.0.1) - 2026-08-28

Two JSDoc blocks stop describing the production topology as undecided. `ADR-039` (2026-08-28) supersedes
`ADR-032` and writes it down, which made the shipped comments wrong the day it was accepted — and
`removeComments` is off, so those comments are in `dist/` on the registry rather than only in the repo.
**No exported symbol, signature, thrown string or runtime path changes**, and no control is relaxed:
ADR-039 §5 narrows the old standing rule instead of lifting it, so a network boundary may be cited as a
second layer and never as the whole argument. Both files now say that in the place they previously said
the topology was owed. A patch and not a `docs:` no-op purely because the tarball differs.

### Changed

- **`others/isIntrospectionBypassAllowed` — JSDoc only.** The paragraph that recorded the topology as owed
  by `ADR-032` now records `ADR-039`: Cloudflare at the edge, one application host behind a default-deny
  cloud security group, datastores on a separate host on a private segment the platform owner declares
  trusted. It then states what did **not** change — the `NODE_ENV` allowlist stays unconditional, which
  ADR-039 §5 requires by name — so the new boundary cannot be read as a licence to relax it.
  Reaches `dist/`.
- **`others/refreshRateLimit` — JSDoc only.** Same substitution on the hand-off paragraph, plus the same
  explicit *nothing is resized* clause for both buckets (named in ADR-039 §5). Reaches `dist/`.
- Of the three findings those two blocks named as bounded by one unknown, **only `R46` closed** with the
  ADR. `R45` — the Redis leg is still cleartext — is re-scored 🟢 Low and stays **open**, blocked on
  `@axiumine/koa-utils` hardcoding `redis://` in `createCluster`. Both blocks now say so, because a
  reader who saw only the closure would draw the wrong conclusion about the wire.

## [2.0.0](https://github.com/Axiumine/marketplace-common/releases/tag/v2.0.0) - 2026-08-27

One security predicate stops existing twice. `isIntrospectionBypassAllowed` was implemented here and
again in `@axiumine/koa-utils`, and two definitions of one allowlist can only ever agree by luck. This
release deletes the local implementation and forwards to the library's, which makes the library a
**runtime** requirement of that subpath rather than a compile-time convenience — the reason this is a
major and not a patch. Both halves of the change are the same breaking change, which is why they ship
together rather than costing a major twice.

### Changed

- **BREAKING — `others/isIntrospectionBypassAllowed` is now a re-export of
  `@axiumine/koa-utils/lib/isIntrospectionBypassAllowed`.** The `exports` key, the specifier and the
  returned value are all unchanged, so no consumer edits an import and the six `INTROSPECTION_CODE`
  comparison sites stay six. What changes is resolution: on `@axiumine/koa-utils` below `6.0.0` the
  subpath does not exist, so importing it now fails at load with `ERR_MODULE_NOT_FOUND` instead of
  silently returning a locally-computed answer. That is deliberate — a loud failure where the previous
  shape had none. The platform-side reasoning that has no upstream equivalent (`REQUIRED_ENV_VARS`
  interpolating an unset variable to `'undefined'`; ADR-022's wildcard bind and the topology ADR-032
  records as owed) stays in the JSDoc here.
- **BREAKING — `peerDependencies` narrows `@axiumine/koa-utils` from `*` to `>=6`.** `*` was satisfied
  by `5.9.0`, whose `verifyIntrospectionCode` compares `INTROSPECTION_CODE` with no environment gate at
  all; `6.0.0` added `isIntrospectionBypassAllowed` and made it that function's first statement. A
  consumer on npm 7+ or pnpm now fails to install against a version that would reopen the hole rather
  than installing it. `>=6` and not `^7`: `6.0.0` is what closed the gap, and `7.0.0`'s only API change
  — `uploadTemp` renamed `uploadTempImage` — is on no path this package compiles.
- `devDependencies`: `@axiumine/koa-utils` `^6.0.0` → `^7.0.0`, in step with the nine services
  (2026-08-27). A consumer never installs this package's `devDependencies`.
- The `Item` model and `IItemSchema` now say the absent `price` is permanent rather than deferred,
  citing ADR-038 (2026-08-27). Comment-only in `src/`, but `removeComments` is off, so this **does**
  reach `dist/` and the tarball differs from `v1.0.1`'s there.

### Security

- A consumer can no longer resolve a `@axiumine/koa-utils` old enough to make the
  `x-introspectioncode` authentication bypass reachable in production through the library's own
  middlewares. This platform was never exposed by it — no service here mounts those middlewares
  (`grep -rn "koa-utils/koa/middleware" BEs/*/src BEs/dev/*/src` finds only `verifySignedRefreshToken`)
  and its six comparison sites were gated by the environment allowlist — so this closes the hole for
  the **next** consumer, and for a service here that later swaps its handler for the published one.

## [1.0.1](https://github.com/Axiumine/marketplace-common/releases/tag/v1.0.1) - 2026-08-27

A directory rename in the workspace around this package, plus the repo plumbing that had accumulated
since `v1.0.0`. Exactly one string a consumer can observe changes; no behaviour does.

### Changed

- **The Redis-too-old error thrown by `assertHashFieldTTLSupport` now names `marketplace-docker-DBs/README.md`**
  rather than `docker-DBs/README.md`, following the rename of that directory. The message text is the only
  runtime-visible difference in this release — a consumer asserting on the old string must update it.
- JSDoc in `assertHashFieldTTLSupport`, `recordKeygripHolder` and `sessionKeys` follows the same rename.
  `removeComments` is off, so comments are emitted and this does reach `dist/`.
- The local npm mirror is opt-in and its host is read from yarn's own configuration rather than from a
  tracked file. Installs default to `registry.npmjs.org`; nothing in the repo names a mirror, and a
  clean/smudge filter keeps the mirror host out of the committed `yarn.lock`. `scripts/lockfile-registry-filter.sh`
  now builds the filter command from `git rev-parse --show-prefix`, so one script is correct both at a repo
  root and in a package tracked inside a larger repo. Repo plumbing — `.githooks/pre-commit`, `yarnrc`, docs.
  No change to `dist/`.
- Test coverage for the empty-hash identity path in `sessionKeys`, killing a surviving mutant. Test-only.
  No change to `dist/`.
- `CLAUDE.md` records the mandatory release flow — bump, changelog, merge, annotated tag, push, `yarn upload`
  — so a publish cannot skip a step. Documentation. No change to `dist/`.

## [1.0.0](https://github.com/Axiumine/marketplace-common/releases/tag/v1.0.0) - 2026-08-26

First published release: the whole shared library, extracted from the nine backend services that consume it.

### Added

- **Six Mongoose models**, one per collection — `Admin`, `ShopOwner`, `Company`, `User`, `Item`,
  `ItemCategory`. Field shapes are shared rather than repeated: `BaseAddressSchema`, `LoginSubDocSchema`,
  `ResetPwdSubDocSchema` and `EmailVerifySubDocSchema` are spread into the models that need them.
- **Interfaces split per model** — `IXxxModel` (the Mongoose `Document`, including instance methods such as
  `generateHashPassword`) against `IXxxSchema` (the plain data shape), so a caller that only describes data
  does not drag the document type in.
- **Redis session DTOs** for the three tiers, in three layers: `IRedisData…Common` → `…ForNode` →
  `IRedisData…`.
- **The three shared authorization-session helpers** — `resolveAuthorizationSession`,
  `findAccountForSession`, `refreshSessionTokens` — the identical body of the three
  `*-authenticated-authorization` services. The Redis client is a parameter typed as
  `ISessionReadStore` / `ISessionWriteStore`, not an import, so importing a model never requires a Redis
  install.
- **Session and refresh-token primitives**: `sessionKeys`, `hashSessionToken`, `sha256Hex`,
  `constantTimeEquals`, `newSessionLineage`, `assertRefreshLineage`, `recordReuseEvent`,
  `revokeSessionFamily`, `revokeAllSessionsForAccount`, `refreshRateLimit`, `sessionLifetime`,
  `throwRefreshRaceRetry`.
- **Tier as data, not as a permission enum** — `TIER` (`admin`, `shopOwner`, `user`), the `Tier` type,
  `isTier` for parsing a value read back out of Redis, and `assertTier` for the authorization decision.
  Role is which collection you authenticate against; there is no `role` field and no permission enum.
- **Entry guards** used by the resource services: `checkShopOwnerApproval`,
  `checkShopOwnerEmailVerified`, `checkUserAuthorizationDisDel`, `assertTurnstile`,
  `assertUnderRateLimit`, `isIntrospectionBypassAllowed`, `authBoundaryContract`, `adminOnlyFields`.
- **Field-level encryption for PII**: a Mongoose plugin (`fieldEncryptionPlugin`, `setupFieldEncryption`)
  with document, filter and update paths, a trie over the declared encrypted fields, ciphertext detection,
  and keygrip key material handling — `loadKeygrip`, `readKeygrip`, `watchKeygrip`, `wrapKeygripKeys`,
  `unwrapKeygripKeys`, `rotateKeygripKeys`, `retireKeygripKey`, `keygripFingerprint`,
  `recordKeygripHolder`.
- **GraphQL building blocks**: field-config fragments meant to be spread into a consumer's own type
  (`GraphQLBaseAddressFrag`, `GraphQLAddressFrag`, `GraphQLPositionFrag`, `GraphQLItemFrag`,
  `GraphQLItemCategoryFrag`) and the input types `GraphQLInputShopOwnerPersonalData`,
  `GraphQLInputUserPersonalData`, `GraphQLInputUserAddress`.
- **`Constants.mts`**, including `SALT_ROUNDS = 14` for `@node-rs/bcrypt`, and `sentryBeforeSend` for
  consumers that wire Sentry.
- **An exhaustive per-file `exports` map** — 83 entries, ESM only, `.mjs` runtime and `.d.mts` types.
  There is deliberately no `.` entry, no barrel, no `main` and no `types`: a file compiled into `dist/` is
  not importable until it is listed, and `test:contract` enforces that.

### Notes for consumers

- **ESM only.** `"type": "module"`, Node `^24.18.0`. The CJS build path exists in `package.json` but is
  broken and unused; only `build:esm` is the working build.
- **Peer dependencies are provided by the consuming service, not bundled**: `mongoose`, `mongodb`,
  `mongodb-client-encryption`, `graphql`, `@node-rs/bcrypt`, `@axiumine/koa-utils`, `reflect-metadata`,
  `dotenv`.
- **A consumer's mutation config must inline this package and `@axiumine/koa-utils`.** An externalised
  dependency is resolved by Node itself, which never consults vitest's mock registry, and the failure
  surfaces as a dry-run error with no mutant named.
