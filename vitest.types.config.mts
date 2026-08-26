import { defineConfig } from 'vitest/config'

// Type-level tests: assert the interface/DTO contracts consumers rely on, via `expectTypeOf`.
// Runs tsc (through Vitest's typecheck mode) against tsconfig.typecheck.json — no runtime.
export default defineConfig({
	test: {
		include: ['test/types/**/*.test-d.mts'],
		typecheck: {
			enabled: true,
			only: true,
			include: ['test/types/**/*.test-d.mts'],
			tsconfig: './tsconfig.typecheck.json'
		}
	}
})
