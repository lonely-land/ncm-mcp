#!/usr/bin/env node
/**
 * Calls every registered read-only tool once and reports which upstreams answered.
 *
 *   node scripts/tools-smoke.mjs [--base http://localhost:3000]
 *
 * Requires a bearer token, because tools/list and tools/call are authenticated:
 *
 *   NCM_SMOKE_TOKEN=<access token> node scripts/tools-smoke.mjs
 *
 * The OAuth e2e script prints an access token when run with --print-token.
 */

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 ? args[baseIndex + 1] : process.env.NCM_E2E_BASE || 'http://localhost:3000'
const TOKEN = process.env.NCM_SMOKE_TOKEN

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
    const result = await mcpCall('tools/call', { name: tool.name, arguments: sample })
    const elapsed = Date.now() - started
    const payload = result.body?.result
    const text = payload?.content?.[0]?.text ?? ''
    const isError = payload?.isError === true || result.status !== 200

    if (!isError && text.trim().length > 0) {
      // Paged tools must tell the model where it is, and no single result may be huge.
      // Small non-list payloads (e.g. a single suggested query) legitimately carry no
      // paging metadata, so only enforce it once the response is substantial.
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
      if (text.length > 20000) {
        rows.push({
          tool: tool.name,
          verdict: 'oversized',
          detail: `${elapsed}ms`,
          text: `${text.length} chars`,
        })
        continue
      }
      rows.push({ tool: tool.name, verdict: 'ok', detail: `${elapsed}ms (${text.length} chars)`, text: text.slice(0, 90) })
      continue
    }

    const needsLogin = /logged-in|needs login|sign in|anonymous|no account/i.test(text)
    if (EXPECTED_LOGIN.has(tool.name) && needsLogin) {
      rows.push({ tool: tool.name, verdict: 'login-required', detail: 'expected', text: text.slice(0, 90) })
      continue
    }

    failures += 1
    rows.push({ tool: tool.name, verdict: 'FAIL', detail: `${elapsed}ms`, text: text.slice(0, 140) })
  }

  for (const row of rows) {
    const mark =
      row.verdict === 'FAIL' ? 'FAIL' : row.verdict === 'ok' ? ' ok ' : row.verdict === 'oversized' ? 'BIG ' : ' -- '
    console.log(`${mark} ${row.tool.padEnd(26)} ${row.verdict.padEnd(15)} ${row.detail}`)
    if ((row.verdict === 'FAIL' || row.verdict === 'oversized') && row.text) {
      console.log(`     ${row.text.replace(/\n/g, ' ')}`)
    }
  }

  const ok = rows.filter((row) => row.verdict === 'ok').length
  const loginRequired = rows.filter((row) => row.verdict === 'login-required').length
  const oversized = rows.filter((row) => row.verdict === 'oversized').length
  const skipped = rows.filter((row) => row.verdict === 'no-sample').length
  console.log(
    `\n${ok} ok, ${loginRequired} need a real login, ${failures} failed, ` +
      `${oversized} oversized (>20000 chars), ${skipped} without a sample call`,
  )
  if (failures > 0 || oversized > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('Smoke run crashed:', error)
  process.exitCode = 1
})
