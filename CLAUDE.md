# marketplace-common

`@axiumine/marketplace-common` — shared library, published to npm, consumed by the nine backend services.
Building blocks only; nothing here listens on a port.

**Read parent first** — [`../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)

| Need | File |
|---|---|
| consumer-facing overview, import paths | [`README.md`](./README.md) |
| hooks, build, registry filter, test layout | [`REPO.md`](./REPO.md) |
| why the three authz svcs stay three | parent [`docs/decisions/authorization-service-consolidation.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/decisions/authorization-service-consolidation.md) |

Contents: Mongoose models & schemas (`src/models/`) · GraphQL type fragments & inputs (`src/schema/`) ·
interfaces, Redis DTOs, constants, auth helpers (`src/others/`, `src/models/MongoDBInterfaces/`).

⚠️ **Every edit here reaches a consumer one way and one way only: publish a release.** The package is
consumed by name from `registry.npmjs.org`, so an unpublished edit is invisible at every call site — and
hand-copying a build into somebody's `node_modules` is **banned** (platform owner, 2026-08-30). Bump,
changelog, merge, tag, push, `yarn upload`, then move each consumer's range: the nine steps in
§The release flow, all of them, every time. `deploy-local.sh` was the shortcut past that flow and is
**deleted** — a consumer that runs a build no lockfile names is a consumer nobody can reproduce.

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only**. It runs when the `pre-push` hook calls it and at no other time —
not to check a change, not before a commit, not on one file, not to confirm a survivor is fixed. Do not
invoke `stryker` directly either.

This does not weaken anything: the threshold stays 100, `pre-push` still blocks, and no survivor is ever
answered by lowering a number. What changes is **who starts the run**. A full pass costs tens of minutes
and holds the whole machine at 28 workers while it lasts, so an on-demand run is time taken from the
person waiting for the work.

Go through the package script if a run is ever authorised — never `npx stryker run`, which skips whatever
the script sets up around it.

A survivor is answered by writing the test it names and letting the next push run the gate. If a mutant
has to be reproduced first, apply it by hand in the source and run `yarn test` — that is seconds, it
names the tests that should have failed, and it costs nobody the machine.

## The six models

Six models, six collections in
[`marketplace-db-setup`](https://github.com/Axiumine/marketplace-db-setup): `Admin` (platform admin),
`ShopOwner` (the business owner), `Company` (the registered company a ShopOwner owns —
`Company.idShopOwner` required ObjectId, `Company.deleted` optional date, soft delete like `ShopOwner`),
`User` (the end customer), and the catalogue pair `Item` / `ItemCategory`.

⚠️ **A company IS the shop.** No `shop` model, no `shop` collection, and neither is coming. The chain is
`shopOwner ──idShopOwner──> company ──idCompany──> item`, and everything a storefront renders about a shop
hangs off `Company` — which is what `publicName`, `slug`, `description` and `published` are doing on a
collection whose other fields describe a legal entity to a registrar.

`published` is the only **required** one of those four, and the only field on any model here whose
requiredness was earned rather than declared: adding a required field to a *populated* collection takes
three steps — widen, backfill, narrow — because `collMod` does not re-validate stored documents. The other
three stay optional for the same reason `Company.taxCode` does. `published: true` additionally implies a
`slug` and a `publicName`, and that rule lives in the collection's `$expr` clause, not here — see
`20260804010000-alter-company-public`.

`User` is the newest and the one to read before copying anything. It mirrors `ShopOwner` because role is
*which collection you authenticate against*, not a field — same `LoginSubDocSchema`, `ResetPwdSubDocSchema`,
`EmailVerifySubDocSchema`, same `deleted`/`disabled`. Three divergences, all deliberate and all argued at
their definition: `addresses` is an **array** where the shop owner has one embedded address,
`defaultAddress` is a top-level pointer into that array, and there is **no `waitApprov`** — a customer
self-serves with nothing to approve, so the only gate is `emailVerify.valid`. A shop owner who
self-serves through `shopOwnerRegister` carries both gates; one an Admin created carries neither.

⚠️ **`personalData` used to be the fourth and is not one any more.** It is optional on both models since
2026-08-12: both sign-up paths take an email and a password and nothing else. What still differs
is what happens next — a customer may never fill it in, a shop owner is expected to before they trade.

⚠️ **`UserAddressSubDocSchema` is the one address schema here that keeps its `_id`.** Every other one is
`{ _id: false }`, because the collection validators declare their embedded address
`additionalProperties: false` and an unasked-for `_id` fails the write outright. This one is an array
element that `defaultAddress` names by id, so the `user` validator lists `_id` in the element's `required`.
`BaseAddressSchema` is `{ _id: false }` and `.clone()` carries the option across, so the path is declared by
hand with `auto: true`.

⚠️ **`defaultAddress` is enforced by MongoDB, not by this package.** The `user` collection validator is
`$and: [ {$jsonSchema}, {$expr} ]` — a validator is a query expression, and `$jsonSchema` is only one
admin you may put in one — and the second clause refuses a pointer that is neither absent nor present in
`addresses[]._id`. Two consequences for every consumer: setting the default is a single atomic `$set` with
no "clear the others first" window, and **removing the default address must `$unset` the pointer in the
same update** or the write is rejected. See `marketplace-db-setup/lib/schemas/user.js` for the full
argument.

⚠️ **`Item` and `ItemCategory` are one domain-neutral catalogue.** Nothing here may presume what is sold;
reintroducing a per-type model would restore exactly the duplication a single catalogue exists to avoid.

- **`Item` has no `price`, and never will.** Cart, order, delivery and payment are **permanently out of
  scope** on this platform — ADR-038, the platform owner's decision of 2026-08-27 — so a price would be a
  guess at a currency, a precision, a VAT treatment and a discount model at once, with nothing that will
  ever resolve it. It arrives with nothing: there is no ordering tier coming, and a display-only price was
  offered and refused the same day. Adding the field contradicts an accepted ADR.
- **`ItemCategory`'s two-level cap is enforced in neither this model nor the collection validator**, and
  cannot be: "my parent must itself be top-level" reads a *second* document, and a Mongoose path and a
  MongoDB validator each see exactly one. `itemCategoryAdd` / `itemCategoryUpdate` in the Admin resource
  service are the only place it holds. `idParent` looking unconstrained here is not permission for a third
  level.
- ⚠️ **`ItemCategory.position` is a sort ordinal**, unrelated to the GeoJSON `position` on `Company.address`
  and `User.addresses[]`. Same name, no shared shape, and `GraphQLItemCategoryFrag` sits in the same
  directory as `GraphQLPositionFrag` — spreading the wrong one compiles and answers coordinates for a
  catalogue sort order.

**This is still the extension seam**, it has just moved: a new *kind* of thing is a new model + its
`exports` entry + a migration, started from `Company.mts`. A new product type is an `itemCategory`
**document** and needs no code here at all.

## Critical: the `exports` map

`package.json` has an explicit per-file `exports` map. A file compiled into `dist/` is **not
importable by consumers unless it is listed there**. Adding a model, interface, fragment or input that other
services import **requires a matching entry** — `{ "import": "./dist/.../X.mjs", "types":
"./dist/.../X.d.mts" }`. Most common mistake in this repo; `test:contract` guards it. Note **`.d.mts`**, not
`.d.ts`: NodeNext `.mts` sources compile declarations to `.d.mts` and the build does not rename them.

⚠️ **The map is exhaustive and there is no `.` entry — deliberately.** No barrel exists, none is wanted, so
`import x from '@axiumine/marketplace-common'` is `ERR_PACKAGE_PATH_NOT_EXPORTED`. `package.json` carries
no `main` and no `types`. **Do not re-add either without adding the `.` export first** — a root entry field
and a missing `.` key are contradictory by construction, and under Node ESM `exports` wins once present, so
the contradiction is silent.

## Source conventions (NodeNext ESM)

- Source files are **`.mts`**; compiled output is **`.mjs`**.
- **Imports must carry the `.mjs` extension**, even when importing another `.mts` source (NodeNext).
- Imports use the `tsconfig.json` path aliases (`@MongoDB/*`, `@MongoDBInterfaces/*`, `@others/*`,
  `@GraphQL/*`). `typescript-transform-paths` rewrites them to relative paths at build time, via `tspc`
  (ts-patch), **not plain `tsc`** — so dist needs no runtime alias resolver.

## Architecture patterns

**Models are thin; field shapes are shared.** `Company.mts` and `ShopOwner.mts` spread `BaseAddressSchema`
rather than repeating street/postalCode/city/province, and both spread `LoginSubDocSchema` /
`ResetPwdSubDocSchema` with `Admin.mts`.

**Interfaces are split per model:** `IXxxModel` (Mongoose `Document`, includes methods like
`generateHashPassword`) vs `IXxxSchema` (plain data shape). Reusable sub-document schemas live in
`src/models/MongoDB/sub/`, interfaces in `src/models/MongoDBInterfaces/sub/`.

**Redis DTOs use 3-layer inheritance:** `IRedisData…Common` (base) → `…ForNode` variant / concrete
`IRedisData…` (adds `_id`). Under `src/others/Redis/`.

**GraphQL fragments are plain field-config objects** meant to be spread into a consumer's full GraphQL
type — not standalone `GraphQLObjectType`s.

**Peer dependencies** (`mongoose`, `graphql`, `@node-rs/bcrypt`, `@axiumine/koa-utils`, `reflect-metadata`,
`dotenv`) are provided by the consuming service, not bundled.

⚠️ **`@sentry/node` and `uuid` are devDependencies and must stay that way.** Neither is imported by anything
under `src/`; they exist because `@axiumine/koa-utils` peer-requires both and this package's suites load the
koa-utils modules that need them. Promoting either would put Sentry behind every consumer of a Mongoose
model — exactly what `refreshSessionTokens` takes `captureException` as a parameter to avoid.

Password hashing uses `@node-rs/bcrypt` with `SALT_ROUNDS = 14` (`src/others/Constants.mts`).

### The three authorization-session helpers

`resolveAuthorizationSession`, `findAccountForSession` and `refreshSessionTokens` (all `src/others/`) are
the shared body of the three `*-authenticated-authorization` services. **Those services stay three** — three
repos, three ports, three crash domains — and this package holds only what is identical in all three.
Reasoning and rejected alternatives: the decision doc named above.

|Stays in the service|Reason|
|---|---|
|the Koa middleware wrapper|it reads that service's own `IContext*`, and `verifySignedRefreshToken` needs the raw Koa ctx|
|the model and the projection|`ShopOwner` projects three onboarding fields a customer has no equivalent of|
|the `TIER.*` constant it asserts|a svc that could be told its own tier by a caller asserts nothing|

Four design points that look like accidents otherwise:

- **The Redis client is a parameter, not an import.** `ISessionWriteStore` (`src/others/refreshSessionTokens.mts`)
  declares eight commands — `hSet`, `expire`, `del`, `sAdd`, `incr`, `ttl`, `hExpire`, `hDel` — and nothing
  more. `ISessionReadStore` (`src/others/resolveAuthorizationSession.mts`) is declared `extends
  ISessionFamilyStore`, the interface `revokeSessionFamily` (`src/others/revokeSessionFamily.mts`) owns, rather
  than taking a second store parameter: `revokeSessionFamily` needs the family key (`sMembers`, `del`) and the
  resolver needs to read a session, so extending gives the resolver one injection point instead of two, both
  backed by the same `redisClient`. `ISessionFamilyStore` in turn extends `IReuseEventStore`
  (`src/others/recordReuseEvent.mts`, `lPush`/`lTrim`/`expire`) for the same reason. Importing `redisClient`
  from koa-utils would drag the `redis` types in and make a Redis install a precondition for importing a
  Mongoose model.

  The set has grown before and will again: the session lineage added the family `sAdd`, the reuse tombstone (reusing the
  existing `hSet`/`expire`), and the mint-rate `incr`/`ttl`. Treat any number stated here as a snapshot, not
  a fact — re-read the interface declarations above before relying on a count.
- **`TAuthorizationSession<TAccountData>` is the declared type of `ctx.state.user` in all three services.**
  `TAccountData` is exactly the tier's `IRedisData…Common` —
  which is why those three DTOs got `exports` entries. Tying context state to the helper's return type is
  what lets `ctx.state.user = session` compile with no cast and stops the two drifting.
- **`ISessionAccountModel<TAccount>` is structural, not `Model<TAccount>`.** `Model<T>` is invariant in `T`,
  so one generic typed against it would take none of the three document types without a cast per call site.
  `PromiseLike`, not `Promise`: mongoose returns a `Query`, a thenable with no `[Symbol.toStringTag]`.
- **`resolveAuthorizationSession` never answers without a session.** Its return type is
  `TAuthorizationSession<TAccountData>` and not a union with `null`: a refresh token that resolves to no live
  session is refused with the 498 an expired one earns, so a caller has no empty-session case to handle.

⚠️ **A consumer's `vitest.mutation.config.mts` must inline this package *and* `@axiumine/koa-utils`.** An
externalised dependency is loaded by Node's own resolver, which never consults vitest's mock registry — so a
`vi.mock('@axiumine/koa-utils/lib/tokens')` in a service's test stops intercepting the moment the import
that needs faking is made from inside `dist/` here instead of from the service's `src/`. It fails as a
*dry-run* failure with no mutant in sight. The three service configs already carry both entries; a fourth
consumer of these helpers needs them too.

## Traps in the tests

- **Adding a runtime file drops coverage below 100 → `test:cov` fails.** Add a matching test.
- ⚠️ **Nothing type-checks `test/integration/`.** `tsconfig.typecheck.json` includes `src/**/*.mts` and
  `test/types/**/*.test-d.mts` and stops there, and vitest strips types without checking them, so a type
  error in that suite surfaces nowhere. Verify a type you add there by pointing a throwaway config at the
  directory.
- ⚠️ **Do not add `ignoreStatic` to `stryker.config.mjs`.** A mutant in module-load-time code can throw
  during vitest's file-collection phase, before any test runs; Stryker then cannot attribute the failure to
  a test and reports it **Survived** even though the suite did fail. That artifact looks exactly like a real
  survivor and invites `ignoreStatic` as the fix — which instead deletes whole classes of mutant from the
  run and hides genuine gaps. The correct fix is to import the module **dynamically inside a `beforeEach`**, so the throw lands inside a
  test that can fail. `beforeEach`, not `beforeAll`: a throw in `beforeAll` marks dependent tests *skipped*
  rather than failed, and the vitest-runner does not count a skipped test as a kill either.

Assertions that pass while the code is wrong, and what replaces them:

|Weak|Why it survives|Use instead|
|---|---|---|
|`toBeDefined()` on a schema path|a mutated `{}` field spec makes Mongoose infer a **Mixed** path, still defined|`.instance` / `.isRequired`|
|`toBeTruthy()`|almost any mutant is still truthy|`toBe(exactValue)`|
|`rejects.toThrow()`|passes on *any* throw, including the wrong one|`rejects.toThrow(SpecificError)` + message|
|`toHaveBeenCalled()`|blind to mutated arguments|`toHaveBeenCalledExactlyOnceWith(...)`|
|checking some object keys|blind to added/removed keys|`toEqual` + `Object.keys(x).toHaveLength(n)`|

## Registry traps

⚠️ **`yarn upload` pins `--registry=https://registry.npmjs.org/`.** Yarn 1 exports whatever registry it is
configured with to child processes as `npm_config_registry`, so on a machine pointed at a local mirror a bare
`npm publish` through yarn publishes *to that mirror* — silently, and with a success message.

**Installs come from `registry.npmjs.org`, and nothing tracked in this repo names a mirror.** A mirror is
opt-in, configured the ordinary way — gitignored `.yarnrc`, or `~/.yarnrc` — and there is no second switch:
`yarn install` (`prepare` → `hooks:install`) reads that same `npm_config_registry` and records the host, and a
clean/smudge filter keeps it out of the committed `yarn.lock`. Point yarn back at public npm and the next
install tears the filter down again. How to opt in and out, and how to verify either: [`REPO.md`](./REPO.md).

## Version control

**git**, branch `main`, remote `origin` → `git@github.com:Axiumine/marketplace-common.git` (**public**,
GPL-3.0-or-later).

This is **the one repo that may be committed, merged, pushed and published without asking.** Every other
repo in the workspace is push-on-request.

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`.
- Merged → delete branch: `git branch -d <slug>`, in the same breath as the merge. `-d` only, `-D` never.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → add the
  missing assertion.
- Tabs, not spaces. English only. Node `^24.18.0`, yarn classic.

## ⚠️ Publishing a release — the mandatory flow

Every published version follows these steps **in this order**, and all of them. Skipping one is what
produces a tag pointing at no release, a `dist/` that disagrees with its own version number, a changelog
that still claims the tarball is byte-identical to the last one, or a silent publish to a local mirror.

1. **Decide the bump from what reaches `dist/`, not from the size of the diff.** `files` is `["dist"]`, so
   repo plumbing ships nothing at all. But `removeComments` is off, so JSDoc *is* emitted — a comment edit
   in `src/` does change the tarball. A changed thrown-error string is consumer-observable: patch at least.
2. **Branch.** `git switch -c chore/release-<version>`. Never on `main`.
3. **Bump `package.json`** — `npm version <version> --no-git-tag-version`. The flag is not optional: the
   tag belongs on `main` after the merge, and letting npm create it here strands it on the branch.
4. **Update `CHANGELOG.md` in the same commit.** Move `[Unreleased]` into a new `[<version>]` section dated
   today, re-point the `[Unreleased]` compare link at the new tag, and leave `[Unreleased]` empty. Mark every
   entry that ships no change to `dist/` as such — that is what lets the next reader tell a release worth
   publishing from one that only moved plumbing.
5. **Commit, merge to `main` with `--no-ff`, delete the branch** (`git branch -d`, in the same breath).
6. **Tag `main`: annotated, message = the version.** `git tag -a v<version> -m "v<version>"`. Lightweight
   tags are not used in this repo.
7. **Push commit and tag together** — `git push origin main --follow-tags`. `pre-push` runs the full gate
   (semgrep → engines → lint → coverage → mutation). That hook is the only sanctioned mutation run.
8. **Publish with `yarn upload`, never a bare `npm publish`.** See §Registry traps: `yarn upload` pins
   `--registry=https://registry.npmjs.org/`, and on a machine pointed at a local mirror a bare publish goes
   to the mirror instead and still prints success.
9. **Verify, then bump consumers deliberately** — `npm view @axiumine/marketplace-common version`. Consumers
   resolve through their own `yarn.lock`, so a new version reaches none of them until that lockfile is
   updated. That is separate work in each consuming repo, and it is not part of this flow.

⚠️ **There is no local shortcut, and there is no longer a script that offers one.** `deploy-local.sh`
copied a fresh build straight into every consumer's `node_modules`: no version, no lockfile entry, nothing
another machine or CI could reproduce, and a `yarn install` in any consumer silently put the last published
build back. It is deleted (platform owner, 2026-08-30). An edit that a consumer needs is an edit worth a
version number — publish it. A patch release costs nine steps and no consumer is ever left running a build
that exists on one machine.

## Commands

```bash
yarn build          # ESM build only (tspc → dist/). This is the working build.
yarn lint           # eslint --fix . && prettier --write .      (lint:check = read-only)
yarn prepare        # hooks:install + rm -rf dist && yarn build (runs on install/publish)
yarn hooks:install  # core.hooksPath .githooks + the yarn.lock registry filter
yarn upload         # npm publish --registry=https://registry.npmjs.org/
yarn test           # unit tests once      (test:watch for watch mode)
yarn test:cov       # unit + coverage, fails under 100 on any metric
yarn test:contract  # yarn build && exports-map + dist smoke
yarn test:int       # real MongoDB via MONGO_TEST_*
yarn test:types     # compile-time expectTypeOf contracts
yarn test:mutation  # stryker, gated at 100
yarn semgrep        # semgrep SAST, readable report  (semgrep:ci for the pre-push gate)
yarn test:all       # cov + contract + int + types
```

⚠️ **`yarn build:all` / `prepare:all` are broken** — `build:cjs` references a `tsconfig.cjs.json` that does
not exist. Only the ESM path works.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **marketplace-common**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/marketplace-common/context` | Codebase overview, check index freshness |
| `gitnexus://repo/marketplace-common/clusters` | All functional areas |
| `gitnexus://repo/marketplace-common/processes` | All execution flows |
| `gitnexus://repo/marketplace-common/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): marketplace-platform** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the project root: `node .gitnexus/run.cjs group list`, `node .gitnexus/run.cjs group sync <name>`, `node .gitnexus/run.cjs group impact <name> --target <symbol> --repo <group-path>` (the `.gitnexus/run.cjs` path is repo-root-relative).

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
