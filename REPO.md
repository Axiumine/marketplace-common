# Repository mechanics

How this package's git plumbing, build, registry filter and test layout behave, and why. Nothing here
changes what you write — it explains what happens when you build, commit, push or publish. [`CLAUDE.md`](./CLAUDE.md)
carries the rules; [`README.md`](./README.md) is the consumer-facing document.

## The hooks

`.githooks/pre-push` is a blocking six-step gate: `yarn semgrep:ci` (Semgrep SAST over `src/`, rules
vendored under `semgrep/`, pinned image, `--network none`), trivy (dependency advisories over `yarn.lock`,
HIGH and CRITICAL, production tree only), `yarn lint:check` (eslint, then
`prettier --check`, both over the whole tree), `yarn test:cov` (100% on every metric), `yarn test:mutation`
(Stryker, `thresholds.break: 100`), then a Qodana scan via `./qodana.sh`. Roughly a minute in total.

Semgrep and trivy are first because they are the cheap ones — about three seconds and, once the
vulnerability database is pulled, under one — so a rule violation or an advisory is reported before
anything slow runs. Both are push-only, like mutation: they need Docker and a pinned image, and push is
the layer that sees the merge commit anyway. Bypass for a Docker or network outage, never for a finding:
`SKIP_SEMGREP=1 git push`, `SKIP_TRIVY=1 git push`.

⚠️ **Trivy is there because Qodana's dependency check does not report.** The inspection Qodana runs is
`VulnerableLibrariesLocal`, an offline heuristic that queries no advisory feed and answers zero on every
repo here; the class that does query one is in the image and in no profile. This repo is the one whose
advisories reach every other — nine services install it by package name — so an unchecked transitive
dependency here is an unchecked dependency fleet-wide. E18-S11.

`.githooks/pre-commit` is four gates, cheapest first: the secret guard (staged secret paths, staged
high-entropy values), `yarn lint:check`, `yarn test:cov`, then a full Qodana scan. The last three run
**only** when the staged paths can move a verdict — `src/`, `test/`, `semgrep/`, `.githooks/`,
`package.json`, `yarn.lock`, `qodana.yaml`/`qodana.sh`, the vitest/tsconfig/stryker configs and, since the
lint gate exists to read them, `eslint.config.js`/`.prettierrc`/`.prettierignore` — so a docs-only commit
skips them. Those last three were missing from the filter for as long as lint was ungated, which is how a
run of commits widening the eslint `ignores` block each passed with no gate run at all.

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
