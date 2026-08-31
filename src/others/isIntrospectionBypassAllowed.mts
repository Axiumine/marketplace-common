/**
 * Whether the `x-introspectioncode` authentication bypass may run at all in this process. Every site
 * that compares `INTROSPECTION_CODE` calls this **first**, so outside the two environments it admits
 * the configured value is never read and the header is indistinguishable from a header nobody sent.
 *
 * The bypass exists so a service-to-service caller — and a developer pointing a GraphQL client at a
 * port — can reach the schema with no cookie and no `Authorization` header at all. That is a
 * development convenience, and until this predicate landed nothing in the code said so: the production
 * hardening in each service's `index.mts` adds `NoSchemaIntrospectionCustomRule` under
 * `NODE_ENV === 'production'`, which refuses the introspection *query* while leaving the *authentication*
 * bypass fully live. The
 * header was therefore a production credential, whatever it was meant to be.
 *
 * ⚠️ **Re-exported, not reimplemented.** The predicate itself is
 * `@axiumine/koa-utils/lib/isIntrospectionBypassAllowed`, added in `6.0.0`, where
 * `verifyIntrospectionCode` evaluates it as its own first statement. This platform kept a second copy
 * of the same allowlist until `2.0.0` of this package; two definitions of one security
 * predicate can only ever agree by luck, so the copy is gone and this module forwards. Its doc there
 * carries the reason the allowlist must never become `NODE_ENV !== 'production'` — the negated form
 * fails **open** on an unset, empty, `Production` or `staging` value, which is the ordinary failure of
 * a container runtime and of a deploy script. Do not substitute it, here or upstream.
 *
 * ⚠️ **This does not replace `INTROSPECTION_CODE` in `REQUIRED_ENV_VARS`, and removing it there is the
 * tidy-up to refuse.** The comparison sites interpolate the variable, so an unset one stringifies to
 * the literal `'undefined'` and a caller sending that word passes. Two independent things — a
 * mislabelled `NODE_ENV` *and* a missing code — must both be wrong before the bypass opens, and each
 * repo's boot check is the second half of that.
 *
 * ⚠️ **Neither of those two is a network boundary, and none is assumed.** The nine services bind the
 * wildcard address by decision (ADR-022), so the header reaches whatever can open a socket to the port.
 * *Which* callers those are was the production topology no document described — recorded as owed by
 * **ADR-032** until **ADR-039** (2026-08-28) superseded it and wrote the topology down: Cloudflare at the
 * edge, one application host behind a default-deny cloud security group, and the datastores on a separate
 * host on a private segment the platform owner declares trusted.
 *
 * ⚠️ **That changes nothing in this file, by the new ADR's own requirement.** ADR-039 §5 keeps this
 * allowlist unconditional and names it while doing it, because it narrows the old standing rule
 * rather than lifting it: a network boundary may be cited as a second layer and never as the whole
 * argument. So this gate stays written to hold with the port open, which is why it is an environment
 * check rather than an allowlist of peers. Of the three findings once bounded by that one unknown, only
 * R46 closed with the ADR — the `refresh` flood and the plaintext Redis leg (R45) did not.
 */
export { isIntrospectionBypassAllowed } from '@axiumine/koa-utils/lib/isIntrospectionBypassAllowed'
