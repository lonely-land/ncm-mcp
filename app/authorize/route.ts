import { randomUUID } from 'node:crypto'

import { mcpResourceUrl } from '@/lib/config'
import { oauthError } from '@/lib/oauth/server'
import { assertRedirectAllowed, ClientError, normalizeScope, resolveClient } from '@/lib/oauth/credentials'
import { AUTHZ_COOKIE, authzCookieOptions } from '@/lib/oauth/authorize-flow'
import { sealAuthRequest } from '@/lib/oauth/tokens'
import { renderLoginPage } from '@/app/authorize/login-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams

  if (params.get('response_type') !== 'code') {
    return oauthError('unsupported_response_type', 'Only response_type=code is supported')
  }

  const clientId = params.get('client_id')
  if (!clientId) return oauthError('invalid_request', 'client_id is required')

  let client
  try {
    client = await resolveClient(clientId)
  } catch (error) {
    if (error instanceof ClientError) return oauthError(error.code, error.description, error.status)
    throw error
  }

  const redirectUri = params.get('redirect_uri') ?? ''
  try {
    assertRedirectAllowed(client, redirectUri)
  } catch (error) {
    if (error instanceof ClientError) return oauthError(error.code, error.description, error.status)
    throw error
  }

  const codeChallenge = params.get('code_challenge')
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256'
  if (!codeChallenge) {
    return oauthError('invalid_request', 'PKCE code_challenge is required')
  }
  if (codeChallengeMethod !== 'S256') {
    return oauthError('invalid_request', 'Only code_challenge_method=S256 is supported')
  }

  const expectedResource = mcpResourceUrl().href
  const requestedResource = params.get('resource')
  if (requestedResource) {
    const normalize = (value: string) => value.replace(/\/+$/, '')
    if (normalize(requestedResource) !== normalize(expectedResource)) {
      return oauthError('invalid_target', `This authorization server only issues tokens for ${expectedResource}`)
    }
  }

  const scope = normalizeScope(params.get('scope'))

  const sealed = await sealAuthRequest({
    clientId,
    redirectUri,
    state: params.get('state') ?? undefined,
    scope,
    codeChallenge,
    codeChallengeMethod,
    resource: requestedResource ?? expectedResource,
    nonce: randomUUID(),
  })

  return new Response(
    renderLoginPage({ clientName: client.clientName ?? 'an MCP client', scope }),
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'set-cookie': buildSetCookie(AUTHZ_COOKIE, sealed, authzCookieOptions()),
      },
    },
  )
}

function buildSetCookie(
  name: string,
  value: string,
  options: ReturnType<typeof authzCookieOptions>,
): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, `Max-Age=${options.maxAge}`, 'HttpOnly']
  if (options.sameSite) parts.push(`SameSite=${options.sameSite === 'lax' ? 'Lax' : 'Strict'}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}
