import { describe, expect, it } from 'vitest'

import { IKeygripKeyMaterial } from '../src/others/IKeygripKeyMaterial.mts'
import { keygripFingerprint } from '../src/others/keygripFingerprint.mts'

// Only `id` is read. The other two fields are filled with values a fingerprint must ignore — if either
// ever reached the digest, the expectations below would move.
const key = (id: string): IKeygripKeyMaterial => ({
	id,
	material: Buffer.alloc(64, id.charCodeAt(1)).toString('base64'),
	createdAt: '2026-08-12T09:14:22.581Z'
})

/*
 * ⚠️ The digests are literals, computed outside this repo — `python3 -c "import hashlib;
 * print(hashlib.sha256(b'k2:k1').hexdigest()[:12])"`. Computing them here with `sha256Hex` and the same
 * `join` the implementation uses would produce a test that agrees with any separator, any slice and any
 * ordering, including a mutated one. The seed script in `marketplace-db-setup` has to reproduce these
 * exact strings from its own CommonJS copy, so they are a cross-repo contract rather than a snapshot.
 */
describe('keygripFingerprint', () => {
	it('is the first 12 hex of sha256 over the ids joined by ":"', () => {
		expect(keygripFingerprint([key('k2'), key('k1')])).toBe('c77808de4139')
	})

	it('names a single-key set', () => {
		expect(keygripFingerprint([key('k1')])).toBe('6ab9f1eb8f7d')
	})

	it('names a three-key set', () => {
		expect(keygripFingerprint([key('k7'), key('k6'), key('k5')])).toBe('13651bfe9bb5')
	})

	/*
	 * ⚠️ Order is part of the identity, not noise. Index 0 is the key that signs, so two services holding
	 * the same three keys in a different order do *not* agree — one of them would be signing with a key
	 * the other only verifies with, and the holders table has to show that as a disagreement.
	 */
	it('distinguishes the same ids in a different order', () => {
		expect(keygripFingerprint([key('k1'), key('k2')])).not.toBe(keygripFingerprint([key('k2'), key('k1')]))
	})
})
