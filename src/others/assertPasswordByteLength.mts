import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { MAX_PWD_LENGTH } from '@axiumine/koa-utils/lib/Constants'

/**
 * Refuses a password `@node-rs/bcrypt` would silently truncate.
 *
 * bcrypt hashes only the first 72 **bytes** of its input and drops the rest without complaint or error
 * (OWASP:
 * https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#input-limits-of-bcrypt).
 * `@axiumine/koa-utils`' own `checkPwdLen` guards the same ceiling, but measures `password.length` —
 * UTF-16 code units, not bytes — so a password heavy in emoji, accents or CJK characters can sit at or
 * under that count while running well past 72 UTF-8 bytes. Two such passwords that happen to agree on
 * their first 72 bytes then hash **identically** and authenticate each other: the platform's "distinct
 * passphrases must not collide" invariant, broken silently by exactly the callers `checkPwdLen` was
 * meant to protect.
 *
 * ⚠️ **The error is `checkPwdLen`'s own "too long" shape, thrown through the same helper, not
 * reconstructed by hand.** A client that already branches on that shape for the character-length check
 * needs no second branch for the byte-length one — the two are indistinguishable on the wire, on
 * purpose, so nothing about *why* a password was refused leaks past "too long". `MAX_PWD_LENGTH` is
 * imported rather than restated as a literal `72`, so the two checks cannot drift the day either one of
 * them moves.
 *
 * `Buffer.byteLength(password, 'utf8')` is what bcrypt's own truncation counts against — the UTF-8
 * encoded byte length, not the UTF-16 code-unit count `String.prototype.length` gives and not the
 * code-point count `[...password].length` would give either.
 */
export function assertPasswordByteLength(password: string): void {
	if (Buffer.byteLength(password, 'utf8') > MAX_PWD_LENGTH) throwErrorWrongUserInput('Password is too long')
}
