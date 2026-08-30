import { afterEach, describe, expect, it, vi } from 'vitest'

import { wrapKeygripKeys } from '../src/encryption/wrapKeygripKeys.mts'
import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'
import { keygripFingerprint } from '../src/others/keygripFingerprint.mts'
import { KEYGRIP_HOLDER_TTL_SECONDS } from '../src/others/recordKeygripHolder.mts'
import { IKeygripSubscriber, IKeygripWatchStore, KEYGRIP_POLL_MS, watchKeygrip } from '../src/others/watchKeygrip.mts'

const REDIS_KEY = 'test:'
const SERVICE = 'marketplace-dev-public-authorization'
const CHANNEL = `${REDIS_KEY}keygrip:rotated`

const KEK = Buffer.alloc(32, 7)

const KEYS_V3: IKeygripKeyMaterial[] = [
	{ id: 'k1', material: Buffer.alloc(64, 34).toString('base64'), createdAt: '2026-05-01T08:00:00.000Z' }
]
const KEYS_V4: IKeygripKeyMaterial[] = [
	{ id: 'k2', material: Buffer.alloc(64, 17).toString('base64'), createdAt: '2026-08-12T09:14:22.581Z' },
	...KEYS_V3
]

const record = (version: number, keys: IKeygripKeyMaterial[]) => ({
	version: String(version),
	wrapped: wrapKeygripKeys(keys, version, KEK),
	fp: keygripFingerprint(keys)
})

/** A Redis stand-in whose record can be replaced mid-test, which is what a rotation looks like from here. */
const makeStore = (initial: Record<string, string>) => {
	let current = initial

	return {
		hGetAll: vi.fn(async () => current),
		hSet: vi.fn(async () => 1),
		hExpire: vi.fn(async () => [1]),
		hGet: vi.fn(async (_key: string, field: string) => current[field]),
		rotate: (next: Record<string, string>) => {
			current = next
		}
	} satisfies IKeygripWatchStore & Record<string, unknown>
}

/** The subscribing connection, with a handle on the listener so a test can deliver a message. */
const makeSubscriber = () => {
	let listener: ((message: string) => void) | undefined

	return {
		subscribe: vi.fn(async (_channel: string, incoming: (message: string) => void) => {
			listener = incoming
		}),
		publish: (message: string) => listener?.(message)
	} satisfies IKeygripSubscriber & Record<string, unknown>
}

const watch = async (store: ReturnType<typeof makeStore>, subscriber: ReturnType<typeof makeSubscriber>, version = 3) => {
	const onKeys = vi.fn()
	const onError = vi.fn()
	const timer = await watchKeygrip({
		store,
		subscriber,
		serviceName: SERVICE,
		version,
		fp: keygripFingerprint(KEYS_V3),
		onKeys,
		onError
	})

	return { onKeys, onError, timer }
}

vi.stubEnv('REDIS_KEY', REDIS_KEY)
vi.stubEnv('KEYGRIP_KEK', KEK.toString('base64'))

afterEach(() => {
	vi.useRealTimers()
})

describe('watchKeygrip', () => {
	it('subscribes to the rotation channel of the configured keyspace', async () => {
		const subscriber = makeSubscriber()
		const { timer } = await watch(makeStore(record(3, KEYS_V3)), subscriber)

		expect(subscriber.subscribe).toHaveBeenCalledExactlyOnceWith(CHANNEL, expect.any(Function))

		clearInterval(timer)
	})

	/*
	 * ⚠️ The message is a nudge, not the key: the payload is ignored and the record is re-read and
	 * unwrapped here. A publisher that could hand a service key material would be a publisher that could
	 * re-key the fleet by writing to a channel, which is exactly what the KEK exists to prevent — and it
	 * is why an unauthenticated channel inside Redis is safe to use for this at all.
	 */
	it('re-reads and unwraps the record itself when a rotation is announced', async () => {
		const store = makeStore(record(3, KEYS_V3))
		const subscriber = makeSubscriber()
		const { onKeys, onError, timer } = await watch(store, subscriber)

		store.rotate(record(4, KEYS_V4))
		subscriber.publish('4')

		await vi.waitFor(() => expect(onKeys).toHaveBeenCalledTimes(1))
		expect(onKeys).toHaveBeenCalledWith({ version: 4, fp: keygripFingerprint(KEYS_V4), keys: KEYS_V4 })
		// The holders row is rewritten on the swap, which is what turns the table into rotation progress:
		// a service still showing the old fingerprint has not adopted yet.
		expect(store.hSet).toHaveBeenCalledExactlyOnceWith(
			`${REDIS_KEY}keygrip:holders`,
			SERVICE,
			expect.stringContaining(keygripFingerprint(KEYS_V4))
		)
		expect(onError).not.toHaveBeenCalled()

		clearInterval(timer)
	})

	/*
	 * ⚠️ Redis delivers a message to every subscriber and the poll fires regardless, so without the version
	 * check a service would hand its caller a new `Keygrip` to install every few minutes on a record nobody
	 * had touched — and "the keys changed" would stop being an event anybody could read.
	 */
	it('does not rebuild the keys for a message naming the version it already signs with', async () => {
		const store = makeStore(record(3, KEYS_V3))
		const subscriber = makeSubscriber()
		const { onKeys, onError, timer } = await watch(store, subscriber)

		subscriber.publish('3')
		store.rotate(record(4, KEYS_V4))
		subscriber.publish('4')

		/*
		 * ⚠️ The real rotation is the fence, and it is why this is not simply "publish, then assert
		 * nothing happened". Both re-reads are asynchronous, so an assertion taken straight after the
		 * first message would pass while the work was still in flight — and would keep passing if the
		 * version check were deleted. Once the *second* message has been adopted, the first has had every
		 * chance to do the same, and a single call proves it did not take it.
		 */
		await vi.waitFor(() => expect(onKeys).toHaveBeenCalledTimes(1))
		expect(onKeys).toHaveBeenCalledWith({ version: 4, fp: keygripFingerprint(KEYS_V4), keys: KEYS_V4 })
		expect(onError).not.toHaveBeenCalled()

		clearInterval(timer)
	})

	/*
	 * ⚠️ Reported and dropped, never thrown. This runs on a socket callback, where a throw is an unhandled
	 * rejection that kills the process — and killing a serving service because it could not re-read a key
	 * it already holds is strictly worse than serving on with the old one, which every sibling still
	 * verifies. The boot read is where a bad record is fatal; this one is not.
	 */
	it('reports a failed re-read and keeps serving with the keys it has', async () => {
		const store = makeStore(record(3, KEYS_V3))
		const subscriber = makeSubscriber()
		const { onKeys, onError, timer } = await watch(store, subscriber)

		store.rotate({ version: '4', wrapped: 'not-a-blob-this-process-can-open', fp: 'ffffffffffff' })
		subscriber.publish('4')

		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/^KEYGRIP_KEK_MISMATCH: /)
		expect(onKeys).not.toHaveBeenCalled()

		clearInterval(timer)
	})

	it('polls the version field alone, and unwraps nothing while the number has not moved', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const { onKeys, onError, timer } = await watch(store, makeSubscriber())

		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(store.hGet).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip`, 'version')
		// One small field answers "nothing changed" — the full read would be five AES operations every
		// five minutes, on five services, forever, to reach the same answer.
		expect(store.hGetAll).not.toHaveBeenCalled()
		expect(onKeys).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()

		clearInterval(timer)
	})

	/*
	 * ⚠️ The quiet tick is a heartbeat, not a no-op. Without this write the holders timestamp would say
	 * when the service last *adopted* a key set, so one that booted in March and never rotated would look
	 * exactly like one that has been dead since March — and telling those two apart is the whole job of
	 * the table.
	 */
	it('restamps its holders row on a tick that found nothing changed', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const { timer } = await watch(store, makeSubscriber())

		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(store.hSet).toHaveBeenCalledExactlyOnceWith(
			`${REDIS_KEY}keygrip:holders`,
			SERVICE,
			expect.stringContaining(`${keygripFingerprint(KEYS_V3)}@`)
		)
		// ⚠️ And renews the hour, or the row of a service that heartbeats faithfully for an hour without
		// ever rotating would expire out from under it — which reads as "this service is gone".
		expect(store.hExpire).toHaveBeenCalledExactlyOnceWith(`${REDIS_KEY}keygrip:holders`, SERVICE, KEYGRIP_HOLDER_TTL_SECONDS)

		clearInterval(timer)
	})

	// The heartbeat runs on the same connection as everything else, so it fails the same way — reported,
	// dropped, tried again on the next tick.
	it('reports a heartbeat that cannot be written', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const error = new Error('redis read-only')
		store.hSet.mockRejectedValueOnce(error)
		const { onError, timer } = await watch(store, makeSubscriber())

		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(onError).toHaveBeenCalledExactlyOnceWith(error)

		clearInterval(timer)
	})

	// The case the poll exists for: the message was missed, or the subscription died quietly, and nothing
	// else would ever tell this service that the fleet moved on.
	it('adopts on the poll when the version moved and no message arrived', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const { onKeys, timer } = await watch(store, makeSubscriber())

		store.rotate(record(4, KEYS_V4))
		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(onKeys).toHaveBeenCalledExactlyOnceWith({ version: 4, fp: keygripFingerprint(KEYS_V4), keys: KEYS_V4 })

		clearInterval(timer)
	})

	// The heartbeat has to follow the keys, not the boot: a service that adopted an hour ago and keeps
	// reporting the fingerprint it started with reads on the admin's screen as one that never swapped.
	it('heartbeats under the new fingerprint once it has adopted', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const { timer } = await watch(store, makeSubscriber())

		store.rotate(record(4, KEYS_V4))
		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)
		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(store.hSet).toHaveBeenCalledTimes(2)
		expect(store.hSet.mock.calls[1][2]).toContain(`${keygripFingerprint(KEYS_V4)}@`)

		clearInterval(timer)
	})

	it('does not poll before the interval is up', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const { timer } = await watch(store, makeSubscriber())

		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS - 1)

		expect(store.hGet).not.toHaveBeenCalled()

		clearInterval(timer)
	})

	it('honours an explicit poll interval', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const onKeys = vi.fn()
		const onError = vi.fn()
		const timer = await watchKeygrip({
			store,
			subscriber: makeSubscriber(),
			serviceName: SERVICE,
			version: 3,
			onKeys,
			onError,
			pollMs: 1_000
		})

		await vi.advanceTimersByTimeAsync(1_000)

		expect(store.hGet).toHaveBeenCalledTimes(1)

		clearInterval(timer)
	})

	// A poll that cannot reach Redis is the same non-fatal event as a failed re-read: the service still
	// holds keys every sibling verifies, and the next tick tries again.
	it('reports a poll that cannot reach Redis', async () => {
		vi.useFakeTimers()
		const store = makeStore(record(3, KEYS_V3))
		const error = new Error('redis gone')
		store.hGet.mockRejectedValueOnce(error)
		const { onError, timer } = await watch(store, makeSubscriber())

		await vi.advanceTimersByTimeAsync(KEYGRIP_POLL_MS)

		expect(onError).toHaveBeenCalledExactlyOnceWith(error)

		clearInterval(timer)
	})

	/*
	 * ⚠️ The timer must not be the reason a process refuses to exit. A five-minute interval on a service
	 * that has finished draining would hold the event loop for up to five minutes past the last request,
	 * turning every restart into a wait — and `unref` is invisible in behaviour, so only this asserts it.
	 */
	it('returns a timer that does not hold the process open', async () => {
		vi.useFakeTimers()
		const { timer } = await watch(makeStore(record(3, KEYS_V3)), makeSubscriber())

		expect(timer.hasRef()).toBe(false)

		clearInterval(timer)
	})
})
