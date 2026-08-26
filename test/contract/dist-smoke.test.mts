import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

// Repo root, resolved relative to this test file (not process.cwd()).
const root = fileURLToPath(new URL('../../', import.meta.url))

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
	exports: Record<string, { import?: string; types?: string }>
}

// Same heuristic as test/contract/exports.test.mts: does this compiled file carry a
// runtime value export, or is it a pure type/interface file that compiles to `export {};`?
const RUNTIME_EXPORT_RE = /export (const|function|class)|\bmodel\(|new Schema|new GraphQL|\.methods\./

const entries = Object.entries(packageJson.exports).filter(([, target]) => Boolean(target.import))

describe.each(entries)('dist smoke: %s', (key, target) => {
	const importPath = target.import as string
	const abs = path.join(root, importPath)

	it(`import() resolves without throwing`, async () => {
		await expect(import(pathToFileURL(abs).href)).resolves.toBeDefined()
	})

	it(`exports at least one member if the source has a runtime value export`, async () => {
		const text = fs.readFileSync(abs, 'utf8')
		if (!RUNTIME_EXPORT_RE.test(text)) return // pure type-only module, nothing to check at runtime

		const mod = await import(pathToFileURL(abs).href)
		expect(Object.keys(mod as object).length).toBeGreaterThanOrEqual(1)
	})
})
