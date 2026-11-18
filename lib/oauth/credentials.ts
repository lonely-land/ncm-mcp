import { createHash, timingSafeEqual } from 'node:crypto'

import { preRegisteredClients } from '@/lib/config'
import type { OAuthMessageKey } from '@/lib/i18n/messages'
import { openClientRegistration, type ClientRegistrationPayload } from '@/lib/oauth/tokens'

export interface ResolvedClient {
  clientId: string
  redirectUris: string[]
  clientName?: string
  grantTypes: string[]
  tokenEndpointAuthMethod: 'none'
}

export class ClientError extends Error {
  constructor(
    readonly code: string,
    /** Key into the localized `oauth` message table. */
    readonly descriptionKey: OAuthMessageKey,
    readonly status = 400,
  ) {
    super(descriptionKey)
  }
}

/** Base64url(SHA256(verifier)) === code_challenge, per RFC 7636. */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== 'S256') return false
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/**
 * Redirect URI matching. Exact match wins; loopback URIs may vary the port
 * (RFC 8252 section 7.3), which is what native MCP clients rely on.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true
  try {
    const a = new URL(requested)
    const b = new URL(registered)
    if (a.protocol !== b.protocol) return false
    if (!isLoopback(a.hostname) || !isLoopback(b.hostname)) return false
    return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

async function fetchClientMetadata(clientId: string): Promise<ResolvedClient | null> {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.pathname === '/' || url.pathname === '') return null

  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  let doc: Record<string, unknown>
  try {
    doc = (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }

  if (doc.client_id !== clientId) return null
  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (redirectUris.length === 0) return null

  const grantTypes = Array.isArray(doc.grant_types)
    ? doc.grant_types.filter((entry): entry is string => typeof entry === 'string')
    : ['authorization_code']

  return {
    clientId,
    redirectUris,
    clientName: typeof doc.client_name === 'string' ? doc.client_name : undefined,
    grantTypes,
    tokenEndpointAuthMethod: 'none',
  }
}

/**
 * Resolve a `client_id` from any of the three supported registration mechanisms:
 * pre-registered ids, self-describing ids issued by our DCR endpoint, and
 * Client ID Metadata Documents (CIMD).
 */
export async function resolveClient(clientId: string): Promise<ResolvedClient> {
  if (!clientId) {
    throw new ClientError('invalid_client', 'clientIdRequired')
  }

  const preRegistered = preRegisteredClients().get(clientId)
  if (preRegistered) {
    return {
      clientId,
      redirectUris: preRegistered,
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
    }
  }

  const sealed = await openClientRegistration(clientId)
  if (sealed) {
    const payload: ClientRegistrationPayload = sealed
    return {
      clientId,
      redirectUris: payload.redirectUris,
      clientName: payload.clientName,
      grantTypes: payload.grantTypes,
      tokenEndpointAuthMethod: payload.tokenEndpointAuthMethod,
    }
  }

  const cimd = await fetchClientMetadata(clientId)
  if (cimd) return cimd

  throw new ClientError('invalid_client', 'unknownClient')
}

export function assertRedirectAllowed(client: ResolvedClient, redirectUri: string): void {
  if (!redirectUri) {
    throw new ClientError('invalid_request', 'redirectUriRequired')
  }
  const ok = client.redirectUris.some((registered) => redirectUriMatches(redirectUri, registered))
  if (!ok) {
    throw new ClientError('invalid_request', 'redirectUriNotRegistered')
  }
}

/** Scope requests are intersected with what we can grant and always include read. */
export function normalizeScope(requested: string | null | undefined): string {
  const wanted = (requested ?? '')
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (wanted.length === 0) return 'ncm:read'
  const allowed = wanted.filter((entry) => entry === 'ncm:read' || entry === 'ncm:write')
  if (allowed.length === 0) return 'ncm:read'
  return Array.from(new Set(allowed)).join(' ')
}

export function scopeIncludes(scope: string, wanted: string): boolean {
  return scope.split(' ').includes(wanted)
}
