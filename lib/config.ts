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

/**
 * Tools hidden when `NCM_DISABLED_TOOLS` is unset. Empty by default: no curated tool
 * mutates account personal info or session identity, so the tool layer needs no net.
 * The switch stays available for operators who want one. Names are lower-cased.
 */
export const DEFAULT_DISABLED_TOOLS: readonly string[] = []

function csvSet(raw: string | undefined, fallback: readonly string[]): Set<string> {
  const names = raw === undefined ? fallback : raw.split(',')
  return new Set(
    names
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * Per-tool denylist, subtracted from whatever `NCM_TOOLSETS` enables. An unset
 * variable means `DEFAULT_DISABLED_TOOLS`; a set one — including an empty value —
 * is used verbatim, so an empty list disables nothing.
 */
export function disabledTools(): Set<string> {
  return csvSet(process.env.NCM_DISABLED_TOOLS, DEFAULT_DISABLED_TOOLS)
}

/**
 * Upstream endpoints `ncm_raw` refuses, and that `ncm_list_endpoints` hides. Two
 * reasons only, kept separate below so the intent stays legible:
 *
 * 1. **Account-identity mutation** — renaming, avatar changes, profile settings,
 *    linked-account rebinding, phone replacement and session termination. No curated
 *    tool wraps these, so raw passthrough was the only route to them.
 * 2. **Spends money** — gifting, paid chart placement, coin expenditure, digital-album
 *    ordering. No curated tool spends money either.
 *
 * Everything else stays reachable, including the playlist, comment, like, follow,
 * share, scrobble and cloud-upload writes, `yunbei_sign`-style earns, the purchase
 * *history* reads (`digitalAlbum_purchased`, `song_purchased`, `digitalAlbum_sales`,
 * `yunbei`, `yunbei_info`, `yunbei_receipt`, `vip_*`) and the download-URL endpoints
 * (`song_download_url`, `song_download_url_v1`, `song_cloud_download`), which return
 * URLs without charging.
 */
export const DEFAULT_BLOCKED_RAW_ENDPOINTS: readonly string[] = [
  // --- identity mutation -------------------------------------------------
  // Profile text and avatar.
  'user_update',
  'avatar_upload',
  'setting',
  'user_social_status_edit',
  'activate_init_profile',
  'nickname_check',
  // Linked accounts and phone number.
  'rebind',
  'user_replacephone',
  'user_bindingcellphone',
  // Session identity: logout, remote device eviction, sign-in and registration.
  'logout',
  'device_kickoff',
  'login',
  'login_cellphone',
  'login_qr_check',
  'login_qr_create',
  'login_qr_key',
  'login_refresh',
  'login_status',
  'register_anonimous',
  'register_cellphone',
  'register_checktoken_v2',
  'register_checktoken_v3',
  'register_neapikey',
  'register_xeapikey',
  'captcha_safe_sent',
  'captcha_sent',
  'captcha_sent_v1',
  'captcha_verify',

  // --- spends money ------------------------------------------------------
  'dj_paygift', // radio programme gifting
  'dj_toplist_pay', // paid chart placement
  'yunbei_expense', // coin expenditure
  'digitalAlbum_ordering', // digital album purchase
]

/**
 * Endpoints `ncm_raw` may not proxy. Same semantics as the tool denylist: unset uses
 * `DEFAULT_BLOCKED_RAW_ENDPOINTS`, and a set variable (including an empty one)
 * replaces it, so `NCM_BLOCKED_RAW_ENDPOINTS=` blocks nothing.
 */
export function blockedRawEndpoints(): Set<string> {
  return csvSet(process.env.NCM_BLOCKED_RAW_ENDPOINTS, DEFAULT_BLOCKED_RAW_ENDPOINTS)
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
