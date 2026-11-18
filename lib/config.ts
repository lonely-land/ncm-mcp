/**
 * Runtime configuration. Everything here is derived from environment variables so
 * that the same build runs on Vercel, on a plain Node host, or locally.
 */

import { createHash } from 'node:crypto'

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function normalizeOrigin(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * The public origin clients reach this deployment on. On Vercel the production URL
 * is authoritative; preview URLs fall back to `VERCEL_URL`.
 */
export function publicOrigin(): string {
  const explicit = firstNonEmpty(process.env.MCP_PUBLIC_ORIGIN)
  if (explicit) return normalizeOrigin(explicit)

  const vercelProduction = firstNonEmpty(process.env.VERCEL_PROJECT_PRODUCTION_URL)
  if (vercelProduction) return normalizeOrigin(vercelProduction)

  const vercelUrl = firstNonEmpty(process.env.VERCEL_URL)
  if (vercelUrl) return normalizeOrigin(vercelUrl)

  return normalizeOrigin(firstNonEmpty(process.env.NCM_DEV_ORIGIN) ?? 'http://localhost:3000')
}

/** The exact URL clients connect to. Doubles as the OAuth resource / token audience. */
export function mcpResourceUrl(): URL {
  return new URL('/mcp', publicOrigin())
}

export const SCOPES = {
  read: 'ncm:read',
  write: 'ncm:write',
} as const

export const ALL_SCOPES = [SCOPES.read, SCOPES.write]

export const TOKEN_TTL_SECONDS = Number(process.env.NCM_TOKEN_TTL_SECONDS ?? 3600)
export const REFRESH_TTL_SECONDS = Number(process.env.NCM_REFRESH_TTL_SECONDS ?? 60 * 60 * 24 * 30)
export const AUTH_REQUEST_TTL_SECONDS = 600
export const AUTHORIZATION_CODE_TTL_SECONDS = 60

/**
 * Access tokens carry the NetEase cookie jar. Refreshes extend the NetEase session
 * only until this absolute cutoff so a leaked refresh token cannot live forever.
 */
export const SESSION_MAX_AGE_SECONDS = Number(
  process.env.NCM_SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 60,
)

/** Sealing key for every token this server mints. Any sufficiently long string works. */
export function tokenSecret(): Uint8Array {
  const raw = firstNonEmpty(process.env.NCM_TOKEN_SECRET)
  if (!raw) {
    if (process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV?.startsWith('preview')) {
      throw new Error('NCM_TOKEN_SECRET must be set in production')
    }
    // Deterministic dev key so local restarts do not invalidate tokens mid-session.
    return new Uint8Array(
      createHash('sha256').update('ncm-mcp-dev-secret-not-for-production').digest(),
    )
  }
  if (raw.length < 16) {
    throw new Error('NCM_TOKEN_SECRET must be at least 16 characters')
  }
  // A256GCM needs exactly 32 bytes; hashing a longer passphrase keeps operator mistakes
  // (odd lengths, punctuation) from breaking every request.
  return new Uint8Array(createHash('sha256').update(raw, 'utf8').digest())
}

/** Ordered list of toolset groups to expose, or `all`. */
export function enabledToolsets(): Set<string> | 'all' {
  const raw = firstNonEmpty(process.env.NCM_TOOLSETS)
  if (!raw || raw.toLowerCase() === 'all') return 'all'
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
}

export const FALLBACK_RANDOM_CN_IP = process.env.NCM_FALLBACK_RANDOM_CN_IP === 'true'

/** Extra pre-registered clients: `client_id:redirect_uri[,redirect_uri]` pairs. */
export function preRegisteredClients(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const raw = firstNonEmpty(process.env.NCM_PRE_REGISTERED_CLIENTS)
  if (!raw) return map
  for (const entry of raw.split(';')) {
    const [id, uriList] = entry.split(':')
    if (!id || !uriList) continue
    map.set(
      id.trim(),
      uriList
        .split(',')
        .map((uri) => uri.trim())
        .filter(Boolean),
    )
  }
  return map
}
