/**
 * Email-verification state for an account, as read and written by the `@axiumine/koa-utils`
 * verify-email flow (`createVerifyEmailFlow`).
 *
 * Every field is optional, and that is a contract rather than laziness. The flow never writes the
 * whole subdocument at once: `setEmailHash` sets `hash` + `requestTimes` + `dateLastReq` and never
 * touches `valid`; `enableEmailAccess` sets `valid` and `$unset`s the other three; `confirmNewEmail`
 * additionally clears `newEmailTmp`. Each of those intermediate states is a document Mongo has to
 * accept, so no member may be mandatory — see the matching note on the collection validator, which
 * carries no `required` array under `emailVerify` for exactly this reason.
 *
 * No `_id?: boolean` member, unlike its neighbour `IResetPwdSubDocSchema`. That phantom field is only
 * needed to type-check the *inline* `type: { _id: false, … }` spelling, which this sub-document does
 * not use — it turns the id off as a Schema option instead. Declaring it anyway would type-check a
 * caller writing `emailVerify: { _id: true }`, and under the validator's `additionalProperties: false`
 * that is a rejected write.
 */
export interface IEmailVerifySubDocSchema {
	/** Flipped to `true` once a verification link has been honoured. Never `$unset`. */
	valid?: boolean
	/** Inbox-proof token, `EMAIL_HASH_LEN` (50) chars. Must never share a slot with `resetPwd.resetHash`. */
	hash?: string
	/** When the current token was issued. Drives the 3-day link window. */
	dateLastReq?: Date
	/** Wrong-hash strike counter. Five strikes delete the account. */
	requestTimes?: number
	/** Address awaiting confirmation during an email change. */
	newEmailTmp?: string
}
