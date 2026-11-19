#!/usr/bin/env node
/**
 * Calls every registered read-only tool once and checks the output-shaping contract.
 *
 *   node scripts/tools-smoke.mjs [--base http://localhost:3000]
 *
 * Requires a bearer token, because tools/list and tools/call are authenticated:
 *
 *   NCM_SMOKE_TOKEN=<access token> node scripts/tools-smoke.mjs
 *
 * The OAuth e2e script prints an access token when run with --print-token.
 *
 * Besides "did the upstream answer", every result is checked for the invariants this
 * server promises:
 *
 *   1. JSON results parse. When a body is JSON, no ceiling may sever it.
 *   2. No result exceeds its tool's ceiling (12000, or 16000 for ncm_raw).
 *   3. Paging tiles exactly: pageSize=N returns N rows (or fewer, once the
 *      collection ends) and consecutive pages never repeat or skip an id.
 *   4. hasMore is false on the last page.
 */

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 ? args[baseIndex + 1] : process.env.NCM_E2E_BASE || 'http://localhost:3000'
const TOKEN = process.env.NCM_SMOKE_TOKEN

/** Default result ceiling, and the wider one the raw escape hatch is allowed. */
const DEFAULT_CEILING = 12000
const RAW_CEILING = 16000

/** Arguments each tool needs to make a meaningful upstream call. */
const SAMPLE_ARGS = {
  ncm_search: { keywords: '周杰伦', type: 'song', page: 1, pageSize: 2 },
  ncm_search_cloud: { keywords: 'Jay Chou', type: 'song', page: 1, pageSize: 2 },
  ncm_search_suggest: { keywords: '周杰', page: 1, pageSize: 3 },
  ncm_search_hot: { page: 1, pageSize: 3 },
  ncm_search_multimatch: { keywords: '晴天', pageSize: 3 },
  ncm_search_default: {},
  ncm_search_lyric: { keywords: '故事的小黄花', pageSize: 2 },
  ncm_search_song_page: { keywords: '晴天', page: 1, pageSize: 2 },
  ncm_song_detail: { ids: '347230' },
  ncm_song_url: { ids: '347230', level: 'standard', pageSize: 1 },
  ncm_song_download_url: { id: 347230 },
  ncm_lyric: { id: 347230, maxChars: 400 },
  ncm_lyric_mark: { id: 347230, maxChars: 400 },
  ncm_similar_songs: { id: 347230, pageSize: 2 },
  ncm_song_creators: { id: 347230 },
  ncm_check_music: { id: 347230 },
  ncm_album: { id: 32311, pageSize: 2 },
  ncm_new_albums: { pageSize: 2 },
  ncm_artist: { id: 6452 },
  ncm_artist_songs: { id: 6452, pageSize: 2 },
  ncm_artist_albums: { id: 6452, pageSize: 2 },
  ncm_artist_top_songs: { id: 6452, pageSize: 2 },
  ncm_similar_artists: { id: 6452, pageSize: 2 },
  ncm_playlist: { id: 24381616, pageSize: 2 },
  ncm_playlist_tracks: { id: 24381616, page: 1, pageSize: 2 },
  ncm_related_playlists: { id: 24381616, pageSize: 2 },
  ncm_mv_url: { id: 5436712 },
  ncm_mv_detail: { mvid: 5436712 },
  ncm_account_status: {},
  ncm_account_profile: {},
  ncm_user_detail: { uid: 32953014 },
  ncm_user_follows: { uid: 32953014, pageSize: 2 },
  ncm_user_followeds: { uid: 32953014, pageSize: 2 },
  ncm_vip_info: {},
  ncm_personalized: { pageSize: 2 },
  ncm_recommend_songs: { pageSize: 2 },
  ncm_recommend_resource: { pageSize: 2 },
  ncm_new_songs: { pageSize: 2 },
  ncm_toplist: { pageSize: 2 },
  ncm_toplist_detail: { pageSize: 2 },
  ncm_toplist_songs: { id: 19723756, pageSize: 2 },
  ncm_banner: { pageSize: 2 },
  ncm_top_songs: { area: 'all', pageSize: 2 },
  ncm_top_playlists: { pageSize: 2 },
  ncm_top_artists: { pageSize: 2 },
  ncm_music_calendar: { startTime: Date.now() - 7 * 86400000, endTime: Date.now(), pageSize: 2 },
  ncm_comments: { type: 'song', id: 347230, pageSize: 2 },
  ncm_comment_hot: { id: 347230, pageSize: 2 },
  ncm_user_events: { uid: 32953014, pageSize: 2 },
  ncm_similar_users: { id: 32953014, pageSize: 2 },
  ncm_radio_detail: { rid: 336355127, pageSize: 2 },
  ncm_subscribed_artists: { pageSize: 2 },
  ncm_liked_songs: { pageSize: 5 },
  ncm_recent_songs: { pageSize: 2 },
  ncm_my_playlists: { pageSize: 2 },
  ncm_cloud_songs: { pageSize: 2 },
  ncm_download_list: { pageSize: 2 },
  ncm_listen_stats: {},
  ncm_user_binding: {},
  ncm_yunbei: {},
  ncm_user_level: {},
  ncm_user_counts: {},
  ncm_list_endpoints: { filter: 'song', pageSize: 5 },
  ncm_raw: { endpoint: 'song_detail', params: { ids: '347230' }, maxChars: 400 },
  ncm_about: {},
}

/**
 * Tools exercised for the paging contract. Only stable collections are used: a feed
 * that reshuffles on every request (e.g. daily recommendations) cannot be tiled.
 * `rowsPath` is the array the tool pages; rendered tools are parsed by `id=`.
 */
const PAGING_PROBES = [
  { name: 'ncm_top_playlists', args: { pageSize: 5 }, rowsPath: 'playlists' },
  { name: 'ncm_top_artists', args: { pageSize: 5 }, rowsPath: 'artists' },
  { name: 'ncm_new_albums', args: { pageSize: 5 }, rowsPath: 'albums' },
  { name: 'ncm_top_songs', args: { area: 'all', pageSize: 5 }, rowsPath: 'data' },
  { name: 'ncm_toplist', args: { pageSize: 5 }, rowsPath: 'list' },
]

/**
 * Stress calls: the arguments that used to produce an oversized or severed result.
 * Each is checked for its ceiling and for parseable JSON; these are the cases where a
 * "pass" on a normal-sized sample would hide the defect.
 */
const STRESS_CALLS = [
  // Unbounded maxChars was accepted and produced 240k characters.
  { name: 'ncm_lyric', args: { id: 347230, maxChars: 80000, includeLrc: true } },
  { name: 'ncm_lyric', args: { id: 347230, maxChars: 5000, includeLrc: true } },
  { name: 'ncm_comment_hot', args: { id: 347230, pageSize: 100 } },
  { name: 'ncm_comments', args: { type: 'song', id: 347230, pageSize: 100 } },
  { name: 'ncm_top_playlists', args: { pageSize: 100 } },
  { name: 'ncm_top_artists', args: { pageSize: 100 } },
  { name: 'ncm_top_songs', args: { area: 'all', pageSize: 100 } },
  { name: 'ncm_new_albums', args: { pageSize: 100 } },
  // ncm_raw over the largest anonymous payload, with limit/offset as real inputs.
  { name: 'ncm_raw', args: { endpoint: 'user_playlist', params: { uid: 32953014 } } },
  { name: 'ncm_raw', args: { endpoint: 'user_playlist', params: { uid: 32953014 }, limit: 3 } },
  { name: 'ncm_raw', args: { endpoint: 'top_playlist', limit: 50, offset: 0, maxChars: 5000 } },
]

/**
 * Tools whose upstream call needs a real account. They still count as healthy when they
 * return the server's coherent "needs login" message instead of data.
 */
const EXPECTED_LOGIN = new Set([
  'ncm_user_level',
  'ncm_user_counts',
  'ncm_vip_info',
  'ncm_liked_songs',
  'ncm_recent_songs',
  'ncm_my_playlists',
  'ncm_cloud_songs',
  'ncm_download_list',
  'ncm_listen_stats',
  'ncm_user_binding',
  'ncm_yunbei',
  'ncm_account_profile',
  'ncm_subscribed_artists',
])

let failures = 0
let checks = 0

async function mcpCall(method, params) {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  })
  const text = await response.text()
  const dataLine = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .pop()
  return { status: response.status, body: dataLine ? JSON.parse(dataLine) : null }
}

/** Split a result into its JSON body and any trailing paging footer. */
function splitResult(text) {
  const lines = text.split('\n')
  let footerStart = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (/^([^\n]{0,40}: )?paging: /.test(line)) footerStart = index
    else break
  }
  if (footerStart < 0) return { body: text, footer: '' }
  return { body: lines.slice(0, footerStart).join('\n').trimEnd(), footer: lines.slice(footerStart).join('\n') }
}

function looksJson(text) {
  const first = text.trim()[0]
  return first === '{' || first === '['
}

/**
 * Checks every result for the two invariants that must always hold: JSON parses,
 * and nothing exceeds the ceiling. Returns a verdict string.
 */
function checkResult(tool, text) {
  const ceiling = tool === 'ncm_raw' ? RAW_CEILING : DEFAULT_CEILING
  if (text.length > ceiling) return { verdict: 'oversized', detail: `${text.length} > ${ceiling} chars` }
  const { body } = splitResult(text)
  if (looksJson(body)) {
    try {
      JSON.parse(body)
    } catch (error) {
      return { verdict: 'invalid-json', detail: `${body.length} chars: ${error.message.slice(0, 70)}` }
    }
  }
  return { verdict: 'ok', detail: '' }
}

/** Rows of a paging probe, parsed from either JSON or a rendered footer. */
function rowsOf(payload) {
  const { body, footer } = splitResult(payload.text)
  if (looksJson(body)) {
    try {
      const parsed = JSON.parse(body)
      const rows = parsed?.[payload.rowsPath]
      return {
        rows: Array.isArray(rows) ? rows : [],
        meta: parsed?.paging?.[payload.rowsPath],
        footer,
      }
    } catch {
      return { rows: [], meta: undefined, footer }
    }
  }
  // A rendered list: one line per item, ids as `id=NNN`.
  const rows = body
    .split('\n')
    .map((line) => /(?:^|\s)id=(\w+)/.exec(line)?.[1])
    .filter((id) => id !== undefined)
    .map((id) => ({ id }))
  return { rows, meta: undefined, footer }
}

/**
 * Check a probe's pages tile exactly.
 *
 * A long walk is unreliable because the upstream feeds shift while it runs (a 100-page
 * walk takes minutes), so tiling is checked over consecutive pages 1..N, and the last
 * page is fetched directly from the reported total to assert `hasMore=false` there.
 */
async function checkTiling(probe, pageSize, firstMeta) {
  const seen = new Set()
  const window = 4
  let page = 1
  let total = firstMeta?.total
  for (; page <= window; page += 1) {
    const result = page === 1 ? probe.first : await callTool(probe.name, { ...probe.args, page })
    if (result.isError) return { ok: false, detail: `page ${page} errored` }
    const parsed = rowsOf({ text: result.text, rowsPath: probe.rowsPath })
    const footer = footerMeta(parsed.footer)
    total = parsed.meta?.total ?? footer.total ?? total
    if (parsed.rows.length > pageSize) {
      return { ok: false, detail: `page ${page} returned ${parsed.rows.length} rows for pageSize=${pageSize}` }
    }
    const hasMore = parsed.meta?.hasMore ?? footer.hasMore
    const reachedTotal = total !== undefined && page * pageSize >= total
    // Every page before the last must be full.
    if (!reachedTotal && hasMore !== false && parsed.rows.length !== pageSize) {
      return { ok: false, detail: `page ${page} is short (${parsed.rows.length}) but not the last page` }
    }
    if (parsed.rows.length === 0) {
      return { ok: false, detail: `page ${page} is empty while hasMore=${hasMore}` }
    }
    for (const row of parsed.rows) {
      const id = row[probe.idField] ?? row.id
      if (seen.has(id)) return { ok: false, detail: `id ${id} repeats on page ${page}` }
      seen.add(id)
    }
    if (hasMore === false || reachedTotal) break
  }

  // The final page must not claim there is more.
  let lastDetail = 'total unknown, last page not probed'
  if (total !== undefined) {
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const last = await callTool(probe.name, { ...probe.args, page: lastPage })
    if (last.isError) return { ok: false, detail: `last page ${lastPage} errored` }
    const parsed = rowsOf({ text: last.text, rowsPath: probe.rowsPath })
    const hasMore = parsed.meta?.hasMore ?? footerMeta(parsed.footer).hasMore
    if (hasMore === true) {
      return { ok: false, detail: `page ${lastPage} of ${total} still reports hasMore=true` }
    }
    lastDetail = `page ${lastPage} of ${total} has hasMore=false`
  }
  return {
    ok: true,
    detail:
      `pages 1-${Math.min(page, window)} tile at ${pageSize} rows each, ${seen.size} distinct ids; ` +
      lastDetail,
  }
}

/** `page 1 · 5 playlists · items 1-5 of 680 · hasMore=true · next: page=2` */
function footerMeta(footer) {
  const hasMore = /hasMore=(true|false)/.exec(footer)
  const total = /of (\d+)/.exec(footer)
  return {
    hasMore: hasMore ? hasMore[1] === 'true' : undefined,
    total: total ? Number(total[1]) : undefined,
  }
}

async function callTool(name, toolArgs) {
  const result = await mcpCall('tools/call', { name, arguments: toolArgs })
  const payload = result.body?.result
  const text = payload?.content?.[0]?.text ?? ''
  const isError = payload?.isError === true || result.status !== 200
  return { text, isError, status: result.status }
}

async function main() {
  if (!TOKEN) {
    console.error('NCM_SMOKE_TOKEN is required. Run scripts/oauth-e2e.mjs --print-token to obtain one.')
    process.exit(2)
  }

  console.log(`NeteaseCloudMusic MCP — tool smoke against ${BASE}`)
  const list = await mcpCall('tools/list', {})
  const tools = list.body?.result?.tools ?? []
  if (tools.length === 0) {
    console.error('tools/list returned nothing; check the token.')
    process.exit(1)
  }
  console.log(`${tools.length} tools registered\n`)

  const rows = []
  for (const tool of tools) {
    const sample = SAMPLE_ARGS[tool.name]
    if (!sample) {
      rows.push({ tool: tool.name, verdict: 'no-sample', detail: 'not covered by this script' })
      continue
    }
    checks += 1
    const started = Date.now()
    const { text, isError, status } = await callTool(tool.name, sample)
    const elapsed = Date.now() - started

    if (!isError && text.trim().length > 0) {
      // Paged tools must tell the model where it is.
      const paged = 'pageSize' in sample || 'page' in sample
      const showsPaging = /page \d+ · |"paging"|paging:/i.test(text)
      if (paged && !showsPaging && text.length > 300) {
        failures += 1
        rows.push({
          tool: tool.name,
          verdict: 'FAIL',
          detail: `${elapsed}ms`,
          text: `paged tool returned ${text.length} chars with no paging metadata`,
        })
        continue
      }
      const shape = checkResult(tool.name, text)
      if (shape.verdict !== 'ok') {
        failures += 1
        rows.push({ tool: tool.name, verdict: shape.verdict.toUpperCase(), detail: `${elapsed}ms`, text: shape.detail })
        continue
      }
      rows.push({
        tool: tool.name,
        verdict: 'ok',
        detail: `${elapsed}ms (${text.length} chars)`,
        text: text.slice(0, 90),
      })
      continue
    }

    const needsLogin = /logged-in|needs login|sign in|anonymous|no account/i.test(text)
    if (EXPECTED_LOGIN.has(tool.name) && needsLogin) {
      rows.push({ tool: tool.name, verdict: 'login-required', detail: 'expected', text: text.slice(0, 90) })
      continue
    }

    failures += 1
    rows.push({ tool: tool.name, verdict: 'FAIL', detail: `${elapsed}ms (status ${status})`, text: text.slice(0, 140) })
  }

  // --- Paging contract -----------------------------------------------------
  const pagingChecks = []
  for (const probe of PAGING_PROBES) {
    if (!tools.some((tool) => tool.name === probe.name)) continue
    const pageSize = probe.args.pageSize
    const first = await callTool(probe.name, { ...probe.args, page: 1 })
    if (first.isError) {
      pagingChecks.push({ name: probe.name, verdict: 'skip', detail: 'upstream needs a login or risk gate' })
      continue
    }
    const firstParsed = rowsOf({ text: first.text, rowsPath: probe.rowsPath })
    const firstMeta = firstParsed.meta ?? footerMeta(firstParsed.footer)
    const tiling = await checkTiling({ ...probe, first }, pageSize, firstMeta)
    if (!tiling.ok) {
      failures += 1
      pagingChecks.push({ name: probe.name, verdict: 'FAIL', detail: tiling.detail })
      continue
    }
    pagingChecks.push({
      name: probe.name,
      verdict: 'ok',
      detail: `pageSize=${pageSize}; ${tiling.detail}`,
    })
  }

  // --- Stress pass ---------------------------------------------------------
  // The oversized cases: a normal-sized sample can pass while the worst case still
  // severs JSON or blows past the ceiling.
  const stressChecks = []
  for (const call of STRESS_CALLS) {
    if (!tools.some((tool) => tool.name === call.name)) continue
    const result = await callTool(call.name, call.args)
    if (result.isError) {
      stressChecks.push({ name: call.name, args: call.args, verdict: 'skip', detail: 'upstream gate' })
      continue
    }
    const shape = checkResult(call.name, result.text)
    const ceiling = call.name === 'ncm_raw' ? RAW_CEILING : DEFAULT_CEILING
    if (shape.verdict !== 'ok') {
      failures += 1
      stressChecks.push({ name: call.name, args: call.args, verdict: 'FAIL', detail: shape.detail })
      continue
    }
    // The truncated result must still say what was lost, not only how many characters.
    const { body } = splitResult(result.text)
    const noticeMentionsItems = /"field":|dropped \d+ of/.test(body)
    if (result.text.length > ceiling * 0.9 && !noticeMentionsItems) {
      failures += 1
      stressChecks.push({
        name: call.name,
        args: call.args,
        verdict: 'FAIL',
        detail: `${result.text.length} chars with no item-level truncation notice`,
      })
      continue
    }
    stressChecks.push({
      name: call.name,
      args: call.args,
      verdict: 'ok',
      detail: `${result.text.length}/${ceiling} chars, JSON ${looksJson(body) ? 'valid' : 'n/a'}` +
        `${noticeMentionsItems ? ', notice names items' : ''}`,
    })
  }
  checks += stressChecks.length

  for (const row of rows) {
    const mark =
      row.verdict === 'FAIL'
        ? 'FAIL'
        : row.verdict === 'ok'
          ? ' ok '
          : row.verdict === 'OVERSIZED' || row.verdict === 'INVALID-JSON'
            ? 'BAD '
            : ' -- '
    console.log(`${mark} ${row.tool.padEnd(26)} ${row.verdict.padEnd(15)} ${row.detail}`)
    if ((row.verdict === 'FAIL' || row.verdict === 'OVERSIZED' || row.verdict === 'INVALID-JSON') && row.text) {
      console.log(`     ${row.text.replace(/\n/g, ' ')}`)
    }
  }

  if (pagingChecks.length > 0) {
    console.log('\nPaging contract')
    for (const check of pagingChecks) {
      const mark = check.verdict === 'FAIL' ? 'FAIL' : check.verdict === 'ok' ? ' ok ' : ' -- '
      console.log(`${mark} ${check.name.padEnd(26)} ${check.detail}`)
    }
    checks += pagingChecks.length
  }

  if (stressChecks.length > 0) {
    console.log('\nOversize stress')
    for (const check of stressChecks) {
      const mark = check.verdict === 'FAIL' ? 'FAIL' : check.verdict === 'ok' ? ' ok ' : ' -- '
      console.log(`${mark} ${check.name.padEnd(26)} ${check.detail}`)
      console.log(`     args ${JSON.stringify(check.args)}`)
    }
  }

  const ok = rows.filter((row) => row.verdict === 'ok').length
  const loginRequired = rows.filter((row) => row.verdict === 'login-required').length
  const oversized = rows.filter((row) => row.verdict === 'OVERSIZED').length
  const invalidJson = rows.filter((row) => row.verdict === 'INVALID-JSON').length
  const skipped = rows.filter((row) => row.verdict === 'no-sample').length
  const stressFailed = stressChecks.filter((check) => check.verdict === 'FAIL').length
  const pagingFailed = pagingChecks.filter((check) => check.verdict === 'FAIL').length
  console.log(
    `${checks} checks · ${ok} tools ok · ${loginRequired} need a real login · ${failures} failed · ` +
      `${oversized} oversized (>${DEFAULT_CEILING} chars) · ${invalidJson} invalid JSON · ` +
      `${skipped} without a sample call`,
  )
  console.log(`paging failures: ${pagingFailed} · oversize failures: ${stressFailed}`)
  if (failures > 0 || oversized > 0 || invalidJson > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('Smoke run crashed:', error)
  process.exitCode = 1
})
