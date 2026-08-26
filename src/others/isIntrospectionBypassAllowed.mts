/**
 * Whether the `x-introspectioncode` authentication bypass may run at all in this process. Every site
 * that compares `INTROSPECTION_CODE` calls this **first**, so outside the two environments below the
 * configured value is never read and the header is indistinguishable from a header nobody sent.
 *
 * The bypass exists so a service-to-service caller — and a developer pointing a GraphQL client at a
 * port — can reach the schema with no cookie and no `Authorization` header at all. That is a
 * development convenience, and until E13-S11 nothing in the code said so: the production hardening in
 * each service's `index.mts` adds `NoSchemaIntrospectionCustomRule` under `NODE_ENV === 'production'`,
 * which refuses the introspection *query* while leaving the *authentication* bypass fully live. The
 * header was therefore a production credential, whatever it was meant to be.
 *
 * ⚠️ **An allowlist, never `NODE_ENV !== 'production'`.** The denylist form is the natural way to
 * write this and it is the wrong polarity: it fails **open** on precisely the input most likely to be
 * wrong — unset, empty, `Production`, `staging`, a typo, whatever a broken deploy script exports — and
 * an unset `NODE_ENV` is the ordinary failure of every container runtime on this platform. Here an
 * unrecognised value refuses, so a mislabelled environment loses a development convenience rather than
 * opening authentication.
 *
 * ⚠️ **This does not replace `INTROSPECTION_CODE` in `REQUIRED_ENV_VARS`, and removing it there is the
 * tidy-up to refuse.** The comparison sites interpolate the variable, so an unset one stringifies to
 * the literal `'undefined'` and a caller sending that word passes. Two independent things — a
 * mislabelled `NODE_ENV` *and* a missing code — must both be wrong before the bypass opens, and each
 * repo's boot check is the second half of that.
 *
 * ⚠️ **Neither of those two is a network boundary, and none is assumed.** The nine services bind the
 * wildcard address by decision (ADR-022), so the header reaches whatever can open a socket to the port,
 * and *which* callers those are is the production topology no document describes — recorded as owed by
 * **ADR-032**, alongside the other two findings bounded by the same unknown (the `refresh` flood,
 * E14-S08, and the plaintext Redis leg, R45). This gate is written to hold with the port open, which is
 * why it is an environment check rather than an allowlist of peers.
 */
export function isIntrospectionBypassAllowed() {
	return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
}
