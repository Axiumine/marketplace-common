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

`deploy-local.sh` selects node the same way and for the same reason, with one difference: it reads the
version it asks nvm for from `.nvmrc` rather than from `engines.node`, because a script started by hand has
to survive there being no node on PATH at all, and `node -p 'require(…).engines.node'` cannot. It still
verifies the result against `engines.node` afterwards, so the two drifting apart blocks the deploy instead
of surfacing as a `yarn build` failure.

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

## Registry: proxy on disk, public npm in git

Installs go through the LAN mirror `yarnproxy.gio.lan:4873`; git and npmjs must only ever see
`registry.npmjs.org`. Yarn 1 writes **absolute** tarball URLs into every `resolved` line of `yarn.lock`, so
installing through the mirror would put a host that resolves on one LAN into ~477 lines of a lockfile this
repo publishes on a public GitHub, and `yarn install` would then fail for every clone not on that LAN. The
npm tarball is unaffected (`files: ["dist"]` keeps `yarn.lock` out of it); clones are not.

Three parts, all copied from `@axiumine/koa-utils`, which solved this first — **keep the two in sync rather
than letting them drift**:

|Part|Does|
|---|---|
|`scripts/lockfile-registry-filter.sh`|`clean` (worktree → git) rewrites proxy → npmjs; `smudge` (git → worktree) rewrites npmjs → proxy; `install` writes the filter into `.git/config` and reconciles the current checkout; `uninstall` removes it|
|`.gitattributes`|`yarn.lock filter=yarnlock-registry` — binds the filter to the one file|
|`.githooks/pre-commit`|blocks any commit whose **staged** `yarn.lock` still resolves against a non-public host|

The filter definition lives in `.git/config`, which git never clones, so it applies only to checkouts that
ran `yarn install` (→ `prepare` → `hooks:install`). Everyone else gets the public URLs verbatim, which is
the point. `required` is deliberately `false`: a missing script must degrade to passthrough, not break
checkout. Override the mirror per machine with `YARN_PROXY_REGISTRY`.

A fresh clone lands the public URLs *before* the filter exists, and git will not re-smudge a file it
already considers up to date — `hooks:install` therefore rewrites `yarn.lock` in place once, by hand. If
the worktree lock ever disagrees with what you expect, `touch yarn.lock && git add yarn.lock` re-runs
`clean` on it.

Verify both directions at any time:

```bash
grep -c 'yarnproxy\.gio\.lan' yarn.lock          # worktree: expect all of them
git show :yarn.lock | grep -c 'registry\.npmjs'  # index: expect the same count
git show :yarn.lock | grep -c 'yarnproxy'        # index: expect 0
```

Only this repo has the mechanism. The other sub-repos commit whatever host their lockfile was resolved
against; `services-status` has no lockfile at all. The same three files fix each of them, and are the thing
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

## Versioning

[`README.md`](./README.md) has the story. In short: the package was renamed and renumbered in one move —
a private scope at `4.4.0` became `@axiumine/marketplace-common@1.0.0`. The old scope is gone from every
package here and is not coming back — the 4.x line was never a public release train, so the reset cost no
installed consumer anything. If you meet a `4.x` number in an old note, it is the same code under the old
name.
