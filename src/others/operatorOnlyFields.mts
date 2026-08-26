/**
 * The `shopOwner` fields the Admin tier owns outright — written by BC-03 Shop Owner Onboarding &
 * Approval, read by nothing in the ShopOwner tier, ever.
 *
 * `notes` is free text an operator wrote *about* a named person, encrypted at rest and the one
 * encrypted field on the platform whose subject never gets to read it.
 *
 * ⚠️ **`waitApprov` is no longer on this list — see `APPROVAL_GATE_FIELD_SHOP_OWNER` below.** It is
 * still operator-*written*, but the two authorization gates now read it, so a list that forbade
 * naming it would forbid the gate that gives it meaning.
 *
 * ⚠️ **This is data, not a mechanism.** It is deliberately not an anti-corruption layer. BC-01 and
 * BC-03 do not have diverging models to translate between — both sides are generated from the single
 * `$jsonSchema` builder in `BEs/marketplace-db-setup/lib/schemas/shopOwner.js` and read through the
 * single `ShopOwner` model next door, so a mapper between them would translate a shape into itself
 * and cost a permanent 100%-coverage, 100-mutation-score tax for it. What was actually missing was
 * never translation — it was that "the ShopOwner tier does not select these fields" was a claim about
 * the code as it happened to be written, checked by nothing. `phase2/BOUNDED_CONTEXT.md` §6 called
 * that row a gap rather than a protection for exactly that reason.
 *
 * Two independent locks enforce it, and this list is the input to both (E01-S10):
 *
 * 1. A `no-restricted-syntax` block in `eslint.config.js` of each of the three BC-01/ShopOwner-tier
 *    services — `marketplace-dev-public-authorization` (login),
 *    `marketplace-dev-authenticated-authorization` (refresh) and
 *    `marketplace-dev-authenticated-resource` (domain). Selectors, not a grep: a comment explaining
 *    which tier owns a field is not an AST node, and a check that forbade writing about the boundary
 *    would be deleted by the first person who documented it correctly.
 * 2. The two projection tests that import this list — `tryLoginShopOwner.test.mts` and
 *    `tokenInfoShopOwner.test.mts` — assert the projection string those services hand Mongoose names
 *    none of them. Adding a field here tightens both without touching either.
 *
 * ⚠️ **A rename in the model silently disarms lock 1**, because an eslint selector matching
 * `notes` protects nothing once the field is called something else. That is what the schema-path
 * assertion in `test/others.test.mts` is for: every name below has to resolve to a real path on
 * `ShopOwnerSchema`, so the rename fails here — in the repo that owns the shape — and the failure
 * tells whoever renamed it that three eslint blocks are now pointing at a field that no longer
 * exists.
 *
 * ⚠️ **There is no `user` counterpart and an empty one must not be added.** The BC-01/BC-07 overlap
 * on the `user` collection is real, but `user` carries no operator-only field today — no `notes`, no
 * approval gate, and the Admin tier has no `user` resolvers at all. An empty list would read as a
 * boundary being enforced when nothing is being enforced. When the first such field lands, it gets a
 * list of its own here and the same two locks in the User-tier services.
 */
export const OPERATOR_ONLY_FIELDS_SHOP_OWNER = ['notes'] as const

/**
 * The one operator-written `shopOwner` field the BC-01 authorization services must **read**.
 *
 * `waitApprov` is BC-03's manual-approval gate: an operator raises it to park an account pending
 * review and clears it — `$unset`, never `false`, see `funShopOwnerUpdateStatus` — when the account
 * passes. `checkShopOwnerApproval` next door is the only thing that reads it outside the Admin tier,
 * and both BC-01 services call it: login (4028) so a parked account cannot start a session, refresh
 * (4029) so parking one ends the session it already has within one access-token lifetime rather than
 * one refresh-token lifetime. That is the same reasoning `findAccountForSession` gives for running
 * the `disabled`/`deleted` gate on every refresh instead of at login only.
 *
 * ⚠️ **Read-only, outside the Admin tier.** The eslint blocks in the three services ban `waitApprov`
 * in a *write* position — an object-literal key, which is what a `$set` is built from — and no
 * longer ban naming it at all. A ShopOwner-tier service that could write this field could approve its
 * own account; one that can read it can only refuse to serve itself.
 *
 * It is kept out of `OPERATOR_ONLY_FIELDS_SHOP_OWNER` because that list feeds the projection tests,
 * and these two services now have to project this field — asserting its absence is precisely the bug
 * this constant records the fix for. It still has to name a real path on `ShopOwnerSchema`, and
 * `test/others.test.mts` asserts that for this constant too.
 */
export const APPROVAL_GATE_FIELD_SHOP_OWNER = 'waitApprov' as const
