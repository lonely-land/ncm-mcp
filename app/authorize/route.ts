import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

import { mcpResourceUrl } from '@/lib/config'
import { format, messagesFromRequest } from '@/lib/i18n'
import { assertRedirectAllowed, ClientError, normalizeScope, resolveClient } from '@/lib/oauth/credentials'
import { AUTHZ_COOKIE, authzCookieOptions } from '@/lib/oauth/authorize-flow'
import { sealAuthRequest } from '@/lib/oauth/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Where the React login UI lives. Kept separate so this handler can set cookies. */
const LOGIN_PAGE = '/oauth/login'

function failure(request: Request, code: string, message: string): NextResponse {
  const url = new URL(LOGIN_PAGE, request.url)
  url.searchParams.set('error', code)
  url.searchParams.set('message', message)
  return NextResponse.redirect(url)
}

/**
 * Validates the authorization request, seals it into the authz cookie, then hands off to
 * the React login page. The cookie cannot be set from a Server Component, which is why
 * this stays a route handler; the UI is a real shadcn page rendered by `/oauth/login`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams
  const text = messagesFromRequest(request).oauth

  if (params.get('response_type') !== 'code') {
    return failure(request, 'unsupported_response_type', text.unsupportedResponseType)
  }

  const clientId = params.get('client_id')
  if (!clientId) {
    return failure(request, 'invalid_request', text.clientIdRequired)
  }

  let client
  try {
    client = await resolveClient(clientId)
  } catch (error) {
    if (error instanceof ClientError) {
      return failure(request, error.code, text[error.descriptionKey])
    }
    throw error
  }

  const redirectUri = params.get('redirect_uri') ?? ''
  try {
    assertRedirectAllowed(client, redirectUri)
  } catch (error) {
    if (error instanceof ClientError) {
      return failure(request, error.code, text[error.descriptionKey])
    }
    throw error
  }

  const codeChallenge = params.get('code_challenge')
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256'
  if (!codeChallenge) {
    return failure(request, 'invalid_request', text.pkceRequired)
  }
  if (codeChallengeMethod !== 'S256') {
    return failure(request, 'invalid_request', text.pkceS256Only)
  }

  const expectedResource = mcpResourceUrl().href
  const requestedResource = params.get('resource')
  if (requestedResource) {
    const normalize = (value: string) => value.replace(/\/+$/, '')
    if (normalize(requestedResource) !== normalize(expectedResource)) {
      return failure(
        request,
        'invalid_target',
        format(text.invalidTarget, { resource: expectedResource }),
      )
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

  const target = new URL(LOGIN_PAGE, request.url)
  // Omit an unnamed client so the login page can substitute its own localized default.
  if (client.clientName) target.searchParams.set('client', client.clientName)
  target.searchParams.set('scope', scope)

  const response = NextResponse.redirect(target)
  const options = authzCookieOptions()
  response.cookies.set(AUTHZ_COOKIE, sealed, {
    httpOnly: options.httpOnly,
    sameSite: options.sameSite,
    secure: options.secure,
    path: options.path,
    maxAge: options.maxAge,
  })
  return response
}
