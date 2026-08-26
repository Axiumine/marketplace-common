import type { ErrorEvent, NodeOptions } from '@sentry/node'
import { describe, expectTypeOf, test } from 'vitest'

import { type ISentryScrubbableEvent, sentryBeforeSend } from '../../src/others/sentryBeforeSend.mts'

/*
 * `ISentryScrubbableEvent` is declared structurally because nothing under `src/` may import
 * `@sentry/node` — it is a devDependency and must stay one. That leaves exactly one thing unproven at
 * the definition site: whether the structure it declares is really a widening of the event the SDK
 * hands `beforeSend`. This file is where that is checked, in the one place the dependency is allowed.
 */

/**
 * The event the SDK hands `beforeSendTransaction`, read off the option rather than imported: `@sentry/node`
 * re-exports `ErrorEvent` and not `TransactionEvent`, and taking it from the option is what keeps this
 * proof pointed at whatever type that hook really receives.
 */
type TSentryTransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0]

describe('sentryBeforeSend drops into Sentry.init with no cast at the call site', () => {
	test("the SDK's own ErrorEvent satisfies the structural constraint", () => {
		expectTypeOf<ErrorEvent>().toExtend<ISentryScrubbableEvent>()
	})

	test('the function is assignable to the beforeSend option', () => {
		expectTypeOf(sentryBeforeSend).toExtend<NonNullable<NodeOptions['beforeSend']>>()
	})

	// E12-S22. The SDK routes transaction events to the second hook only, and the four network-derived
	// attributes the scrubber exists for are on the transaction. One function, both hooks — proved here so
	// that a widening of the interface for the transaction shape cannot quietly stop fitting either.
	test("the SDK's own transaction event satisfies the structural constraint", () => {
		expectTypeOf<TSentryTransactionEvent>().toExtend<ISentryScrubbableEvent>()
	})

	test('the function is assignable to the beforeSendTransaction option', () => {
		expectTypeOf(sentryBeforeSend).toExtend<NonNullable<NodeOptions['beforeSendTransaction']>>()
	})

	test('the event type flows through the transaction hook too', () => {
		expectTypeOf(sentryBeforeSend<TSentryTransactionEvent>).returns.toEqualTypeOf<TSentryTransactionEvent>()
	})

	test('the event type flows through — an ErrorEvent in is an ErrorEvent out', () => {
		expectTypeOf(sentryBeforeSend<ErrorEvent>).returns.toEqualTypeOf<ErrorEvent>()
	})

	test('negative: an event missing the bags the scrubber walks is still accepted, an unrelated type is not', () => {
		expectTypeOf<Record<string, never>>().toExtend<ISentryScrubbableEvent>()
		expectTypeOf<string>().not.toExtend<ISentryScrubbableEvent>()
	})
})
