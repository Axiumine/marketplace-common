# marketplace-common

`@axiumine/marketplace-common` — shared library, published to npm, consumed by the nine backend services.
Building blocks only; nothing here listens on a port.

**Read parent first** — [`../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)

| Need | File |
|---|---|
| consumer-facing overview, import paths | [`README.md`](./README.md) |
| hooks, build, registry filter, release flow, data model, `exports` map, architecture, test traps, commands | [`REPO.md`](./REPO.md) |
| GitNexus rules, this repo's registry name | [`AGENTS.md`](./AGENTS.md) |
| why the three authz svcs stay three | parent [`docs/decisions/authorization-service-consolidation.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/decisions/authorization-service-consolidation.md) |

Contents: Mongoose models & schemas (`src/models/`) · GraphQL type fragments & inputs (`src/schema/`) ·
interfaces, Redis DTOs, constants, auth helpers (`src/others/`, `src/models/MongoDBInterfaces/`).

⚠️ **Run `impact({target, repo: "marketplace-common"})` before editing a symbol, and `detect_changes()`
before committing** — `repo:` is mandatory and always a `marketplace*` registry name. Full GitNexus rules
and CLI: [`AGENTS.md`](./AGENTS.md).

## Hard rules

⚠️ **A published release is the only way an edit here reaches a consumer.** Hand-copying a build into a
consumer's `node_modules` is **banned** — no `rsync`/`cp`/`yarn link`/`file:`, and `deploy-local.sh` is
**deleted** (platform owner, 2026-08-30). Publish instead: bump, changelog, merge, tag, push, `yarn upload`,
move each consumer's range — nine steps, all of them, every time. Full flow: [`REPO.md`](./REPO.md)
§Publishing a release.

⚠️ **Never run `yarn test:mutation` / `stryker` by hand.** It is hook-only — `pre-push` runs it, nothing
else does, not to check a change, not on one file, not to confirm a survivor is fixed. Reproduce a
survivor by hand-applying the mutant in source and running `yarn test` (seconds; names the failing tests).

⚠️ **A company IS the shop.** No `shop` model or collection, none coming — the chain is
`shopOwner ──idShopOwner──> company ──idCompany──> item`, and a storefront's shop fields (`publicName`,
`slug`, `description`, `published`) live on `Company`.

⚠️ **Role is which collection you authenticate against, not a field.** No `role` field, no permission
enum anywhere; `User` mirrors `ShopOwner`'s login/reset/verify sub-schemas for that reason.

⚠️ **`Item` / `ItemCategory` are one domain-neutral catalogue — never reintroduce product-type
vocabulary.** `Item` has no `price` and never will: cart, order, delivery and payment are **permanently
out of scope** (ADR-038, platform owner, 2026-08-27). Adding any of them contradicts an accepted ADR.

⚠️ **The `exports` map in `package.json` is exhaustive and has no `.` root entry.** A file compiled into
`dist/` but missing from `exports` is not importable by consumers — the most common mistake in this repo
(`test:contract` guards it). Never re-add a root `main`/`types` without adding the `.` export first.

⚠️ **`personalData` is optional on both `User` and `ShopOwner`** — do not assume it is required. Both
sign-up paths take only an email and a password; a customer may never fill it in.

⚠️ **`defaultAddress` on `User` is enforced by MongoDB's `$expr`, not this package.** Removing the default
address must `$unset` the pointer in the **same** update, or the write is rejected.

⚠️ **`UserAddressSubDocSchema` is the one address schema that keeps its `_id`** — every other embedded
address is `{ _id: false }`; this one is an array element `defaultAddress` names by id.

⚠️ **`ItemCategory.position` is a sort ordinal**, unrelated to the GeoJSON `position` on `Company.address`
/ `User.addresses[]` — same name, no shared shape; spreading the wrong GraphQL fragment compiles but
answers coordinates for a catalogue sort order.

⚠️ **`@sentry/node` and `uuid` must stay devDependencies.** Nothing under `src/` imports either; promoting
one puts Sentry behind every consumer of a Mongoose model.

⚠️ **A consumer's `vitest.mutation.config.mts` must inline this package *and* `@axiumine/koa-utils`.**
Otherwise a `vi.mock(...)` on either stops intercepting once the import runs from `dist/` here instead of
the service's own `src/`, and it fails as a silent dry-run with no mutant in sight.

⚠️ **Nothing type-checks `test/integration/`.** `tsconfig.typecheck.json` stops at `src/**` and
`test/types/**`; verify a new type there with a throwaway `tsc` config, not by trusting the suite.

⚠️ **Never add `ignoreStatic` to `stryker.config.mjs`.** It hides real survivors instead of fixing them —
a module-load-time throw belongs inside a dynamic `import()` in `beforeEach` (not `beforeAll`), so the
throw lands inside a test that can fail.

⚠️ **`yarn upload` pins the public registry; a bare `npm publish` through yarn can silently publish to a
configured local mirror instead**, with a success message either way. Always use `yarn upload`.

⚠️ **`yarn build:all` / `prepare:all` are broken** (`build:cjs` needs a `tsconfig.cjs.json` that does not
exist) — only the ESM path, `yarn build`, works.

## Version control

**git**, branch `main`, remote `origin` → `git@github.com:Axiumine/marketplace-common.git` (public,
GPL-3.0-or-later). **This is the one repo that may be committed, merged, pushed and published without
asking** — every other repo in the workspace is push-on-request.

- ⚠️ Never commit on `main`. Branch first: `git switch -c <type>/<slug>`; delete on merge with `-d` only
  (never `-D`, which would drop unmerged work).
- ⚠️ Never lower a coverage or mutation threshold, and never remove a gate. A threshold miss gets the
  missing assertion, not a lowered number.
- Tabs, not spaces. English only. Node `^24.18.0`, yarn classic.
