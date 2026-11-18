import { cookies } from 'next/headers'

import { AUTH_REQUEST_TTL_SECONDS, publicOrigin } from '@/lib/config'
import { jarToString, type CookieJar } from '@/lib/ncm/cookies'
import { openAuthRequest, sealAuthorizationCode, type AuthRequestState } from '@/lib/oauth/tokens'

export const AUTHZ_COOKIE = 'ncm_authz'

export interface LoginResult {
  jar: CookieJar
  userId?: number
  nickname?: string
}

/**
 * The authorization request travels in a sealed cookie between `/authorize` and the
 * login completions, so the three login routes never need to trust client-supplied
 * redirect targets.
 */
export async function readAuthzCookie(): Promise<AuthRequestState | null> {
  const store = await cookies()
  const raw = store.get(AUTHZ_COOKIE)?.value
  if (!raw) return null
  return openAuthRequest(raw)
}

export function authzCookieOptions(): {
  httpOnly: boolean
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: publicOrigin().startsWith('https://'),
    path: '/',
    maxAge: AUTH_REQUEST_TTL_SECONDS,
  }
}

/**
 * Mint the authorization code and build the redirect back to the MCP client. `iss` is
 * included per RFC 9207 because our metadata advertises support for it.
 */
export async function finishAuthorization(
  request: AuthRequestState,
  login: LoginResult,
): Promise<{ redirectUrl: string }> {
  const code = await sealAuthorizationCode({
    ...request,
    jar: jarToString(login.jar),
    userId: login.userId,
    nickname: login.nickname,
    grantedScope: request.scope,
  })

  const target = new URL(request.redirectUri)
  target.searchParams.set('code', code)
  if (request.state) target.searchParams.set('state', request.state)
  target.searchParams.set('iss', publicOrigin())

  return { redirectUrl: target.toString() }
}