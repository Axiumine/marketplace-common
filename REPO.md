# Repository mechanics

How this package's git plumbing, build, registry filter and test layout behave, and why. Nothing here
changes what you write — it explains what happens when you build, commit, push or publish. [`CLAUDE.md`](./CLAUDE.md)
carries the rules; [`README.md`](./README.md) is the consumer-facing document.

## The hooks

`.githooks/pre-push` is a blocking seven-step gate: `yarn semgrep:ci` (Semgrep SAST over `src/`, rules
vendored under `semgrep/`, pinned image, `--network none`), trivy (dependency advisories over `yarn.lock`,
HIGH and CRITICAL, production tree only), `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), `yarn typecheck` (`tsconfig.test.json` — src/, test/ and the
vitest configs, no emit), `yarn test:cov` (100% on every metric), `yarn test:mutation`
(Stryker, `thresholds.break: 100`), then a Qodana scan via `./qodana.sh`. Roughly a minute in total.

⚠️ **`yarn test:cov` is two gates, not one.** vitest runs, and then `scripts/coverage-audit.mjs` proves the
report the thresholds were computed over actually contains every git-tracked file `coverage.include` gates.
Without that second half a 100% threshold says nothing about a file no suite ever imported, which is absent
from the report rather than sitting at 0% (`RISK_REGISTER` R07). This repo exempts nothing and therefore
ships no `coverage-exempt.txt`: every one of its source files is in the report, and a new one that is not
takes the run red until it has a test.

Semgrep and trivy are first because they are the cheap ones — about three seconds and, once the
vulnerability database is pulled, under one — so a rule violation or an advisory is reported before
anything slow runs. Both are push-only, like mutation: they need Docker and a pinned image, and push is
the layer that sees the merge commit anyway. Bypass for a Docker or network outage, never for a finding:
`SKIP_SEMGREP=1 git push`, `SKIP_TRIVY=1 git push`.

⚠️ **Trivy is there because Qodana's dependency check does not report.** The inspection Qodana runs is
`VulnerableLibrariesLocal`, an offline heuristic that queries no advisory feed and answers zero on every
repo here; the class that does query one is in the image and in no profile. This repo is the one whose
advisories reach every other — nine services install it by package name — so an unchecked transitive
dependency here is an unchecked dependency fleet-wide.

`.githooks/pre-commit` is five gates, cheapest first: the secret guard (staged secret paths, staged
high-entropy values), `yarn lint:check`, `yarn typecheck`, `yarn test:cov`, then a full Qodana scan. The
last four run **only** when the staged paths can move a verdict — `src/`, `test/`, `semgrep/`,
`.githooks/`, `package.json`, `yarn.lock`, `qodana.yaml`/`qodana.sh`, the vitest/tsconfig/stryker configs
and, since the lint gate exists to read them, `eslint.config.js`/`.prettierrc`/`.prettierignore`, and
`scripts/coverage-audit.mjs`/`coverage-exempt.txt`, which are the coverage file-count gate itself — so a
docs-only commit skips them. Those last four were missing from the filter for as long as lint was ungated, which is how a
run of commits widening the eslint `ignores` block each passed with no gate run at all.

### Why the mutation gate is hook-only

This does not weaken anything: the threshold stays 100, `pre-push` still blocks, and no survivor is ever
answered by lowering a number. What changes is **who starts the run**. A full pass costs tens of minutes
and holds the whole machine at 28 workers while it lasts, so an on-demand run is time taken from the
person waiting for the work.

Go through the package script if a run is ever authorised — never `npx stryker run`, which skips whatever
the script sets up around it.

A survivor is answered by writing the test it names and letting the next push run the gate. If a mutant
has to be reproduced first, apply it by hand in the source and run `yarn test` — that is seconds, it
names the tests that should have failed, and it costs nobody the machine. The hard ban on running this
gate by hand lives in [`CLAUDE.md`](./CLAUDE.md).

Ahead of all of them each hook selects node by itself, reading `engines.node` and sourcing nvm, because
git runs each hook in its own process — the switch one hook makes is gone before the next one starts — and
this machine's default node is older than the pin while yarn's engine check is a hard failure.

Coverage runs at commit time despite pre-push already gating it, because Qodana scores coverage from
`coverage/lcov.info` and `qodana.sh` regenerates that with `yarn test:cov || true`, deliberately swallowing
a threshold miss. The hook runs the suite itself with the exit code honoured, then hands the scan
`SKIP_TESTS=1` so it is not run twice. Mutation is *not* re-run at commit time.

A missing prerequisite — docker, the `qodana` CLI, the linter image, `QODANA_TOKEN`, the wrong node —
**blocks and prints the fixing command** rather than warning and continuing.

Bypasses: `git commit --no-verify` (everything) or `SKIP_QODANA=1 git commit` (scan only). Both are gate
removals; see [`CLAUDE.md`](./CLAUDE.md) for when they may be used.

## Why Qodana runs in both hooks

**`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit` only — so in the
branch → commit → merge → push flow the merge commit, the one revision that actually reaches origin, is
the single commit no pre-commit scan ever sees. Two individually clean branches can merge into a tree that
is not.

Qodana Cloud also files every report under the branch it was produced on, and pre-commit always runs on the
feature branch before the commit exists, so a repo gated only there can never produce a `main`-tagged
report — which is why `main` was not selectable as this project's cloud default branch until a scan finally
ran from it. pre-push runs after the merge, standing on main.

All ten repos with these hooks (this one and the nine services) carry both in this shape; the services'
`pre-commit` was copied from here.

## What the lint gate used to miss

`@axiumine/eslint-config-be` matches `src/**` and nothing else, and eslint answers a path that matches no
`files` glob by checking zero rules and exiting 0 — success, not "no config found". So `yarn lint:check`
was green while **every file under `test/`, all seven `vitest.*.mts` configs, `eslint.config.js` and
`stryker.config.mjs` were unread**; `eslint --print-config <any test file>` printed `undefined`. The seven
services had carried a `test/**/*.mts` block for a while and this package never got one.

Both holes are closed, and closing them surfaced three real errors sitting in the tests. **When adding a
block here, verify it resolves** — `npx eslint --print-config <file>` should report ~400 rules, never
`undefined`.

`yarn lint:check` is warning-free too. The last two were `@typescript-eslint/no-explicit-any` on the
seeded-id tracker in `test/integration/models.int.test.mts`, once recorded as not worth fixing on the
grounds that tightening `Model<any>` meant a cast at each of twelve call sites. It did not: the tracker
calls one method on what it is handed, so a structural
`interface DeletableModel { deleteOne(filter: { _id: Types.ObjectId }): PromiseLike<unknown> }` takes all
six models with no cast anywhere. `Model<T>` is invariant in `T`, which is why `any` looked like the only
option — the six document types are unrelated.

## The build

`yarn build` is a bare `tspc` call: ESM only, `tsc` writes the final layout itself, no post-processing.

`build:esm` used to emit into `dist/esm/`, rename `*.js` → `*.mjs`, then `cp -R dist/esm/* dist/`. Both
halves were wrong. The rename was dead code: the sources are `.mts` under `module: NodeNext`, so `tsc`
already emits `.mjs` and the `find` matched nothing. The copy was a live bug: `.mjs.map` files carry a
*relative* `sources` path, so moving the files up one level after the maps were written left every path one
level too high — `../../../src/…` read from `dist/others/` points above the repo — and vitest reported
"Sourcemap for … points to missing source files" for all 27 runtime modules on every contract run.
`outDir`/`declarationDir` are now `./dist`.

`build:cjs` still carries the same `cp -R dist/cjs/* dist/` shape, and `yarn build:all` / `prepare:all` are
broken anyway: `build:cjs` references `tsconfig.cjs.json`, which does not exist. Whoever repairs that path
must drop the copy too, or the maps break again in the CJS half.

`inlineSources: true` goes with all this: `files` publishes `dist/` alone, so a map that merely *names*
`../../src/x.mts` names a file no consumer has. The sources are embedded, which is what makes the shipped
maps resolvable off this checkout — about 36 KB across the whole of `dist/`.

## Registry: public npm by default, a local mirror only if you ask

### Publishing pins the registry too

⚠️ **`yarn upload` pins `--registry=https://registry.npmjs.org/`.** Yarn 1 exports whatever registry it is
configured with to child processes as `npm_config_registry`, so on a machine pointed at a local mirror a bare
`npm publish` through yarn publishes *to that mirror* — silently, and with a success message. The rest of
this section is the same fact from the install side.

Every clone installs from `registry.npmjs.org`, and its `yarn.lock` keeps the public URLs — on the first
install and on every one after it. Nothing below runs unless a machine explicitly opts in, and that is the
default the whole section exists to protect.

The committed lockfile names `registry.npmjs.org` throughout, and that is the host to keep. Yarn 1's *own*
default is `registry.yarnpkg.com`, npm's CDN alias, so re-resolving the lockfile from scratch with stock yarn
config rewrites all 510 lines to it. Both are public and both install for everyone, so the pre-commit gate
accepts either rather than rejecting a contributor who never went near a mirror.

Installing through a local mirror is what needs machinery. Yarn 1 writes **absolute** tarball URLs into every
`resolved` line of `yarn.lock`, so a mirrored install would put a host that resolves on one network only into
510 lines of a lockfile this repo publishes on a public GitHub, and `yarn install` would then fail for every
clone that cannot reach it. The npm tarball is unaffected (`files: ["dist"]` keeps `yarn.lock` out of it);
clones are not.

Three parts:

|Part|Does|
|---|---|
|`scripts/lockfile-registry-filter.sh`|`clean` (worktree → git) rewrites mirror → npmjs; `smudge` (git → worktree) rewrites npmjs → mirror; `install` reads the mirror out of yarn, records it, writes the filter into `.git/config` and reconciles the current checkout; `uninstall` restores the public URLs and removes both|
|`.gitattributes`|`yarn.lock filter=yarnlock-registry` — binds the filter to the one file|
|`.githooks/pre-commit`|blocks any commit whose **indexed** `yarn.lock` resolves against a non-public host — the two public registries pass, everything else blocks|

### Opting in

**There is no switch of this repo's own to set.** Point yarn at the mirror the way you would for any project
— the gitignored `.yarnrc`, or `~/.yarnrc` for every project on the machine — and install:

```bash
printf 'registry "http://<your-mirror>/"\n' > .yarnrc   # this checkout only
yarn config set registry 'http://<your-mirror>/'        # or every project, ~/.yarnrc
yarn install
```

`install` takes the host from **yarn itself**: yarn 1 exports the effective registry to every script it runs,
this one included (`prepare` → `hooks:install`), as `npm_config_registry`. That value already folds in
`.yarnrc`, `~/.yarnrc` and a `--registry` flag, so a mirror configured *globally* — which no repo-local
setting could see — is caught as well. A second variable naming the same host would be a second source of
truth, and the case it would miss is exactly the dangerous one: yarn on a mirror, the filter unaware, the LAN
host in the index.

The host is then written to `yarnlock-registry.mirror` in `.git/config`, with the filter next to it. git never
clones `.git/config`, so the choice is per-checkout and reaches nobody else.

⚠️ **`clean` and `smudge` read the host back from `.git/config`, never from yarn.** git runs them as its own
subprocesses, from whichever shell happened to touch the file — an IDE checkout, a hook's `git add`, a rebase
— and none of those carry yarn's environment. Reading it from there would let one direction fire while the
other did not, and the two disagreeing is precisely the state that puts a mirror host into a public lockfile.
Hence a recorded copy, refreshed on every install.

`z-ram.sh` asks yarn the same question, with `yarn config get registry`, and **refuses to run** on a public
answer: it wipes `node_modules` before installing, so with no mirror in play it would do nothing but refill it
from npmjs over the internet.

### Opting back out

Point yarn back at the public registry (remove `.yarnrc`, or `yarn config delete registry`) and run
`yarn install`. `install` sees a public `npm_config_registry`, and a mirror recorded earlier is now stale — so
it tears the filter down for you rather than leaving `smudge` writing a host into `yarn.lock` that nothing
fetches from any more. `./scripts/lockfile-registry-filter.sh uninstall` does the same thing directly.

Either way the worktree is rewritten back to the public URLs *before* the config is dropped — the other order
leaves the mirror host in the worktree with the filter that would have stripped it already gone, so the next
`git add` stages it and the pre-commit gate blocks the commit.

Running the script **by hand** outside yarn is the one case with no `npm_config_registry` to read: no
information, so no opinion — whatever is recorded stays.

`required` is deliberately `false`: a missing script must degrade to passthrough, not break checkout.

A fresh clone lands the public URLs *before* the filter exists, and git will not re-smudge a file it already
considers up to date — `install` therefore rewrites `yarn.lock` in place once, by hand. If the worktree lock
ever disagrees with what you expect, `touch yarn.lock && git add yarn.lock` re-runs `clean` on it.

Verify both directions at any time. An empty first line is the answer on a machine that never opted in — there
is no filter and nothing to check:

```bash
MIRROR="$(git config --get yarnlock-registry.mirror)"   # empty → public npm, no filter, stop here
grep -cF "$MIRROR" yarn.lock                            # worktree: expect all of them
git show :yarn.lock | grep -c 'registry\.npmjs'         # index: expect the same count
git show :yarn.lock | grep -cF "$MIRROR"                # index: expect 0
```

Only this repo has the mechanism. The other sub-repos commit whatever host their lockfile was resolved
against; `marketplace-services-status` has no lockfile at all. The same three files fix each of them, and are the thing
to port rather than reinvent.

## Publishing a release — the mandatory flow

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
8. **Publish with `yarn upload`, never a bare `npm publish`.** See §Publishing pins the registry too above:
   `yarn upload` pins `--registry=https://registry.npmjs.org/`, and on a machine pointed at a local mirror a
   bare publish goes to the mirror instead and still prints success.
9. **Verify, then bump consumers deliberately** — `npm view @axiumine/marketplace-common version`. Consumers
   resolve through their own `yarn.lock`, so a new version reaches none of them until that lockfile is
   updated. That is separate work in each consuming repo, and it is not part of this flow.

   The workspace's `node ./scripts/common-consumer-check.mjs` lists which consumers are still behind this
   release, and it is the one place that list exists. Lagging is allowed and the script never fails on it;
   what it does fail on is a consumer naming a path the version its own lockfile pins does not export, and
   on a `node_modules` holding a build that lockfile does not name (MC-24, RISK_REGISTER R34).

⚠️ **There is no local shortcut, and there is no longer a script that offers one.** `deploy-local.sh`
copied a fresh build straight into every consumer's `node_modules`: no version, no lockfile entry, nothing
another machine or CI could reproduce, and a `yarn install` in any consumer silently put the last published
build back. It is deleted (platform owner, 2026-08-30). An edit that a consumer needs is an edit worth a
version number — publish it. A patch release costs nine steps and no consumer is ever left running a build
that exists on one machine. The hard ban on this shortcut lives in [`CLAUDE.md`](./CLAUDE.md).

## Test layout

Vitest 4, six suites. Each has its own config; the shared `.mjs → .mts` + `@`-alias resolver lives in
`vitest.shared.mts` (Vite cannot do NodeNext's `.mjs`-imports-`.mts` natively — keep its `aliases` array in
sync with `tsconfig.json` `paths`). `graphql` is de-duped/inlined everywhere, since two copies throw
`"from another module or realm"`.

| Suite | Config | Location | What it does |
|---|---|---|---|
| **unit** | `vitest.config.mts` | `test/*.test.mts` | In-memory, no DB, nothing mocked. v8 coverage gated at 100% (`thresholds: { 100: true }`). |
| **contract** | `vitest.contract.config.mts` | `test/contract/` | `exports`-map integrity, the root-entry rules, and smoke-imports of every dist subpath. Needs a fresh `dist/` — the script builds first. |
| **integration** | `vitest.integration.config.mts` | `test/integration/*.int.test.mts` | A real MongoDB via the `MONGO_TEST_*` env block: required-field validation, round-trip save, the pre-save hash hook firing on a real `.save()`. |
| **type-level** | `vitest.types.config.mts` | `test/types/*.test-d.mts` | `expectTypeOf` contracts via `tsc` (`tsconfig.typecheck.json` needs `rootDir: "."`, the files sit outside `src/`). |
| **mutation** | `stryker.config.mjs` → `vitest.mutation.config.mts` | mutates `src/**` | Stryker + vitest-runner, `thresholds.break: 100`. ~19 s; runs on every push. |

Unit, integration and type tests import the **source `.mts`** directly; contract tests import **`dist/`**.
Of 57 source files 25 are pure interfaces (no runtime, trivially 100%); the real logic is the 32 runtime
files Stryker mutates.

The contract suite already caught, and now guards against, four real `exports`-map defects: `types`
pointing at `.d.ts` instead of the emitted `.d.mts`, dead entries naming nonexistent files, and a `main` +
`types` pair at the top of `package.json` naming files the build has never emitted.

### What the mutation gate is for

Coverage was 100% and the mutation score was **45.95%** — a majority of `src/` could be silently corrupted
with no test noticing. Getting to 100% took zero changes to `src/` and zero Stryker disables: every
survivor was a weak assertion, and the holes it exposed were real (the embedded company sub-document had
no type or required checks at all, the `LoginSubDocSchema` pre-save hook never asserted the field name it
passes to `isModified()`, a shared field-shape checker checked `.required` but never `.type`). Most of
those models are gone now; the shape of the weakness is not.

## Traps in the tests

- **Adding a runtime file drops coverage below 100 → `test:cov` fails.** Add a matching test.
- ⚠️ **`tsconfig.typecheck.json` does not reach `test/integration/`** — it includes only `src/**/*.mts`
  and `test/types/**/*.test-d.mts`. `yarn typecheck` (`tsconfig.test.json`, gated in `.githooks/pre-commit`
  and `.githooks/pre-push`) is the one that covers it, along with the rest of `test/**` and the vitest
  configs — vitest itself still strips types without checking them, which is the gap that gate closes.
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

The hard bans this section backs — never hand-run the mutation gate, never add `ignoreStatic` — live in
[`CLAUDE.md`](./CLAUDE.md).

## Data model — the six models

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

The hard rules this section backs — company is the shop, domain-neutral catalogue, no `price` (ADR-038),
`ItemCategory.position` — live in [`CLAUDE.md`](./CLAUDE.md).

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
Reasoning and rejected alternatives: the decision doc named in [`CLAUDE.md`](./CLAUDE.md).

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

The hard rules this section backs — `exports` map exhaustiveness, devDependency placement, the mutation
config inlining requirement — live in [`CLAUDE.md`](./CLAUDE.md).

## Commands

```bash
yarn build          # ESM build only (tspc → dist/). This is the working build.
yarn typecheck      # tsc -p tsconfig.test.json — src/, test/ and the vitest configs, no emit
yarn lint           # eslint --fix . && prettier --write .      (lint:check = read-only)
yarn prepare        # hooks:install + rm -rf dist && yarn build (runs on install/publish)
yarn hooks:install  # core.hooksPath .githooks + the yarn.lock registry filter
yarn upload         # npm publish --registry=https://registry.npmjs.org/
yarn test           # unit tests once      (test:watch for watch mode)
yarn test:cov       # unit + coverage, fails under 100 on any metric
yarn test:contract  # yarn build && exports-map + dist smoke
yarn test:int       # real MongoDB via MONGO_TEST_*
yarn test:types     # compile-time expectTypeOf contracts
yarn test:mutation  # stryker, gated at 100 — hook-only, see CLAUDE.md
yarn semgrep        # semgrep SAST, readable report  (semgrep:ci for the pre-push gate)
yarn test:all       # cov + contract + int + types
```

⚠️ **`yarn build:all` / `prepare:all` are broken** — `build:cjs` references a `tsconfig.cjs.json` that does
not exist. Only the ESM path works.
