import type { GraphQLError } from 'graphql'
import { expect } from 'vitest'

/**
 * The rejection itself, not merely the fact that there was one.
 *
 * `rejects.toThrow()` passes on *any* throw — including a TypeError from a stub that was wired up
 * wrong — so every guard is asserted on its status code and its message. Returning the error rather
 * than asserting inside the helper keeps each test's expectations where they can be read, and runs
 * the guard exactly once: several callers also count how many times a collaborator was called.
 */
export async function rejection(run: () => unknown): Promise<GraphQLError> {
	try {
		await run()
	} catch (error) {
		return error as GraphQLError
	}
	throw new Error('expected the guard to reject, and it returned')
}

/*
 * ⚠️ Asserted by shape, not with `toBeInstanceOf(GraphQLError)`.
 *
 * `@axiumine/koa-utils` is a bare specifier and is left external, so it resolves its own copy of
 * `graphql`, while a test file's import is deduped into the inlined one. The error these guards throw
 * is therefore a `GraphQLError` from a different realm: same class, different identity, and an
 * `instanceof` check fails on it while reporting `expected GraphQLError to be an instance of
 * GraphQLError`. The status and the message are what the HTTP layer reads anyway, and they are the
 * half a bare `rejects.toThrow()` would not have looked at.
 */
export function expectStatus(error: GraphQLError, status: number, message: string) {
	expect(error.name).toBe('GraphQLError')
	expect(error.message).toBe(message)
	expect(error.extensions.http).toEqual({ status })
}
