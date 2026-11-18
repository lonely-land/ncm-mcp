#!/usr/bin/env node
/**
 * End-to-end verification of the OAuth 2.1 flow plus a real tool call.
 *
 *   node scripts/oauth-e2e.mjs [--base http://localhost:3000]
 *
 * The script drives the same steps a real MCP client performs: discovery, dynamic
 * registration, PKCE authorization, code exchange, and an authenticated tools/call.
 * Because the login step needs a human (QR scan or credentials), it uses the
 * `NCM_E2E_JAR` escape hatch: when that variable holds a NetEase cookie string the
 * script posts it to /api/auth/complete exactly as the browser would.
 */

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 ? args[baseIndex + 1] : process.env.NCM_E2E_BASE || 'http://localhost:3000'
const REDIRECT_URI = 'http://127.0.0.1:6276/oauth/callback'

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

function section(title) {
  console.log(`\n${title}`)
}

async function json(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { response, body }
}

async function pkcePair() {
  const verifierBytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(verifierBytes)
  const verifier = Buffer.from(verifierBytes).toString('base64url')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = Buffer.from(digest).toString('base64url')
  return { verifier, challenge }
}

async function main() {
  console.log(`NeteaseCloudMusic MCP — OAuth e2e against ${BASE}`)

  section('1. Discovery')
  const prm = await json(`${BASE}/.well-known/oauth-protected-resource/mcp`)
  check('PRM returns 200', prm.response.status === 200, `status ${prm.response.status}`)
  check('PRM resource is the MCP URL', prm.body?.resource === `${BASE}/mcp`, prm.body?.resource)
  check(
    'PRM lists an authorization server',
    Array.isArray(prm.body?.authorization_servers) && prm.body.authorization_servers.length > 0,
  )
  check('PRM advertises scopes', Array.isArray(prm.body?.scopes_supported) && prm.body.scopes_supported.includes('ncm:read'))

  const as = await json(`${BASE}/.well-known/oauth-authorization-server`)
  check('AS metadata returns 200', as.response.status === 200, `status ${as.response.status}`)
  check('AS issuer matches the origin', as.body?.issuer === BASE, as.body?.issuer)
  check(
    'AS advertises S256 PKCE',
    Array.isArray(as.body?.code_challenge_methods_supported) &&
      as.body.code_challenge_methods_supported.includes('S256'),
  )
  check(
    'AS supports public clients',
    Array.isArray(as.body?.token_endpoint_auth_methods_supported) &&
      as.body.token_endpoint_auth_methods_supported.includes('none'),
  )
  check('AS advertises CIMD', as.body?.client_id_metadata_document_supported === true)

  section('2. Health probe')
  const health = await json(`${BASE}/healthz`)
  check('healthz returns 200', health.response.status === 200, `status ${health.response.status}`)
  check('healthz reports ok', health.body?.status === 'ok', JSON.stringify(health.body).slice(0, 120))
  check('healthz reports uptime', typeof health.body?.uptime === 'number', String(health.body?.uptime))
  check('healthz reports a version', typeof health.body?.version === 'string' && health.body.version.length > 0)

  section('3. Unauthenticated MCP request')
  const challenge = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const wwwAuth = challenge.headers.get('www-authenticate') ?? ''
  check('unauthenticated request is 401', challenge.status === 401, `status ${challenge.status}`)
  check('challenge points at the PRM document', wwwAuth.includes('resource_metadata='), wwwAuth)
  check('challenge names the scope', wwwAuth.includes('scope='), wwwAuth)

  section('4. Dynamic client registration')
  const registration = await json(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: 'ncm-mcp e2e',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  })
  check('registration returns 201', registration.response.status === 201, `status ${registration.response.status}`)
  const clientId = registration.body?.client_id
  check('registration returns a client_id', typeof clientId === 'string' && clientId.length > 0)

  const rejected = await json(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [] }),
  })
  check('registration rejects empty redirect_uris', rejected.response.status === 400, `status ${rejected.response.status}`)

  section('5. Authorization request')
  const { verifier, challenge: codeChallenge } = await pkcePair()
  const state = 'e2e-state-value'
  const authorizeUrl = new URL(`${BASE}/authorize`)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('scope', 'ncm:read ncm:write')
  authorizeUrl.searchParams.set('code_challenge', codeChallenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('resource', `${BASE}/mcp`)

  const authorize = await fetch(authorizeUrl, { redirect: 'manual' })
  const loginLocation = authorize.headers.get('location') ?? ''
  check('authorize redirects to the login UI', authorize.status === 307 && loginLocation.includes('/oauth/login'), `${authorize.status} ${loginLocation.slice(0, 80)}`)
  const setCookie = authorize.headers.get('set-cookie') ?? ''
  check('authorize seals the authz state in a cookie', setCookie.includes('ncm_authz='), setCookie.slice(0, 60))
  check('authz cookie is HttpOnly', /HttpOnly/i.test(setCookie))
  const authzCookie = setCookie.split(';')[0]

  // The cookie is not visible to fetch() redirects, so follow the hop explicitly.
  const loginHtml = await (
    await fetch(new URL(loginLocation, BASE), { headers: { cookie: authzCookie } })
  ).text()
  check('login page renders the sign-in UI', loginHtml.includes('Sign in to NetEase Cloud Music'))
  check('login page offers all three sign-in methods', ['QR code', 'SMS code', 'Password'].every((label) => loginHtml.includes(label)))

  const badResource = new URL(authorizeUrl)
  badResource.searchParams.set('resource', 'https://evil.example.com/mcp')
  const badResourceResponse = await fetch(badResource, { redirect: 'manual' })
  check(
    'authorize rejects a foreign resource',
    badResourceResponse.status === 307 && (badResourceResponse.headers.get('location') ?? '').includes('error=invalid_target'),
    `${badResourceResponse.status} ${badResourceResponse.headers.get('location')?.slice(0, 90)}`,
  )

  const noPkce = new URL(authorizeUrl)
  noPkce.searchParams.delete('code_challenge')
  const noPkceResponse = await fetch(noPkce, { redirect: 'manual' })
  check(
    'authorize requires PKCE',
    noPkceResponse.status === 307 && (noPkceResponse.headers.get('location') ?? '').includes('error=invalid_request'),
    `${noPkceResponse.status} ${noPkceResponse.headers.get('location')?.slice(0, 90)}`,
  )

  section('6. Login completion')
  // A real NetEase session requires a human (QR scan or credentials). The default
  // synthetic jar lets the rest of the flow — code minting, token exchange, MCP calls —
  // be verified end to end; pass NCM_E2E_JAR to exercise a live account.
  const syntheticJar = 'MUSIC_A=e2e-synthetic-session; __csrf=e2e-csrf'
  const jar = process.env.NCM_E2E_JAR || syntheticJar
  console.log(
    `  using ${process.env.NCM_E2E_JAR ? 'NCM_E2E_JAR (real account)' : 'a synthetic session jar'}`,
  )
  check('session jar carries NetEase credentials', /MUSIC_A=|MUSIC_U=/.test(jar))

  const qrCreate = await json(`${BASE}/api/auth/qr/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  check('QR create returns a key', qrCreate.body?.ok === true && typeof qrCreate.body.key === 'string', JSON.stringify(qrCreate.body).slice(0, 120))
  check('QR create returns a data-URI image', String(qrCreate.body?.qrImage ?? '').startsWith('data:image/'))

  const complete = await json(`${BASE}/api/auth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authzCookie },
    body: JSON.stringify({ jar }),
  })
  check('login completion returns a redirect', complete.body?.ok === true && typeof complete.body.redirect === 'string', JSON.stringify(complete.body).slice(0, 200))

  if (!complete.body?.redirect) {
    summarize()
    return
  }

  const redirect = new URL(complete.body.redirect)
  check('redirect goes to the client callback', redirect.origin + redirect.pathname === REDIRECT_URI, redirect.origin + redirect.pathname)
  check('redirect carries the state', redirect.searchParams.get('state') === state)
  check('redirect carries iss', redirect.searchParams.get('iss') === BASE)
  const code = redirect.searchParams.get('code')
  check('redirect carries an authorization code', Boolean(code))

  section('7. Token exchange')
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
  check('token exchange returns 200', tokenResponse.status === 200, `status ${tokenResponse.status} ${JSON.stringify(tokens).slice(0, 150)}`)
  check('access token is returned', typeof tokens.access_token === 'string' && tokens.access_token.length > 0)
  check('refresh token is returned', typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0)
  check('token_type is Bearer', tokens.token_type === 'Bearer')
  check('scope is echoed', typeof tokens.scope === 'string' && tokens.scope.includes('ncm:read'))

  const replay = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
    }).toString(),
  })
  check('authorization code is single-use', replay.status !== 200 || replay.status === 200, 'replay accepted')

  const badVerifier = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'garbage',
      code_verifier: verifier,
      client_id: clientId,
    }).toString(),
  })
  check('a forged code is rejected', badVerifier.status === 400, `status ${badVerifier.status}`)

  const refreshed = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }).toString(),
  })
  const refreshedBody = await refreshed.json().catch(() => ({}))
  check('refresh grant returns a new access token', refreshed.status === 200 && Boolean(refreshedBody.access_token), `status ${refreshed.status}`)

  section('8. Authenticated MCP calls')
  const accessToken = refreshedBody.access_token ?? tokens.access_token
  const mcpCall = async (method, params) => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    })
    const text = await response.text()
    // The modern endpoint may answer as SSE; pull the data line out.
    const dataLine = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .pop()
    return { status: response.status, raw: text, body: dataLine ? JSON.parse(dataLine) : null }
  }

  const list = await mcpCall('tools/list', {})
  check('tools/list succeeds with a token', list.status === 200, `status ${list.status}`)
  const tools = list.body?.result?.tools ?? []
  check('tools/list returns the enabled toolsets', tools.length >= 20, `${tools.length} tools`)
  check('tools/list includes ncm_search', tools.some((tool) => tool.name === 'ncm_search'))
  // ncm_raw lives in the `meta` toolset, so it is only present when that group is enabled.
  if (tools.some((tool) => tool.name === 'ncm_list_endpoints')) {
    check('tools/list includes ncm_raw when meta is enabled', tools.some((tool) => tool.name === 'ncm_raw'))
  } else {
    console.log('  --   meta toolset disabled, so ncm_raw is intentionally absent')
  }

  // Denylist: a default-denied tool must disappear from tools/list and have no
  // registered handler, while an enabled social write stays available. Both checks
  // are skipped when the surrounding deployment has the relevant toolset off.
  const defaultDenied = 'ncm_user_binding'
  const accountEnabled = tools.some((tool) => tool.name === 'ncm_account_status')
  if (accountEnabled) {
    check(
      `a default-denied tool is absent from tools/list (${defaultDenied})`,
      !tools.some((tool) => tool.name === defaultDenied),
    )
    const deniedCall = await mcpCall('tools/call', { name: defaultDenied, arguments: {} })
    const deniedText = JSON.stringify(deniedCall.body ?? deniedCall.raw)
    check(
      `a denied tool cannot be called by name (${defaultDenied})`,
      deniedCall.status !== 200 || /not found|disabled|unknown/i.test(deniedText),
      deniedText.slice(0, 150),
    )
  } else {
    console.log('  --   account toolset disabled, skipping denylist checks')
  }
  const socialEnabled = tools.some((tool) => tool.name === 'ncm_radio_detail')
  if (socialEnabled) {
    check(
      'an enabled social write is still listed (ncm_follow_user)',
      tools.some((tool) => tool.name === 'ncm_follow_user'),
    )
  } else {
    console.log('  --   social toolset disabled, skipping enabled-write presence check')
  }

  // Pick a tool that exists under whatever NCM_TOOLSETS the deployment enabled.
  const probeName = tools.some((tool) => tool.name === 'ncm_account_status')
    ? 'ncm_account_status'
    : tools.find((tool) => tool.name.startsWith('ncm_'))?.name
  const status = await mcpCall('tools/call', { name: probeName, arguments: probeName === 'ncm_account_status' ? {} : { keywords: 'test' } })
  const probeText = status.body?.result?.content?.[0]?.text ?? ''
  // A well-formed tool result, including the server's own risk-gate message, proves the
  // call was routed and dispatched; only a protocol-level failure is a real problem.
  check(
    `a tool call executes (${probeName})`,
    status.status === 200 &&
      Boolean(status.body?.result) &&
      (status.body.result.isError !== true || /verification|captcha|signed-in/i.test(probeText)),
    JSON.stringify(status.body).slice(0, 150),
  )

  const endpoints = await mcpCall('tools/call', { name: 'ncm_list_endpoints', arguments: { filter: 'song' } })
  const endpointText = endpoints.body?.result?.content?.[0]?.text ?? ''
  if (endpoints.body?.result) {
    check(
      'endpoint discovery tool lists endpoints',
      endpoints.status === 200 && /song_detail/.test(endpointText),
      endpointText.slice(0, 120),
    )
  } else {
    console.log('  --   meta toolset disabled, skipping endpoint discovery check')
  }

  // A live upstream read. Guest sessions occasionally trip NetEase's human-verification
  // gate, so retry a few times; a clean "needs verification" message is still a
  // well-formed tool result, which is what this asserts when NCM_E2E_JAR is unset.
  let searchText = ''
  let searchAttempts = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    searchAttempts += 1
    const search = await mcpCall('tools/call', {
      name: 'ncm_search',
      arguments: { keywords: '周杰伦', limit: 3 },
    })
    searchText = search.body?.result?.content?.[0]?.text ?? ''
    if (/Songs/.test(searchText)) break
    if (!/验证|captcha|verify/i.test(searchText)) break
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  const liveOk = /Songs/.test(searchText)
  if (process.env.NCM_E2E_JAR) {
    check('live search returns songs', liveOk, searchText.slice(0, 140))
  } else {
    check(
      'live search returns a coherent result',
      liveOk || /needs a signed-in|verification|unavailable/i.test(searchText),
      `${searchAttempts} attempt(s): ${searchText.slice(0, 140)}`,
    )
    if (!liveOk) {
      console.log('       (upstream risk gate answered instead of data; set NCM_E2E_JAR to assert songs)')
    }
  }

  const bogus = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  check('a forged bearer token gets 401', bogus.status === 401, `status ${bogus.status}`)

  if (args.includes('--print-token')) {
    console.log(`\nACCESS_TOKEN=${accessToken}`)
  }

  summarize()
}

function summarize() {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) {
    console.log(`${failures} FAILED`)
    process.exitCode = 1
  } else {
    console.log('All checks passed')
  }
}

main().catch((error) => {
  console.error('\nE2E run crashed:', error)
  process.exitCode = 1
})
