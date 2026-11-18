import { EncryptJWT, jwtDecrypt } from 'jose'

import {
  AUTH_REQUEST_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
  publicOrigin,
  tokenSecret,
} from '@/lib/config'

const ALG = 'dir'
const ENC = 'A256GCM'

async function seal(payload: Record<string, unknown>, ttlSeconds: number, audience: string): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: ALG, enc: ENC })
    .setIssuer(publicOrigin())
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .encrypt(tokenSecret())
}

async function open(token: string, audience: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtDecrypt(token, tokenSecret(), {
      issuer: publicOrigin(),
      audience,
      clockTolerance: 5,
    })
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}

/** Audience tag for a token kind. Keeps one kind from being replayed as another. */
const AUD = {
  authRequest: 'ncm-mcp:auth-request',
  code: 'ncm-mcp:code',
  access: 'ncm-mcp:access',
  refresh: 'ncm-mcp:refresh',
  client: 'ncm-mcp:client',
} as const

export interface AuthRequestState {
  clientId: string
  redirectUri: string
  state?: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
  resource?: string
  nonce: string
}

export interface AuthorizationCodePayload extends AuthRequestState {
  /** Serialized NetEase cookie jar. */
  jar: string
  userId?: number
  nickname?: string
  /** scopes actually granted after login */
  grantedScope: string
}

export interface AccessTokenPayload {
  scope: string
  jar: string
  userId?: number
  nickname?: string
  /** absolute unix seconds after which the NetEase session must be re-established */
  sessionExpiresAt: number
  clientId: string
}

export interface RefreshTokenPayload {
  scope: string
  jar: string
  userId?: number
  nickname?: string
  sessionExpiresAt: number
  clientId: string
}

export interface ClientRegistrationPayload {
  redirectUris: string[]
  clientName?: string
  grantTypes: string[]
  tokenEndpointAuthMethod: 'none'
}

export async function sealAuthRequest(state: AuthRequestState): Promise<string> {
  return seal({ ...state, kind: 'authz' }, AUTH_REQUEST_TTL_SECONDS, AUD.authRequest)
}

export async function openAuthRequest(token: string): Promise<AuthRequestState | null> {
  const payload = await open(token, AUD.authRequest)
  if (!payload || payload.kind !== 'authz') return null
  return payload as unknown as AuthRequestState
}

export async function sealAuthorizationCode(payload: AuthorizationCodePayload): Promise<string> {
  return seal(
    { ...payload, kind: 'code' },
    AUTHORIZATION_CODE_TTL_SECONDS,
    AUD.code,
  )
}

export async function openAuthorizationCode(token: string): Promise<AuthorizationCodePayload | null> {
  const payload = await open(token, AUD.code)
  if (!payload || payload.kind !== 'code') return null
  return payload as unknown as AuthorizationCodePayload
}

export async function sealAccessToken(payload: AccessTokenPayload): Promise<string> {
  return seal({ ...payload, kind: 'access' }, TOKEN_TTL_SECONDS, AUD.access)
}

export async function openAccessToken(token: string): Promise<AccessTokenPayload | null> {
  const payload = await open(token, AUD.access)
  if (!payload || payload.kind !== 'access') return null
  return payload as unknown as AccessTokenPayload
}

export async function sealRefreshToken(payload: RefreshTokenPayload): Promise<string> {
  return seal({ ...payload, kind: 'refresh' }, REFRESH_TTL_SECONDS, AUD.refresh)
}

export async function openRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
  const payload = await open(token, AUD.refresh)
  if (!payload || payload.kind !== 'refresh') return null
  return payload as unknown as RefreshTokenPayload
}

export async function sealClientRegistration(
  payload: ClientRegistrationPayload,
): Promise<string> {
  // Client ids are long-lived by design: a client re-registers only when it changes.
  return seal({ ...payload, kind: 'client' }, 60 * 60 * 24 * 365, AUD.client)
}

export async function openClientRegistration(token: string): Promise<ClientRegistrationPayload | null> {
  const payload = await open(token, AUD.client)
  if (!payload || payload.kind !== 'client') return null
  return payload as unknown as ClientRegistrationPayload
}
