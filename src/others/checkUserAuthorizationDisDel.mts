import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { IAuthorizationDisDel } from '@axiumine/koa-utils/lib/IAuthorizationDisDel'

export function checkUserAuthorizationDisDel(user: IAuthorizationDisDel) {
	const { disabled, deleted } = user

	if (deleted) {
		// the suspended-account message is only worth sending once a password was supplied — otherwise an
		// attacker learns the account exists without ever holding its password
		throw throwUnauthorizedError() // fixme: email 'Account deleted.'
	}

	if (disabled) {
		// same reasoning as the deleted branch above: no message without a password
		throw throwUnauthorizedError() // fixme email: 'Account suspended.'
	}
}
