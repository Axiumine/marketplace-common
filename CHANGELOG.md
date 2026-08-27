# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

What "notable" means for a published library: an entry earns a place here if it changes what a consumer
sees — an `exports` entry, an exported symbol, a schema path, a peer dependency, a runtime behaviour. Repo
plumbing that never reaches the tarball (`files` is `["dist"]`) is recorded under the release it landed in,
marked as shipping no change to `dist/`, so that a reader deciding whether to publish can tell the two
apart without reading the diff.

## [Unreleased](https://github.com/Axiumine/marketplace-common/compare/v2.0.0...HEAD)

Nothing since `v2.0.0`.

## [2.0.0](https://github.com/Axiumine/marketplace-common/releases/tag/v2.0.0) - 2026-08-27

One security predicate stops existing twice. `isIntrospectionBypassAllowed` was implemented here and
again in `@axiumine/koa-utils`, and two definitions of one allowlist can only ever agree by luck. This
release deletes the local implementation and forwards to the library's, which makes the library a
**runtime** requirement of that subpath rather than a compile-time convenience — the reason this is a
major and not a patch. Both halves of the change are the same breaking change, which is why they ship
together rather than costing a major twice. Recorded as the two open items in
`docs/devprotocol/phase5/epics/E13.md` §7.

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
  and its six comparison sites were gated by E13-S11 — so this closes the hole for the **next**
  consumer, and for a service here that later swaps its handler for the published one.

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
