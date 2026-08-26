import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Repo root, resolved relative to this test file (not process.cwd()).
const root = fileURLToPath(new URL('../../', import.meta.url))

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
	exports: Record<string, { import?: string; types?: string }>
} & Record<string, unknown>

const exportsMap = packageJson.exports

// The fields Node and TypeScript consult for the *root* specifier, `import x from '<pkg>'`, when
// `exports` does not answer it. Every one of them names a single file.
const ROOT_FIELDS = ['main', 'module', 'types', 'typings', 'browser'] as const

// Heuristic for "this compiled dist file carries a runtime value export" -
// as opposed to a pure type/interface file, which compiles down to `export {};`.
const RUNTIME_EXPORT_RE = /export (const|function|class)|\bmodel\(|new Schema|new GraphQL|\.methods\./

function walkMjsFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			out.push(...walkMjsFiles(full))
		} else if (entry.isFile() && entry.name.endsWith('.mjs')) {
			out.push(full)
		}
	}
	return out
}

describe('package.json exports map integrity', () => {
	it('every exports entry has an existing "import" file and an existing "types" file', () => {
		const missing: string[] = []

		for (const [key, target] of Object.entries(exportsMap)) {
			if (!target.import) {
				missing.push(`${key}: missing "import" field entirely`)
			} else {
				const importAbs = path.join(root, target.import)
				if (!fs.existsSync(importAbs)) {
					missing.push(`${key}: import target does not exist -> ${target.import}`)
				}
			}

			if (!target.types) {
				missing.push(`${key}: missing "types" field entirely`)
			} else {
				const typesAbs = path.join(root, target.types)
				if (!fs.existsSync(typesAbs)) {
					missing.push(`${key}: types target does not exist -> ${target.types}`)
				}
			}
		}

		expect(missing, `Missing exports targets on disk:\n${missing.join('\n')}`).toEqual([])
	})

	it('every "types" path uses the .d.mts extension the NodeNext build emits', () => {
		// Guards a real bug this suite already caught: all entries pointed at ".d.ts" while
		// `.mts` sources compile declarations to ".d.mts", so consumer types silently failed.
		const wrong = Object.entries(exportsMap)
			.filter(([, target]) => target.types && !target.types.endsWith('.d.mts'))
			.map(([key, target]) => `${key} -> ${target.types}`)

		expect(wrong, `exports "types" not pointing at .d.mts:\n${wrong.join('\n')}`).toEqual([])
	})

	it('every consumer-facing model/schema dist module is present in the exports map', () => {
		// Guards the documented #1 mistake: adding a model/fragment/input without an exports entry.
		// Scoped to consumer-facing dirs only — internal building blocks (sub-schemas under */sub/,
		// constants, shared field shapes) are intentionally NOT exported.
		const distDir = path.join(root, 'dist')
		const consumerDirs = [path.join(distDir, 'models/MongoDB'), path.join(distDir, 'schema')]

		const toExportsKey = (absFile: string): string => {
			const rel = path.relative(distDir, absFile).replace(/\\/g, '/')
			return `./${rel.slice(0, -'.mjs'.length)}`
		}

		const exportedKeys = new Set(Object.keys(exportsMap))
		const missingFromExports: string[] = []

		for (const dir of consumerDirs) {
			for (const file of walkMjsFiles(dir)) {
				if (/\/sub\//.test(file.replace(/\\/g, '/'))) continue // internal building blocks
				const text = fs.readFileSync(file, 'utf8')
				if (!RUNTIME_EXPORT_RE.test(text)) continue // pure type-only file (compiles to `export {};`)

				const key = toExportsKey(file)
				if (!exportedKeys.has(key)) {
					missingFromExports.push(`${key}  (from ${path.relative(root, file)})`)
				}
			}
		}

		expect(
			missingFromExports,
			`Consumer-facing dist modules missing from package.json "exports":\n${missingFromExports.join('\n')}`
		).toEqual([])
	})
})

describe('package.json root entry point', () => {
	// This block exists because the two tests above walk `exports` and stop there, so nothing ever
	// looked at the root fields — and both of them rotted unnoticed. `main` said "dist/index.js"
	// (the build emits `.mjs`, and there is no barrel to emit) and `types` said
	// "dist/types/index.d.mts" (nothing has ever written a dist/types/ directory). Both named files
	// that have never existed in any published tarball.

	it('declares no root entry field that does not resolve', () => {
		const broken = ROOT_FIELDS.filter((field) => typeof packageJson[field] === 'string').filter(
			(field) => !fs.existsSync(path.join(root, packageJson[field] as string))
		)

		expect(
			broken.map((c) => `${c} -> ${String(packageJson[c])}`),
			`Root entry fields naming a file that does not exist:\n${broken.join('\n')}`
		).toEqual([])
	})

	it('does not advertise a root entry, because there is no barrel', () => {
		// Deliberate design, documented in CLAUDE.md: consumers import per subpath and every file
		// needs its own `exports` entry. There is no `src/index.mts` and none is wanted.
		//
		// The pairing is what matters. Under Node ESM `exports` is exhaustive once present, so with
		// no "." key `import from '@axiumine/marketplace-common'` is
		// ERR_PACKAGE_PATH_NOT_EXPORTED no matter what `main` says — a `main` here can only ever be
		// a claim the resolver will refuse to honour. Adding a real barrel means adding the "."
		// key first; then this test is the thing to change, not to delete.
		expect(Object.keys(exportsMap)).not.toContain('.')

		for (const field of ROOT_FIELDS) {
			expect(packageJson[field], `"${field}" points at a root entry the exports map does not offer`).toBeUndefined()
		}
	})
})
