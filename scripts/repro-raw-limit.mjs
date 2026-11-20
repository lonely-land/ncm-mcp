#!/usr/bin/env node
/**
 * Live-HTTP reproduction harness for ncm_raw's limit/offset window.
 *
 *   node scripts/repro-raw-limit.mjs [--base http://localhost:3000]
 *
 * Mints a real access token through the OAuth flow, then calls ncm_raw with the same
 * argument shapes a caller uses and prints the exact result: item counts per array,
 * `more`, the `request` echo, and any truncation notice.
 */

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 ? args[baseIndex + 1] : process.env.NCM_E2E_BASE || 'http://localhost:3000'
const REDIRECT_URI = 'http://127.0.0.1:6276/oauth/callback'

async function json(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  try {
    return { response, body: JSON.parse(text) }
  } catch {
    return { response, body: text }
  }
}

async function pkcePair() {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const verifier = Buffer.from(bytes).toString('base64url')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(digest).toString('base64url') }
}

async function mintToken() {
  const registration = await json(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: 'raw-limit repro',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const clientId = registration.body?.client_id
  if (!clientId) throw new Error(`registration failed: ${JSON.stringify(registration.body).slice(0, 200)}`)

  const { verifier, challenge } = await pkcePair()
  const url = new URL(`${BASE}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', 'ncm:read ncm:write')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'repro')
  url.searchParams.set('resource', `${BASE}/mcp`)

  const authorize = await fetch(url, { redirect: 'manual' })
  const authzCookie = (authorize.headers.get('set-cookie') ?? '').split(';')[0]
  const complete = await json(`${BASE}/api/auth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authzCookie },
    body: JSON.stringify({ jar: 'MUSIC_A=repro-anonymous-session; __csrf=repro-csrf' }),
  })
  const code = new URL(complete.body?.redirect ?? 'http://invalid/').searchParams.get('code')
  if (!code) throw new Error(`login completion failed: ${JSON.stringify(complete.body).slice(0, 200)}`)

  const tokenResponse = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${BASE}/mcp`,
    }).toString(),
  })
  const tokens = await tokenResponse.json().catch(() => ({}))
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens).slice(0, 200)}`)
  return tokens.access_token
}

async function callTool(token, name, toolArgs) {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: toolArgs } }),
  })
  const text = await response.text()
  const dataLine = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .pop()
  const body = dataLine ? JSON.parse(dataLine) : null
  return { status: response.status, text: body?.result?.content?.[0]?.text ?? '', isError: body?.result?.isError === true }
}

/** Summarise one ncm_raw result: array lengths, more, request echo, truncation. */
function summarize(text) {
  const trimmed = text.trim()
  if (trimmed[0] !== '{') return { raw: text.slice(0, 400) }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { invalidJson: true, raw: text.slice(0, 400) }
  }
  const arrays = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) arrays[key] = value.length
  }
  return {
    chars: text.length,
    arrays,
    more: parsed.more,
    request: parsed.request,
    paging: parsed.paging,
    truncated: parsed.truncated,
  }
}

const CASES = [
  { label: 'user_playlist limit=2 (top-level)', args: { endpoint: 'user_playlist', params: { uid: 32953014 }, limit: 2 } },
  { label: 'user_playlist limit=2 (inside params)', args: { endpoint: 'user_playlist', params: { uid: 32953014, limit: 2 } } },
  { label: 'user_playlist no limit', args: { endpoint: 'user_playlist', params: { uid: 32953014 } } },
  { label: 'simi_song limit=2 (endpoint ignores limit)', args: { endpoint: 'simi_song', params: { id: 347230 }, limit: 2 } },
  { label: 'simi_song no limit', args: { endpoint: 'simi_song', params: { id: 347230 } } },
  { label: 'toplist no limit (65 rows upstream)', args: { endpoint: 'toplist', params: {} } },
  { label: 'toplist limit=2', args: { endpoint: 'toplist', params: {}, limit: 2 } },
]

async function main() {
  const token = await mintToken()
  console.log(`ncm_raw limit reproduction against ${BASE}\n`)
  for (const probe of CASES) {
    const result = await callTool(token, 'ncm_raw', probe.args)
    console.log(`--- ${probe.label}`)
    console.log(`    args: ${JSON.stringify(probe.args)}`)
    console.log(`    result: ${JSON.stringify(summarize(result.text))}`)
    if (result.isError) console.log(`    isError: true ${result.text.slice(0, 200)}`)
    console.log()
  }
}

main().catch((error) => {
  console.error('repro crashed:', error)
  process.exitCode = 1
})
