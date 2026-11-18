import {
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/config'
import { jsonResponse, oauthError } from '@/lib/oauth/server'
import { normalizeScope } from '@/lib/oauth/credentials'
import {
  openAuthorizationCode,
  openRefreshToken,
  sealAccessToken,
  sealRefreshToken,
} from '@/lib/oauth/tokens'
import { verifyPkce } from '@/lib/oauth/credentials'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function sessionExpiryFrom(previous: number | undefined): number {
  const absoluteCap = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  if (previous && previous > 0) return Math.min(previous, absoluteCap)
  return absoluteCap
}

async function issueTokens(params: {
  scope: string
  jar: string
  userId?: number
  nickname?: string
  clientId: string
  sessionExpiresAt: number
}): Promise<Response> {
  const accessToken = await sealAccessToken({
    scope: params.scope,
    jar: params.jar,
    userId: params.userId,
    nickname: params.nickname,
    sessionExpiresAt: params.sessionExpiresAt,
    clientId: params.clientId,
  })

  const refreshToken = await sealRefreshToken({
    scope: params.scope,
    jar: params.jar,
    userId: params.userId,
    nickname: params.nickname,
    sessionExpiresAt: params.sessionExpiresAt,
    clientId: params.clientId,
  })

  return jsonResponse(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Number(process.env.NCM_TOKEN_TTL_SECONDS ?? 3600),
      refresh_token: refreshToken,
      scope: params.scope,
    },
    200,
    { pragma: 'no-cache' },
  )
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const json = (await request.json()) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'string') out[key] = value
      }
      return out
    } catch {
      return {}
    }
  }
  const text = await request.text()
  const params = new URLSearchParams(text)
  const out: Record<string, string> = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request)
  const grantType = form.grant_type

  if (grantType === 'authorization_code') {
    const code = form.code
    const codeVerifier = form.code_verifier
    if (!code) return oauthError('invalid_request', 'code is required')
    if (!codeVerifier) return oauthError('invalid_request', 'code_verifier is required')

    const payload = await openAuthorizationCode(code)
    if (!payload) return oauthError('invalid_grant', 'The authorization code is invalid or expired')

    if (form.client_id && form.client_id !== payload.clientId) {
      return oauthError('invalid_grant', 'client_id does not match the authorization request')
    }

    if (!verifyPkce(codeVerifier, payload.codeChallenge, payload.codeChallengeMethod)) {
      return oauthError('invalid_grant', 'PKCE verification failed')
    }

    if (!payload.jar) {
      return oauthError('invalid_grant', 'The authorization code carries no NetEase session')
    }

    return issueTokens({
      scope: normalizeScope(payload.grantedScope || payload.scope),
      jar: payload.jar,
      userId: payload.userId,
      nickname: payload.nickname,
      clientId: payload.clientId,
      sessionExpiresAt: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
    })
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.refresh_token
    if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required')

    const payload = await openRefreshToken(refreshToken)
    if (!payload) return oauthError('invalid_grant', 'The refresh token is invalid or expired')

    if (form.client_id && form.client_id !== payload.clientId) {
      return oauthError('invalid_grant', 'client_id does not match the refresh token')
    }

    return issueTokens({
      scope: payload.scope,
      jar: payload.jar,
      userId: payload.userId,
      nickname: payload.nickname,
      clientId: payload.clientId,
      sessionExpiresAt: sessionExpiryFrom(payload.sessionExpiresAt),
    })
  }

  return oauthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token')
}

export function GET(): Response {
  return oauthError('invalid_request', 'The token endpoint only accepts POST')
}
