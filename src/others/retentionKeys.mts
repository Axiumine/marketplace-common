/**
 * The single key the fleet's hourly retention sweeps contend on — the shared prefix and the constant
 * `retention:lock`.
 *
 * ⚠️ **`SET NX PX`, and the lock is never released** (ADR-041). Its TTL is the sweep interval, so the
 * key survives until the next tick is due and exactly one instance in the fleet sweeps per interval.
 * Releasing it at the end would reintroduce the classic unlock-ownership race — an instance whose sweep
 * outran the TTL would delete a lock a *different* instance had since taken — and buy nothing, because
 * there is no hurry to sweep again. An instance that dies mid-sweep costs at most one skipped interval;
 * the documents it did not reach are still selected by the next run, since `scrubbedAt` is stamped per
 * document.
 *
 * ⚠️ **One key, a constant, nothing interpolated but the prefix.** There is no per-tier or per-account
 * variant: the sweep is a single fleet-wide job over both scrubbable collections at once, and a lock
 * that named a tier would let two tiers' sweeps run concurrently — the exact contention this key exists
 * to serialise away.
 */
export const retentionLockKey = (): string => `${process.env.REDIS_KEY}retention:lock`
