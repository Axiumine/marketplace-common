# @axiumine/marketplace-common

Shared building blocks for the [Marketplace platform](https://github.com/Axiumine/fullstack-marketplace-blueprint) —
Mongoose models, GraphQL field fragments, Redis session DTOs and the authorization helpers its nine backend services
have in common. It is a library, not a service: nothing here listens on a port.

```bash
yarn add @axiumine/marketplace-common
```

Node `^24.18.0`, ESM only.

## What is in it

| Area | Path | Contents |
|---|---|---|
| Models | `models/MongoDB/*` | `Admin`, `ShopOwner`, `Company`, `User`, `Item`, `ItemCategory` — six Mongoose models against six collections |
| Interfaces | `models/MongoDBInterfaces/*` | `IXxxModel` (a `Document`, with methods) and `IXxxSchema` (the plain data shape), split per model |
| GraphQL | `schema/types/fragments/*`, `schema/GraphQLInput/*` | field-config objects meant to be **spread** into a consumer's own `GraphQLObjectType` — not standalone types |
| Redis DTOs | `others/Redis/*` | `IRedisData…Common` → `…ForNode` / `IRedisData…`, the session payload shapes |
| Auth helpers | `others/*` | `resolveAuthorizationSession`, `findAccountForSession`, `refreshSessionTokens`, `assertTier`, `checkUserAuthorizationDisDel`, `assertTurnstile`, `assertUnderRateLimit`, `sha256Hex`, `constantTimeEquals`, `isIntrospectionBypassAllowed`, `TIER` |
| Session keys | `others/sessionKeys`, `others/hashSessionToken` | `sessionKey` — the one shape a session key has — plus the `readSessionHash`, `readSessionField` and `deleteSession` helpers every service builds a Redis session key through, never a template literal of its own |

## Importing

⚠️ **There is no root entry, deliberately.** No barrel exists and none is wanted, so
`import x from '@axiumine/marketplace-common'` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import the subpath you need:

```ts
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner';
import { TIER } from '@axiumine/marketplace-common/others/Tier';
import { assertTier } from '@axiumine/marketplace-common/others/assertTier';
```

The `exports` map is exhaustive and enumerates every importable path; a file compiled into `dist/` but missing from
that map is not reachable.

## Peer dependencies

Provided by the consuming service, not bundled: `mongoose`, `graphql`, `@node-rs/bcrypt`, `@axiumine/koa-utils`,
`reflect-metadata`, `dotenv`. Auth and error helpers throw through `@axiumine/koa-utils`.

The Redis client is a **parameter**, never an import — `ISessionReadStore` / `ISessionWriteStore` declare the four
commands used and nothing more, so importing a Mongoose model from here does not make a Redis install a precondition.

## Design notes worth knowing before you extend it

- **A company *is* a shop.** There is no `shop` model and there will not be one; the chain is
  `shopOwner ──idShopOwner──> company ──idCompany──> item`.
- **The catalogue is domain-neutral.** `Item` and `ItemCategory` presume nothing about what is sold. `Item` carries no
  `price` and never will — cart, order, delivery and payment are permanently out of scope on this platform (ADR-038,
  2026-08-27), so a price would be a guess at a currency, a precision, a VAT treatment and a discount model at once,
  with nothing that will ever resolve it.
- **Role is which collection you authenticate against**, not a field. There is no `role` and no permission enum
  anywhere; each tier has its own collection, its own service pair and its own `tier` value in the session, and
  `assertTier` is what refuses a foreign-tier token — with a 403, and treating a missing `tier` as invalid rather than
  as a wildcard.
- **`ItemCategory` is capped at two levels**, and that cap lives in the Admin resource service's resolvers — a Mongoose
  path and a MongoDB validator each see exactly one document, and "my parent must itself be top-level" needs two.
  `idParent` looking unconstrained here is not permission for a third level.

## Development

```bash
yarn build          # ESM build (tspc → dist/, one step, no post-processing)
yarn lint:check     # eslint, then prettier --check
yarn test:cov       # unit tests, 100% required on every metric
yarn test:contract  # exports-map integrity against a fresh dist/
yarn test:int       # against a real MongoDB (MONGO_TEST_* env block)
yarn test:types     # expectTypeOf compile-time contracts
yarn test:mutation  # Stryker, break threshold 100
```

Coverage and mutation are both gated at 100 and are enforced by git hooks. Never lower a threshold to get a commit
through — add the missing assertion.

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).
