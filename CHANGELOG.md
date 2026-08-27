# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

What "notable" means for a published library: an entry earns a place here if it changes what a consumer
sees — an `exports` entry, an exported symbol, a schema path, a peer dependency, a runtime behaviour. Repo
plumbing that never reaches the tarball (`files` is `["dist"]`) is recorded under the release it landed in,
marked as shipping no change to `dist/`, so that a reader deciding whether to publish can tell the two
apart without reading the diff.

## [Unreleased](https://github.com/Axiumine/marketplace-common/compare/v1.0.0...HEAD)

Nothing consumer-facing. `src/` and `package.json` are untouched since `v1.0.0`, so the tarball this
would build is byte-identical to the published one and there is nothing to release yet.

### Changed

- The local npm mirror is opt-in and its host is read from yarn's own configuration rather than from a
  tracked file. Installs default to `registry.npmjs.org`; nothing in the repo names a mirror, and a
  clean/smudge filter keeps the mirror host out of the committed `yarn.lock`. Repo plumbing —
  `scripts/lockfile-registry-filter.sh`, `.githooks/pre-commit`, `yarnrc`, docs. No change to `dist/`.
- Test coverage for the empty-hash identity path in `sessionKeys`, killing a surviving mutant. Test-only.
  No change to `dist/`.

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
  `assertUnderRateLimit`, `isIntrospectionBypassAllowed`, `authBoundaryContract`, `operatorOnlyFields`.
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
