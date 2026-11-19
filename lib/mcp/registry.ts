import type { ToolAnnotations } from '@modelcontextprotocol/server'
import * as z from 'zod'

import { blockedRawEndpoints } from '@/lib/config'
import { resolveOwnUid } from '@/lib/ncm/account'
import { callNcm } from '@/lib/ncm/client'
import type { CookieJar } from '@/lib/ncm/cookies'
import { UID_DIAGNOSTIC } from '@/lib/ncm/uid'
import {
  MAX_TOOL_TEXT,
  MAX_TEXT_FIELD_CHARS,
  TEXT_LIMITS,
  capText,
  capTextFields,
  clampTextLimit,
  enforceCeiling,
  slimComment,
  slimPlaylist,
  slimSong,
  slimUser,
  toStructuredText,
  trimGeneric,
  trimGenericWithNotes,
  trimText,
  truncateLines,
  truncateText,
} from '@/lib/ncm/serialize'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  findDominantArray,
  localFetchLimit,
  pageMeta,
  pageRequest,
  pagingEmptyNote,
  pagingFooter,
  pagingShape,
  paginate,
  paginateGroups,
  takeWindow,
  upstreamWindow,
  type GroupSpec,
  type PageMeta,
  type PagedGroup,
  type PagingMode,
} from '@/lib/mcp/pagination'

export interface ToolRuntime {
  jar: CookieJar
  fakeIp?: string
  userId?: number
  nickname?: string
  scope: string
}

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface ToolDef {
  name: string
  toolset: ToolsetName
  title: string
  description: string
  input: z.ZodObject<z.ZodRawShape> | z.ZodTypeAny
  annotations?: ToolAnnotations
  /** NetEase endpoint name, or undefined for local-only tools. */
  endpoint?: string
  /** Overrides the default "call endpoint with args" behaviour. */
  run?: (args: any, runtime: ToolRuntime) => Promise<ToolResult>
  /** Transform raw arguments before they reach the endpoint. */
  mapArgs?: (args: any, runtime: ToolRuntime) => Record<string, unknown>
  /** Transform the upstream body into the text returned to the model. */
  render?: (body: any, args: any) => string
  /**
   * Which arrays in the upstream body are paged, and how the upstream is called:
   * - `offset`: send limit+offset, the array holds exactly the requested page
   * - `limit`:  send limit only (up to the end of the page), slice locally
   * - `local`:  the endpoint returns everything, slice locally
   */
  paging?: ToolPaging
  /**
   * Character ceiling for this tool's whole result. Defaults to `TEXT_LIMITS.result`
   * and is always clamped to `MAX_TOOL_TEXT`, so a tool can ask for a smaller result
   * but never an unbounded one.
   */
  maxTextChars?: number
  requiresWrite?: boolean
  requiresLogin?: boolean
  /**
   * Injects the session's own account id as `uid` before the call, resolving it via
   * the token and then the cookie jar. Only for endpoints that require a uid param
   * (likelist, user_binding); the rest read identity from the cookie upstream.
   */
  ownUidParam?: boolean
}

/** The ceiling a tool's text must fit, bounded no matter what the definition asks. */
export function toolCeiling(def: ToolDef): number {
  const declared = def.maxTextChars
  if (typeof declared !== 'number' || !Number.isFinite(declared)) return TEXT_LIMITS.result
  return Math.min(MAX_TOOL_TEXT, Math.max(1000, Math.trunc(declared)))
}

export type ToolsetName =
  | 'account'
  | 'search'
  | 'discover'
  | 'music'
  | 'library'
  | 'comments'
  | 'social'
  | 'meta'

export const TOOLSETS: { name: ToolsetName; title: string; blurb: string }[] = [
  { name: 'account', title: 'Account', blurb: 'Login state, profile, level, followers, VIP, sign-in' },
  { name: 'search', title: 'Search', blurb: 'Songs, albums, artists, playlists, MV, lyrics, suggestions' },
  { name: 'discover', title: 'Discover', blurb: 'Daily recommendations, toplists, banners, new releases' },
  { name: 'music', title: 'Music', blurb: 'Song detail, play/download URLs, lyrics, albums, artists' },
  { name: 'library', title: 'Library', blurb: 'Likes, scrobble, playlists, cloud upload, listening stats' },
  { name: 'comments', title: 'Comments', blurb: 'Read and post comments on songs, albums, playlists, MV' },
  { name: 'social', title: 'Social', blurb: 'Follow users, subscribe artists/MV/radio, DMs, events' },
  { name: 'meta', title: 'Meta', blurb: 'Endpoint discovery and a raw escape hatch' },
]

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

const paging = pagingShape

/** How a tool's arrays are paged. */
export interface ToolPaging {
  /**
   * Arrays to page. Leave empty to auto-detect the dominant array, which is the
   * right choice for endpoints whose shape is not worth pinning down.
   */
  groups: GroupSpec[]
  /**
   * How the upstream is asked. Default 'local' — the safe choice, because slicing
   * a full response cannot drop data. Use 'offset' only when the endpoint honours
   * limit/offset on the arrays being paged.
   */
  mode?: PagingMode
  defaultPageSize?: number
}

/** Page params for an endpoint that takes limit/offset, or just limit. */
function upstreamParams(def: ToolDef, args: any): Record<string, unknown> {
  const pagingDef = def.paging
  if (!pagingDef) return {}
  const req = pageRequest(args, pagingDef.defaultPageSize)
  const mode = pagingDef.mode ?? 'local'
  if (mode === 'local') return {}
  if (mode === 'limit') return { limit: localFetchLimit(req) }
  return upstreamWindow(req)
}

/**
 * The `limit` we actually sent upstream, so an endpoint that answers with `limit+1`
 * rows can have the extra row trimmed instead of counted as page content.
 */
function requestedLimit(def: ToolDef, args: any): number | undefined {
  const pagingDef = def.paging
  if (!pagingDef) return undefined
  const mode = pagingDef.mode ?? 'local'
  if (mode === 'local') return undefined
  const req = pageRequest(args, pagingDef.defaultPageSize)
  return mode === 'limit' ? localFetchLimit(req) : req.pageSize
}

/** page/pageSize are ours, not the upstream's; never leak them into a request. */
function stripPagingArgs(params: Record<string, unknown>): Record<string, unknown> {
  if (!('page' in params) && !('pageSize' in params)) return params
  const { page: _page, pageSize: _pageSize, ...rest } = params
  return rest
}

/** Page the arrays named by `def.paging` and collect their metadata. */
function pageResultBody(def: ToolDef, body: any, args: any): { body: any; groups: PagedGroup[] } {
  const pagingDef = def.paging
  if (!pagingDef) return { body, groups: [] }
  return paginateGroups(body, pagingDef.groups, args, {
    mode: pagingDef.mode ?? 'local',
    defaultPageSize: pagingDef.defaultPageSize,
    requestedLimit: requestedLimit(def, args),
  })
}

/** Cap on one free-form text field, tunable per call, for lyrics and long descriptions. */
const maxChars = z
  .number()
  .int()
  .min(200)
  .max(MAX_TEXT_FIELD_CHARS)
  .optional()
  .describe(
    `Maximum characters kept from each long text field (default ${TEXT_LIMITS.lyrics}, ` +
      `max ${MAX_TEXT_FIELD_CHARS}); anything longer is cut and the result says what was dropped.`,
  )

const commentType = z
  .enum(['song', 'mv', 'playlist', 'album', 'dj', 'video', 'event'])
  .describe('Resource kind the comment belongs to')

const COMMENT_TYPE_CODE: Record<string, number> = {
  song: 0,
  mv: 1,
  playlist: 2,
  album: 3,
  dj: 4,
  video: 5,
  event: 6,
}

const quality = z
  .enum(['standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'jymaster', 'sky', 'vivid'])
  .describe('Audio quality tier; higher tiers need a matching VIP plan')

const searchType = z
  .enum(['song', 'album', 'artist', 'playlist', 'user', 'mv', 'lyric', 'dj', 'video', 'complex'])
  .optional()
  .describe('Restrict results to one kind; omit for mixed results')

const SEARCH_TYPE_CODE: Record<string, number> = {
  song: 1,
  album: 10,
  artist: 100,
  playlist: 1000,
  user: 1002,
  mv: 1004,
  lyric: 1006,
  dj: 1009,
  video: 1014,
  complex: 1018,
}

/** Default runner: endpoint call, paging, generic trim, JSON text. */
async function defaultRun(def: ToolDef, args: any, runtime: ToolRuntime): Promise<ToolResult> {
  const mapped = def.mapArgs ? def.mapArgs(args, runtime) : { ...args }
  const params = { ...stripPagingArgs(mapped), ...upstreamParams(def, args) }

  if (def.ownUidParam && params.uid === undefined) {
    const own = await resolveOwnUid(runtime)
    if (!own.ok) return { isError: true, content: [{ type: 'text', text: own.message }] }
    params.uid = own.uid
  }

  const result = await callNcm(def.endpoint!, params, {
    jar: runtime.jar,
    fakeIp: runtime.fakeIp,
  })

  if (!result.ok) {
    const code = Number(result.body?.code)
    const rawMessage = String(result.body?.message ?? result.body?.msg ?? '')
    const riskGated = /验证|captcha|verify/i.test(rawMessage)

    if (riskGated) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'NetEase asked for human verification (风控拦截) on this request. Wait a little and retry, ' +
              'or sign in with a different method so the session carries a fuller device fingerprint.',
          },
        ],
      }
    }
    if (code === 301) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'This call needs a signed-in NetEase account. Reconnect the server in your MCP client ' +
              'and sign in on the page that opens (QR, SMS or password).',
          },
        ],
      }
    }
    const message = rawMessage || `NetEase returned ${result.status}`
    return {
      isError: true,
      content: [{ type: 'text', text: `Error (${result.status}): ${message}` }],
    }
  }

  const paged = pageResultBody(def, result.body, args)
  const ceiling = toolCeiling(def)
  if (def.render) {
    let current = paged
    let text = `${def.render(current.body, args)}${pagingFooter(current.groups)}`
    // A rendered page can exceed the ceiling even when its paging footer fits. Rather
    // than cutting the text, shrink the page: render fewer items and let the footer
    // report exactly what was delivered, so the numbers stay true.
    for (let attempt = 0; attempt < 8 && text.length > ceiling && current.groups.length > 0; attempt += 1) {
      const shrunk = shrinkPage(current, text.length / ceiling)
      if (!shrunk) break
      current = shrunk
      text = `${def.render(current.body, args)}${pagingFooter(current.groups)}`
    }
    return { content: [{ type: 'text', text }] }
  }
  // Keep the paging object in view even when a verbose payload has to be shortened.
  // Structural truncation already corrects `paging.returned`/`hasMore` on the body it
  // emits, so the numbers always describe what the caller actually received.
  const { body: trimmed, notes } = trimGenericWithNotes(paged.body)
  const text = toStructuredText(capTextFields(trimmed, TEXT_LIMITS.field), {
    limit: ceiling,
    notes,
  })
  return { content: [{ type: 'text', text }] }
}

/**
 * Drop items from the tail of every paged array until the page is roughly
 * `1/ratio` of its current size, recording what was dropped on the page metadata.
 * Returns undefined when nothing can be shrunk further.
 */
function shrinkPage(paged: { body: any; groups: PagedGroup[] }, ratio: number): { body: any; groups: PagedGroup[] } | undefined {
  const factor = Math.min(0.95, Math.max(0.1, 1 / Math.max(1.05, ratio)))
  let changed = false
  let body = paged.body
  const groups = paged.groups.map((group) => {
    const path = group.path.split('.')
    let cursor = body
    for (const key of path.slice(0, -1)) {
      cursor = cursor?.[key]
      if (!cursor || typeof cursor !== 'object') return group
    }
    const list = cursor?.[path[path.length - 1]]
    if (!Array.isArray(list) || list.length === 0) return group
    const keep = Math.max(1, Math.floor(list.length * factor))
    if (keep >= list.length) return group
    const next = list.slice(0, keep)
    cursor[path[path.length - 1]] = next
    body = { ...body }
    changed = true
    const dropped = (group.meta.truncated ?? 0) + (list.length - keep)
    return {
      ...group,
      meta: { ...group.meta, returned: keep, truncated: dropped, hasMore: true },
    }
  })
  return changed ? { body, groups } : undefined
}
export async function runTool(
  def: ToolDef,
  args: any,
  runtime: ToolRuntime,
): Promise<ToolResult> {
  if (def.requiresLogin && !runtime.jar.MUSIC_U) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'This tool needs a logged-in NetEase account. Re-run the OAuth flow to sign in ' +
            '(the connection currently holds an anonymous session).',
        },
      ],
    }
  }
  try {
    const result = def.run ? await def.run(args, runtime) : await defaultRun(def, args, runtime)
    // Every result leaves through here, so this is the one place a hard ceiling can
    // be enforced for both the rendered and the JSON paths.
    return applyCeiling(def, result)
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool failed: ${(error as Error).message}` }],
    }
  }
}

/** Enforce the tool's ceiling on every text part, structurally. */
function applyCeiling(def: ToolDef, result: ToolResult): ToolResult {
  const limit = toolCeiling(def)
  const content = result.content.map((part) =>
    part.text.length <= limit
      ? part
      : { type: 'text' as const, text: enforceCeiling(part.text, { limit }) },
  )
  return { ...result, content }
}

/**
 * JSON text for a tool result: generic trim, per-field cap, then a structural
 * truncation that keeps the document parseable. Handlers use this instead of
 * `JSON.stringify`, so every JSON result is bounded the same way.
 */
function renderJsonResult(body: any, fieldLimit: number = TEXT_LIMITS.field, ceiling: number = TEXT_LIMITS.result): string {
  const { body: trimmed, notes } = trimGenericWithNotes(body)
  return toStructuredText(capTextFields(trimmed, fieldLimit), { limit: ceiling, notes })
}

function songLine(song: any): string {
  const artists = (song.artists ?? []).map((a: any) => a.name).join(', ')
  const album = song.album?.name ?? ''
  const seconds = song.durationMs ? Math.round(song.durationMs / 1000) : undefined
  return `- ${song.name}${artists ? ` — ${artists}` : ''}${album ? ` (${album})` : ''}${
    seconds ? ` [${seconds}s]` : ''
  } id=${song.id}`
}

function renderSongList(songs: any[], heading: string): string {
  if (!songs.length) return `${heading}\n(no songs)`
  return `${heading}\n${songs.map(songLine).join('\n')}`
}

/**
 * Note for an empty rendered page. Uses the paging metadata stitched onto the body
 * by `paginateGroups`, so "page 9 is past the end" reads differently from "none".
 */
function emptyPageNote(body: any, path: string, unit: string): string {
  const meta = body?.paging?.[path] as PageMeta | undefined
  if (!meta) return `(no ${unit})`
  return pagingEmptyNote(meta, unit)
}


// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

const accountTools: ToolDef[] = [
  {
    name: 'ncm_account_status',
    toolset: 'account',
    title: 'Account status',
    description:
      'Check whether the current connection holds a logged-in NetEase account, and return the ' +
      'account id, nickname, VIP type and listener level.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'login_status',
    run: async (_args, runtime) => {
      const result = await callNcm('login_status', {}, { jar: runtime.jar, fakeIp: runtime.fakeIp })
      const data = result.ok ? (result.body?.data ?? result.body) : undefined
      if (data?.account) {
        const text = [
          `Logged in as ${data.profile?.nickname ?? '(unknown)'}`,
          `userId: ${data.account.id}`,
          `VIP type: ${data.account.vipType ?? 0}`,
          `created: ${data.account.createTime ?? 'n/a'}`,
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      if (!runtime.jar.MUSIC_U) {
        return {
          content: [
            {
              type: 'text',
              text: [
                'Anonymous session: no NetEase account is linked to this connection.',
                'Public read tools work. Anything personal (library, playlists, likes, writes) needs sign-in:',
                'disconnect the server in your MCP client, reconnect, and use the login page that opens.',
              ].join('\n'),
            },
          ],
        }
      }

      // The jar carries a session cookie, so "anonymous" would be a lie: the upstream just
      // did not identify the account. Ask the same resolver the own-uid tools use, so the
      // message says which half of the session is missing.
      const own = await resolveOwnUid(runtime)
      const detail = own.ok
        ? `The access token holds userId ${own.uid}, but upstream login_status returned no account for this cookie jar.`
        : 'Neither the access token nor the upstream session exposed an account id.'
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `A MUSIC_U session cookie is present, but the upstream session did not expose an account id. ${detail} ` +
              UID_DIAGNOSTIC,
          },
        ],
      }
    },
  },
  {
    name: 'ncm_account_profile',
    toolset: 'account',
    title: 'My profile',
    description: 'Full profile of the signed-in account: nickname, signature, follower counts, playlist count.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'user_account',
    render: (body) => JSON.stringify(slimUser(body?.profile ?? body), null, 2),
  },
  {
    name: 'ncm_user_detail',
    toolset: 'account',
    title: 'User profile',
    description: 'Profile of any NetEase user by id, including follow relations when logged in.',
    input: z.object({ uid: z.union([z.string(), z.number()]).describe('NetEase user id') }),
    annotations: READ_ONLY,
    endpoint: 'user_detail',
    mapArgs: (args) => ({ uid: args.uid }),
    render: (body) => JSON.stringify(slimUser(body?.profile ?? body), null, 2),
  },
  {
    name: 'ncm_user_level',
    toolset: 'account',
    title: 'Listener level',
    description: 'Listening level, accumulated play count and next-level progress for the signed-in user.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'user_level',
    requiresLogin: true,
  },
  {
    name: 'ncm_user_counts',
    toolset: 'account',
    title: 'Follow counts',
    description: 'How many users, artists and playlists the signed-in account follows, plus fan count.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'user_subcount',
    requiresLogin: true,
  },
  {
    name: 'ncm_user_follows',
    toolset: 'account',
    title: 'Following list',
    description:
      'Users the given account follows. Paged: pass page (1-based, default 1) and pageSize ' +
      `(default ${DEFAULT_PAGE_SIZE}, clamped to ${MAX_PAGE_SIZE}). The paging footer says how many ` +
      'users came back and whether more exist.',
    input: z.object({
      uid: z.union([z.string(), z.number()]).describe('User id; use ncm_account_status for your own'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'user_follows',
    paging: { mode: 'offset', groups: [{ path: 'follow', label: 'users', hasMorePath: 'more' }] },
    render: (body) => renderUserList(body?.follow ?? [], 'Following'),
  },
  {
    name: 'ncm_user_followeds',
    toolset: 'account',
    title: 'Follower list',
    description:
      'Users following the given account. Paged: page (1-based, default 1) and pageSize ' +
      `(default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); the footer reports counts and hasMore.`,
    input: z.object({
      uid: z.union([z.string(), z.number()]).describe('User id'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'user_followeds',
    paging: { mode: 'offset', groups: [{ path: 'followeds', label: 'users' }] },
    render: (body) => renderUserList(body?.followeds ?? [], 'Followers'),
  },
  {
    name: 'ncm_vip_info',
    toolset: 'account',
    title: 'VIP status',
    description: 'VIP / SVIP details for the signed-in account or a given user.',
    input: z.object({ uid: z.union([z.string(), z.number()]).optional().describe('Defaults to yourself') }),
    annotations: READ_ONLY,
    endpoint: 'vip_info',
    requiresLogin: true,
  },
  {
    name: 'ncm_daily_signin',
    toolset: 'account',
    title: 'Daily check-in',
    description: 'Perform the daily check-in (mobile) to collect points.',
    input: z.object({ pc: z.boolean().optional().describe('Use the PC check-in endpoint instead of mobile') }),
    annotations: WRITE,
    endpoint: 'daily_signin',
    mapArgs: (args) => ({ type: args.pc ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) =>
      body?.code === 200
        ? `Check-in done. Points today: ${body.point ?? 0}`
        : JSON.stringify(trimGeneric(body), null, 2),
  },
  {
    name: 'ncm_logout',
    toolset: 'account',
    title: 'Log out upstream',
    description:
      'Invalidate the NetEase session behind this connection. The MCP token stays valid but the ' +
      'jar it carries will no longer authenticate; re-run OAuth to sign in again.',
    input: z.object({}),
    annotations: DESTRUCTIVE,
    endpoint: 'logout',
    requiresLogin: true,
    requiresWrite: true,
  },
]

function renderUserList(users: any[], heading: string): string {
  if (!users.length) return `${heading}\n(empty)`
  return `${heading}\n${users
    .map((u) => `- ${u.nickname ?? u.name} id=${u.userId ?? u.id}${u.signature ? ` — ${trimText(u.signature, 80)}` : ''}`)
    .join('\n')}`
}

/**
 * One paged request for the search family. The upstream takes limit/offset and
 * applies them to every result kind at once, so the returned arrays already are
 * the page; each kind keeps its reported count as `total`.
 */
const searchPaging: ToolPaging = {
  mode: 'offset',
  groups: [
    { path: 'result.songs', label: 'songs', totalPath: 'result.songCount' },
    { path: 'result.albums', label: 'albums', totalPath: 'result.albumCount' },
    { path: 'result.artists', label: 'artists', totalPath: 'result.artistCount' },
    { path: 'result.playlists', label: 'playlists', totalPath: 'result.playlistCount' },
    { path: 'result.users', label: 'users', totalPath: 'result.userCount' },
    { path: 'result.mvs', label: 'MVs', totalPath: 'result.mvCount' },
    { path: 'result.djRadios', label: 'radio', totalPath: 'result.djRadiosCount' },
  ],
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const searchTools: ToolDef[] = [
  {
    name: 'ncm_search',
    toolset: 'search',
    title: 'Search music',
    description:
      'Search NetEase for songs, albums, artists, playlists, users, MV, lyrics or radio. ' +
      'Returns a compact list with ids you can pass to the detail tools. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'apply to every result kind at once; the footer reports each kind\'s total and hasMore.',
    input: z.object({
      keywords: z.string().min(1).describe('Query text'),
      type: searchType,
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search',
    mapArgs: (args) => ({
      keywords: args.keywords,
      ...(args.type ? { type: SEARCH_TYPE_CODE[args.type] } : {}),
    }),
    paging: searchPaging,
    render: (body, args) => renderSearch(body?.result ?? {}, args.type),
  },
  {
    name: 'ncm_search_cloud',
    toolset: 'search',
    title: 'Search (cloud index)',
    description:
      'Search against the cloud index, which has better coverage for niche and new releases. ' +
      `Paged like ncm_search: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, ` +
      `max ${MAX_PAGE_SIZE}), applied to every result kind.`,
    input: z.object({
      keywords: z.string().min(1),
      type: searchType,
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'cloudsearch',
    mapArgs: (args) => ({
      keywords: args.keywords,
      ...(args.type ? { type: SEARCH_TYPE_CODE[args.type] } : {}),
    }),
    paging: searchPaging,
    render: (body, args) => renderSearch(body?.result ?? {}, args.type),
  },
  {
    name: 'ncm_search_suggest',
    toolset: 'search',
    title: 'Search suggestions',
    description:
      'Autocomplete suggestions for a partial query. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ keywords: z.string().min(1), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'search_suggest',
    paging: { groups: [{ path: 'result.allMatch', label: 'suggestions' }] },
    render: (body) =>
      (body?.result?.allMatch ?? []).map((entry: any) => `- ${entry.keyword}`).join('\n') ||
      '(no suggestions)',
  },
  {
    name: 'ncm_search_hot',
    toolset: 'search',
    title: 'Trending searches',
    description:
      'Current hot search keywords on NetEase. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      detail: z.boolean().optional().describe('Include trending topic details'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search_hot',
    run: async (args, runtime) => {
      const result = await callNcm(args.detail ? 'search_hot_detail' : 'search_hot', {}, {
        jar: runtime.jar,
        fakeIp: runtime.fakeIp,
      })
      if (!result.ok) return { isError: true, content: [{ type: 'text', text: 'Hot search unavailable' }] }
      const source = result.body?.data ?? result.body?.result ?? result.body
      const list = Array.isArray(source) ? source : (source?.hots ?? source?.data ?? [])
      const { items, meta } = paginate(list, args)
      const group: PagedGroup = { label: 'keywords', path: 'hots', unit: 'keywords', meta }
      const text =
        items
          .map(
            (entry: any, index: number) =>
              `${meta.offset + index + 1}. ${entry.first ?? entry.searchWord ?? entry.keyword}`,
          )
          .join('\n') || pagingEmptyNote(meta, 'keywords')
      return { content: [{ type: 'text', text: `${text}${pagingFooter([group])}` }] }
    },
  },
  {
    name: 'ncm_search_multimatch',
    toolset: 'search',
    title: 'Multi-match search',
    description:
      'Search across multiple result kinds in one call and get ids for each match. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'slice the busiest result array; the rest of the payload is kept.',
    input: z.object({
      keywords: z.string().min(1),
      type: z.number().int().min(1).max(100).optional().describe('Result kind bitmask; default 1 (songs)'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search_multimatch',
    paging: { groups: [], mode: 'local' },
  },
  {
    name: 'ncm_search_default',
    toolset: 'search',
    title: 'Default search landing',
    description:
      'The default discovery payload NetEase shows on an empty search box. This is a single ' +
      'suggested query plus ranking hints, not a list, so it takes no page parameters; long ' +
      `hint fields are capped at ${TEXT_LIMITS.field} characters.`,
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'search_default',
    render: (body) => {
      const data = body?.data ?? body ?? {}
      const lines = [
        `suggested query: ${data.showKeyword ?? data.realkeyword ?? '(none)'}`,
        ...(data.styleKeyword?.keyWord ? [`styled: ${data.styleKeyword.keyWord}`] : []),
        ...(data.realkeyword ? [`search term: ${data.realkeyword}`] : []),
        ...(data.searchType !== undefined ? [`search type: ${data.searchType}`] : []),
      ]
      const rest = { ...data }
      delete rest.showKeyword
      delete rest.styleKeyword
      delete rest.realkeyword
      delete rest.searchType
      const tail = Object.keys(rest).length
        ? `\n${renderJsonResult(rest, TEXT_LIMITS.field)}`
        : ''
      return `${lines.join('\n')}${tail}`
    },
  },
  {
    name: 'ncm_search_lyric',
    toolset: 'search',
    title: 'Search by lyric',
    description:
      'Find songs whose lyrics match a phrase. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      keywords: z.string().min(1),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search',
    mapArgs: (args) => ({
      keywords: args.keywords,
      type: SEARCH_TYPE_CODE.lyric,
    }),
    paging: {
      mode: 'offset',
      groups: [{ path: 'result.songs', label: 'songs', totalPath: 'result.songCount' }],
    },
    render: (body) => renderSongList((body?.result?.songs ?? []).map(slimSong), 'Lyric matches'),
  },
  {
    name: 'ncm_search_song_page',
    toolset: 'search',
    title: 'Search song page',
    description:
      'Song-only search results, cheaper than a mixed search when you only need songs. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      keywords: z.string().min(1).describe('Query text'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search',
    mapArgs: (args) => ({
      keywords: args.keywords,
      type: SEARCH_TYPE_CODE.song,
    }),
    paging: {
      mode: 'offset',
      groups: [{ path: 'result.songs', label: 'songs', totalPath: 'result.songCount' }],
    },
    render: (body) => renderSongList((body?.result?.songs ?? []).map(slimSong), 'Songs'),
  },
]

function renderSearch(result: any, type?: string): string {
  const lines: string[] = []
  if (result.songs?.length && (!type || type === 'song' || type === 'complex')) {
    const total = result.songCount ? ` (${result.songCount} total)` : ''
    lines.push(renderSongList(result.songs.map(slimSong), `Songs${total}`))
  }
  if (result.albums?.length) {
    lines.push(
      `Albums\n${result.albums.map((a: any) => `- ${a.name} — ${a.artist?.name ?? ''} id=${a.id}`).join('\n')}`,
    )
  }
  if (result.artists?.length) {
    lines.push(
      `Artists\n${result.artists
        .map((a: any) => `- ${a.name}${a.alias?.length ? ` (${a.alias.join(', ')})` : ''} id=${a.id}`)
        .join('\n')}`,
    )
  }
  if (result.playlists?.length) {
    lines.push(
      `Playlists\n${result.playlists
        .map((p: any) => `- ${p.name} — ${p.trackCount ?? '?'} tracks id=${p.id}`)
        .join('\n')}`,
    )
  }
  if (result.users?.length) {
    lines.push(renderUserList(result.users, 'Users'))
  }
  if (result.mvs?.length) {
    lines.push(`Music videos\n${result.mvs.map((m: any) => `- ${m.name} id=${m.id}`).join('\n')}`)
  }
  if (result.djRadios?.length) {
    lines.push(`Radio\n${result.djRadios.map((d: any) => `- ${d.name} id=${d.id}`).join('\n')}`)
  }
  return lines.join('\n\n') || '(no results)'
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

const discoverTools: ToolDef[] = [
  {
    name: 'ncm_personalized',
    toolset: 'discover',
    title: 'Recommended playlists',
    description:
      'Personalised playlist recommendations for the current session. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'personalized',
    paging: { mode: 'limit', groups: [{ path: 'result', label: 'playlists' }] },
    render: (body) =>
      (body?.result ?? [])
        .map((p: any) => `- ${p.name} — ${p.trackCount ?? '?'} tracks id=${p.id}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_recommend_songs',
    toolset: 'discover',
    title: 'Daily recommendations',
    description:
      'The daily recommended song list ("每日推荐"). Gives a personal list when logged in, a generic ' +
      `one otherwise. Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, ` +
      `max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'recommend_songs',
    paging: { mode: 'local', groups: [{ path: 'data.dailySongs', label: 'songs' }] },
    render: (body) => {
      const songs = body?.data?.dailySongs ?? body?.recommend ?? []
      return renderSongList(songs.map(slimSong), 'Daily recommendations')
    },
  },
  {
    name: 'ncm_recommend_resource',
    toolset: 'discover',
    title: 'Recommended resources',
    description:
      'Mixed recommended resources: playlists, radio and albums. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'recommend_resource',
    paging: { mode: 'local', groups: [{ path: 'recommend', label: 'resources' }] },
    render: (body) =>
      (body?.recommend ?? [])
        .map((r: any) => `- ${r.name} (${r.type}) id=${r.id}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_new_songs',
    toolset: 'discover',
    title: 'New releases',
    description:
      'Newly released songs, per region. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the upstream caps this feed at 100 songs.',
    input: z.object({
      area: z.enum(['ALL', 'ZH', 'EA', 'KR', 'JP']).optional().describe('Region, default ALL'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'personalized_newsong',
    paging: { mode: 'limit', groups: [{ path: 'result', label: 'songs' }] },
    render: (body) => renderSongList((body?.result ?? []).map(slimSong), 'New songs'),
  },
  {
    name: 'ncm_toplist',
    toolset: 'discover',
    title: 'All toplists',
    description:
      'Every NetEase chart: soars, new songs, originals, and the global top 500. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'toplist',
    paging: { mode: 'local', groups: [{ path: 'list', label: 'toplists' }] },
    render: (body) =>
      (body?.list ?? [])
        .map((l: any) => `- ${l.name} id=${l.id}${l.updateFrequency ? ` (${l.updateFrequency})` : ''}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_toplist_detail',
    toolset: 'discover',
    title: 'Toplist summaries',
    description:
      'Summary of every toplist with its top tracks. ' +
      `Paged over the toplists (page 1-based default 1, pageSize default ${DEFAULT_PAGE_SIZE}, ` +
      `max ${MAX_PAGE_SIZE}); each toplist keeps its first 3 tracks as a preview.`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'toplist_detail_v2',
    paging: { mode: 'local', groups: [{ path: 'list', label: 'toplists' }] },
    render: (body) =>
      (body?.list ?? [])
        .map(
          (l: any) =>
            `${l.name} id=${l.id}\n${(l.tracks ?? []).slice(0, 3).map((t: any) => `  · ${t.first ?? t.name}`).join('\n')}`,
        )
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_toplist_songs',
    toolset: 'discover',
    title: 'Toplist tracks',
    description:
      'Track list of one toplist, newest first. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the toplist total and hasMore.',
    input: z.object({
      id: z.union([z.string(), z.number()]).describe('Toplist id from ncm_toplist'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'playlist_detail',
    mapArgs: (args) => ({ id: args.id }),
    paging: {
      mode: 'local',
      groups: [{ path: 'playlist.tracks', label: 'tracks', totalPath: 'playlist.trackCount' }],
    },
    render: (body) => {
      const tracks = body?.playlist?.tracks ?? []
      const total = body?.playlist?.trackCount
      return renderSongList(tracks.map(slimSong), `Toplist ${body?.playlist?.name ?? ''} (${total ?? tracks.length} tracks)`)
    },
  },
  {
    name: 'ncm_banner',
    toolset: 'discover',
    title: 'Banners',
    description:
      'Home page promotional banners. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      type: z.enum(['pc', 'android', 'iphone', 'ipad']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'banner',
    mapArgs: (args) => ({
      type: ({ pc: 0, android: 1, iphone: 2, ipad: 3 } as Record<string, number>)[args.type ?? 'pc'],
    }),
    paging: { mode: 'local', groups: [{ path: 'banners', label: 'banners' }] },
    render: (body) =>
      (body?.banners ?? []).map((b: any) => `- ${b.typeTitle ?? b.song?.name ?? b.url}`).join('\n') || '(none)',
  },
  {
    name: 'ncm_top_songs',
    toolset: 'discover',
    title: 'Top songs by region',
    description:
      'Regional charts of the most played songs. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ area: z.enum(['all', 'zh', 'ea', 'kr', 'ja']).optional(), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'top_song',
    mapArgs: (args) => ({
      type: ({ all: 0, zh: 7, ea: 96, kr: 16, ja: 8 } as Record<string, number>)[args.area ?? 'all'],
    }),
    paging: { mode: 'local', groups: [{ path: 'data', label: 'songs' }] },
    render: (body) => renderSongList((body?.data ?? []).map(slimSong), 'Top songs'),
  },
  {
    name: 'ncm_top_playlists',
    toolset: 'discover',
    title: 'Top playlists',
    description:
      'Popular playlists, optionally by category. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      cat: z.string().optional().describe('Category name, e.g. 华语 / 摇滚 / 电子'),
      order: z.enum(['hot', 'new']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'top_playlist',
    paging: {
      mode: 'offset',
      groups: [{ path: 'playlists', label: 'playlists', hasMorePath: 'more', totalPath: 'total' }],
    },
  },
  {
    name: 'ncm_top_artists',
    toolset: 'discover',
    title: 'Top artists',
    description:
      'Most popular artists on the platform. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the upstream hasMore flag.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'top_artists',
    paging: { mode: 'offset', groups: [{ path: 'artists', label: 'artists', hasMorePath: 'more' }] },
  },
  {
    name: 'ncm_music_calendar',
    toolset: 'discover',
    title: 'Release calendar',
    description:
      'Albums and singles released in a date range. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'walk the days of the range; each day keeps at most 20 releases.',
    input: z.object({
      startTime: z.union([z.string(), z.number()]).describe('Start of range in epoch ms'),
      endTime: z.union([z.string(), z.number()]).describe('End of range in epoch ms'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'calendar',
    render: (body, args) => {
      const days = Object.entries(body?.data ?? {}) as [string, any][]
      if (!days.length) return '(nothing released in range)'
      const { items, meta } = paginate(days, args)
      const group: PagedGroup = { label: 'days', path: 'data', unit: 'days', meta }
      const dayBlocks = items.map(
        ([day, payload]) =>
          `${day}\n${(payload?.newAlbums ?? [])
            .slice(0, 20)
            .map((a: any) => `  · ${a.name} — ${a.artist?.name ?? ''} id=${a.id}`)
            .join('\n')}`,
      )
      // Day blocks are variable-length, so the ceiling is applied per day: a day that
      // does not fit ends the page and says so, rather than being cut mid-line. The
      // footer then reports the days actually delivered, not the ones rendered.
      const cut = truncateLines(dayBlocks, {
        limit: TEXT_LIMITS.result,
        unit: 'days',
        hint: () => 'narrow the date range or use a smaller pageSize',
      })
      const delivered = cut.kept
      const adjusted: PagedGroup =
        delivered < items.length
          ? {
              ...group,
              meta: { ...meta, returned: delivered, truncated: items.length - delivered, hasMore: true },
            }
          : group
      return `${cut.text}${pagingFooter([adjusted])}`
    },
  },
]

// ---------------------------------------------------------------------------
// music
// ---------------------------------------------------------------------------

const musicTools: ToolDef[] = [
  {
    name: 'ncm_song_detail',
    toolset: 'music',
    title: 'Song detail',
    description:
      'Metadata for one or more songs (comma-separated ids): title, artists, album, duration, ' +
      'publish time and whether a play URL is available. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'slice the songs in the order you listed the ids.',
    input: z.object({
      ids: z.string().describe('Comma-separated song ids, e.g. "347230,186016"'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'song_detail',
    paging: { mode: 'local', groups: [{ path: 'songs', label: 'songs' }] },
    render: (body) => {
      const songs = (body?.songs ?? []).map(slimSong)
      const rights = (body?.privileges ?? []) as { id: number; st: number }[]
      const byId = new Map(rights.map((right) => [right.id, right]))
      const lines = songs.map((song: any) => {
        const right = byId.get(song.id)
        if (!right) return songLine(song)
        return `${songLine(song)} playable=${right.st >= 0 ? 'yes' : 'no'}`
      })
      return lines.join('\n') || '(no songs)'
    },
  },
  {
    name: 'ncm_song_url',
    toolset: 'music',
    title: 'Song play URL',
    description:
      'Resolve a playable audio URL at a chosen quality tier. Unavailable songs come back with an ' +
      'empty url and a `code` explaining the reason (region lock or VIP requirement). ' +
      `Paged over the ids you pass: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, ` +
      `max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      ids: z.string().describe('Comma-separated song ids'),
      level: quality.optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'song_url_v1',
    run: async (args, runtime) => {
      const allIds = String(args.ids)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      const { items: ids, meta } = paginate(allIds, args)
      const group: PagedGroup = { label: 'ids', path: 'ids', unit: 'ids', meta }

      // song_url_v1 takes one id at a time, so fan out and join.
      const settled = await Promise.all(
        ids.map((id) =>
          callNcm(
            'song_url_v1',
            { id, level: args.level ?? 'exhigh' },
            { jar: runtime.jar, fakeIp: runtime.fakeIp },
          ),
        ),
      )

      const lines: string[] = []
      for (const [index, result] of settled.entries()) {
        const entry = result.body?.data?.[0]
        if (!entry?.url) {
          lines.push(`- id=${ids[index]} unavailable (code=${entry?.code ?? result.body?.code ?? 'unknown'})`)
          continue
        }
        const sizeMb = entry.size ? (entry.size / 1024 / 1024).toFixed(1) : undefined
        lines.push(
          `- id=${ids[index]} ${entry.level ?? args.level ?? ''} ${sizeMb ? `${sizeMb}MB ` : ''}${entry.type ?? ''}\n  ${entry.url}`,
        )
      }
      const text = lines.join('\n') || pagingEmptyNote(meta, 'ids')
      return { content: [{ type: 'text', text: `${text}${pagingFooter([group])}` }] }
    },
  },
  {
    name: 'ncm_song_download_url',
    toolset: 'music',
    title: 'Song download URL',
    description: 'Download URL for a song. Usually requires a VIP plan at higher bitrates.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      br: z.number().int().optional().describe('Bitrate in bps, e.g. 320000; default 999000'),
    }),
    annotations: READ_ONLY,
    endpoint: 'song_download_url',
    render: (body) => {
      const data = body?.data ?? body
      const url = data?.url ?? data?.[0]?.url
      return url ? `${url}` : `No download URL (code=${body?.code ?? 'unknown'})`
    },
  },
  {
    name: 'ncm_lyric',
    toolset: 'music',
    title: 'Lyrics',
    description:
      'Plain and translated lyrics plus the optional LRC timestamped version. The whole result is ' +
      `capped at ${TEXT_LIMITS.result} characters and each block at maxChars (default ${TEXT_LIMITS.lyrics}, ` +
      `max ${MAX_TEXT_FIELD_CHARS}); whatever is cut is named in a trailing notice.`,
    input: z.object({
      id: z.union([z.string(), z.number()]),
      includeLrc: z.boolean().optional().describe('Include raw LRC with timestamps'),
      includeTranslation: z.boolean().optional().describe('Include the translated lyrics'),
      maxChars: maxChars.describe(
        `Maximum characters kept from each lyrics block (default ${TEXT_LIMITS.lyrics}, ` +
          `max ${MAX_TEXT_FIELD_CHARS}); blocks longer than this are cut and marked truncated.`,
      ),
    }),
    annotations: READ_ONLY,
    endpoint: 'lyric',
    render: (body, args) => {
      const limit = clampTextLimit(args.maxChars, TEXT_LIMITS.lyrics)
      const parts: string[] = []
      if (body?.lrc?.lyric) {
        const raw = args.includeLrc ? body.lrc.lyric : stripLrcTimestamps(body.lrc.lyric)
        parts.push(`--- lyrics ---\n${capText(raw, limit)}`)
      }
      if (args.includeTranslation !== false && body?.tlyric?.lyric) {
        parts.push(`--- translation ---\n${capText(stripLrcTimestamps(body.tlyric.lyric), limit)}`)
      }
      if (body?.romalrc?.lyric && args.includeTranslation !== false) {
        parts.push(`--- romanised ---\n${capText(stripLrcTimestamps(body.romalrc.lyric), limit)}`)
      }
      if (body?.nolyric) parts.push('(instrumental, no lyrics)')
      const text = parts.join('\n\n') || '(no lyrics available)'
      // Three blocks at maxChars each could still overflow the tool ceiling, and the
      // global ceiling would cut without saying which block gave way.
      return truncateText(text, {
        limit: TEXT_LIMITS.result,
        unit: 'lines',
        hint: () => `each block was capped at maxChars=${limit}; lower it or set includeTranslation=false`,
      })
    },
  },
  {
    name: 'ncm_lyric_mark',
    toolset: 'music',
    title: 'Lyric highlights',
    description:
      'Curated "lyric marks" (highlighted lines) for a song. Long fields are capped at ' +
      `maxChars characters (default ${TEXT_LIMITS.lyricMark}, max ${MAX_TEXT_FIELD_CHARS}), the whole ` +
      `result at ${TEXT_LIMITS.result}, and both are marked when truncated.`,
    input: z.object({
      id: z.union([z.string(), z.number()]),
      maxChars: maxChars.describe(
        `Maximum characters kept from each text field (default ${TEXT_LIMITS.lyricMark}).`,
      ),
    }),
    annotations: READ_ONLY,
    endpoint: 'song_lyrics_mark',
    render: (body, args) => renderJsonResult(body, clampTextLimit(args.maxChars, TEXT_LIMITS.lyricMark)),
  },
  {
    name: 'ncm_similar_songs',
    toolset: 'music',
    title: 'Similar songs',
    description:
      'Songs musically similar to the given one. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'simi_song',
    paging: {
      mode: 'offset',
      groups: [{ path: 'songs', label: 'songs' }],
    },
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Similar songs'),
  },
  {
    name: 'ncm_song_creators',
    toolset: 'music',
    title: 'Song credits',
    description:
      'Songwriters, composers and producers for a song. Long fields are capped at ' +
      `maxChars characters (default ${TEXT_LIMITS.field}, max ${MAX_TEXT_FIELD_CHARS}) and the whole ` +
      `result at ${TEXT_LIMITS.result}.`,
    input: z.object({ id: z.union([z.string(), z.number()]), maxChars }),
    annotations: READ_ONLY,
    endpoint: 'song_creators',
    render: (body, args) => renderJsonResult(body, clampTextLimit(args.maxChars, TEXT_LIMITS.field)),
  },
  {
    name: 'ncm_check_music',
    toolset: 'music',
    title: 'Availability check',
    description: 'Whether a song can be played at a given bitrate for this account.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      br: z.number().int().optional().describe('Bitrate in bps, default 320000'),
    }),
    annotations: READ_ONLY,
    endpoint: 'check_music',
    mapArgs: (args) => ({ id: args.id, br: args.br ?? 320000 }),
    render: (body) =>
      body?.success
        ? `Playable: ${body.message ?? 'yes'}`
        : `Not playable: ${body?.message ?? 'unavailable'}`,
  },
  {
    name: 'ncm_album',
    toolset: 'music',
    title: 'Album detail',
    description:
      'Album metadata and its track list. The `songs` array is paginated: page (1-based, default 1) ' +
      `and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); album metadata is always returned.`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'album',
    paging: {
      mode: 'local',
      groups: [{ path: 'songs', label: 'songs', totalPath: 'album.size' }],
    },
    render: (body) => {
      const album = body?.album ?? {}
      const songs = (body?.songs ?? []).map(slimSong)
      const head = `${album.name} — ${(album.artist?.name ?? '')}${album.publishTime ? ` (${new Date(album.publishTime).toISOString().slice(0, 10)})` : ''}\nid=${album.id} tracks=${album.size ?? songs.length}`
      if (!songs.length) return `${head}\n${emptyPageNote(body, 'songs', 'songs')}`
      return `${head}\n\n${songs.map(songLine).join('\n')}`
    },
  },
  {
    name: 'ncm_new_albums',
    toolset: 'music',
    title: 'New albums',
    description:
      'Newly released albums by region. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      area: z.enum(['ALL', 'ZH', 'EA', 'KR', 'JP']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'album_new',
    paging: { mode: 'offset', groups: [{ path: 'albums', label: 'albums' }] },
  },
  {
    name: 'ncm_artist',
    toolset: 'music',
    title: 'Artist detail',
    description:
      'Artist bio, aliases, follower counts and hot songs. The bio is capped at ' +
      `maxChars characters (default ${TEXT_LIMITS.description}, max ${MAX_TEXT_FIELD_CHARS}), the whole ` +
      `result at ${TEXT_LIMITS.result}, and both are marked when truncated.`,
    input: z.object({ id: z.union([z.string(), z.number()]), maxChars }),
    annotations: READ_ONLY,
    endpoint: 'artist_detail',
    render: (body, args) => renderJsonResult(body, clampTextLimit(args.maxChars, TEXT_LIMITS.description)),
  },
  {
    name: 'ncm_artist_songs',
    toolset: 'music',
    title: 'Artist songs',
    description:
      'Songs by an artist, ordered by popularity or release time. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      id: z.union([z.string(), z.number()]),
      order: z.enum(['hot', 'time']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'artist_songs',
    paging: { mode: 'offset', groups: [{ path: 'songs', label: 'songs' }] },
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Artist songs'),
  },
  {
    name: 'ncm_artist_albums',
    toolset: 'music',
    title: 'Artist albums',
    description:
      'Albums released by an artist. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'artist_album',
    paging: { mode: 'offset', groups: [{ path: 'hotAlbums', label: 'albums', hasMorePath: 'more' }] },
    render: (body) =>
      (body?.hotAlbums ?? [])
        .map((a: any) => `- ${a.name} (${a.size ?? '?'} tracks) id=${a.id}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_artist_top_songs',
    toolset: 'music',
    title: 'Artist top songs',
    description:
      'The most popular songs of an artist (the upstream returns at most 50). ' +
      `Paged locally: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'artist_top_song',
    paging: { mode: 'local', groups: [{ path: 'songs', label: 'songs' }] },
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Top songs'),
  },
  {
    name: 'ncm_similar_artists',
    toolset: 'music',
    title: 'Similar artists',
    description:
      'Artists similar to the given one. ' +
      `Paged locally: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'simi_artist',
    paging: { mode: 'local', groups: [{ path: 'artists', label: 'artists' }] },
  },
  {
    name: 'ncm_playlist',
    toolset: 'music',
    title: 'Playlist detail',
    description:
      'Playlist metadata plus its tracks. The `tracks` array is paginated: page (1-based, default 1) ' +
      `and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); playlist metadata (name, ` +
      'counts, creator, description) is always returned. Use ncm_playlist_tracks for large playlists.',
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'playlist_detail',
    paging: {
      mode: 'local',
      groups: [{ path: 'playlist.tracks', label: 'tracks', totalPath: 'playlist.trackCount' }],
    },
    render: (body) => {
      const playlist = body?.playlist ?? {}
      const slimmer = slimPlaylist(playlist)
      const tracks = (playlist.tracks ?? []).map(slimSong)
      return [
        `${slimmer.name} — ${slimmer.trackCount ?? tracks.length} tracks${slimmer.playCount ? `, ${slimmer.playCount} plays` : ''}`,
        `id=${slimmer.id}${slimmer.creator ? ` by ${slimmer.creator.name}` : ''}`,
        slimmer.description ? `\n${slimmer.description}` : '',
        `\n${tracks.length ? tracks.map(songLine).join('\n') : emptyPageNote(body, 'playlist.tracks', 'tracks')}`,
      ]
        .filter(Boolean)
        .join('\n')
    },
  },
  {
    name: 'ncm_playlist_tracks',
    toolset: 'music',
    title: 'Playlist tracks',
    description:
      'Page through a playlist track list without loading the whole playlist. ' +
      `page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'are applied upstream; the footer says whether more tracks exist.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'playlist_track_all',
    paging: { mode: 'offset', groups: [{ path: 'songs', label: 'tracks' }] },
    render: (body) => {
      const songs = (body?.songs ?? []).map(slimSong)
      return renderSongList(songs, `Tracks (${songs.length} in this page)`)
    },
  },
  {
    name: 'ncm_related_playlists',
    toolset: 'music',
    title: 'Related playlists',
    description:
      'Playlists that contain the same track. ' +
      `Paged locally: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'related_playlist',
    paging: { mode: 'local', groups: [{ path: 'playlists', label: 'playlists' }] },
    render: (body) =>
      (body?.playlists ?? []).map((p: any) => `- ${p.name} id=${p.id}`).join('\n') || '(none)',
  },
  {
    name: 'ncm_mv_url',
    toolset: 'music',
    title: 'MV stream URL',
    description: 'Streaming URLs for a music video, in several resolutions.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'mv_url',
    render: (body) => {
      const data = body?.data ?? {}
      const lines = ['240', '480', '720', '1080']
        .map((res) => (data[res] ? `${res}p: ${data[res]}` : ''))
        .filter(Boolean)
      return lines.join('\n') || `No MV URL (code=${body?.code ?? 'unknown'})`
    },
  },
  {
    name: 'ncm_mv_detail',
    toolset: 'music',
    title: 'MV detail',
    description: 'Music video metadata: director, artists, play count, publish date.',
    input: z.object({ mvid: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'mv_detail',
  },
]

function stripLrcTimestamps(lrc: string): string {
  return lrc
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]*\]/g, '').trimEnd())
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

const libraryTools: ToolDef[] = [
  {
    name: 'ncm_like_song',
    toolset: 'library',
    title: 'Like / unlike a song',
    description: 'Add a song to, or remove it from, the "I like" playlist.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      like: z.boolean().default(true).describe('true to like, false to unlike'),
    }),
    annotations: WRITE,
    endpoint: 'like',
    mapArgs: (args) => ({ id: args.id, like: args.like ? 'true' : 'false' }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_liked_songs',
    toolset: 'library',
    title: 'Liked song ids',
    description:
      'Every song id in the account "I like" playlist. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${MAX_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the full like total, so a large library never lands in one result.',
    input: z.object({
      uid: z.union([z.string(), z.number()]).optional().describe('Defaults to yourself'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'likelist',
    ownUidParam: true,
    requiresLogin: true,
    render: (body, args) => {
      const all: Array<number | string> = body?.ids ?? []
      const { items, meta } = paginate(all, args, { defaultPageSize: MAX_PAGE_SIZE })
      const group: PagedGroup = { label: 'song ids', path: 'ids', unit: 'ids', meta }
      const text = items.length ? `ids: ${items.join(',')}` : pagingEmptyNote(meta, 'ids')
      return `${all.length} liked songs\n${text}${pagingFooter([group])}`
    },
  },
  {
    name: 'ncm_scrobble',
    toolset: 'library',
    title: 'Report a play',
    description:
      'Report that a song was played so it lands in listening history and counts toward the weekly report.',
    input: z.object({
      id: z.union([z.string(), z.number()]).describe('Song id'),
      sourceId: z.union([z.string(), z.number()]).describe('Album id the song belongs to'),
      seconds: z.number().int().min(1).describe('How long it played, in seconds'),
    }),
    annotations: WRITE,
    endpoint: 'scrobble',
    mapArgs: (args) => ({ id: args.id, sourceid: args.sourceId, time: args.seconds }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Play reported.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_recent_songs',
    toolset: 'library',
    title: 'Recently played',
    description:
      'Recently played songs for the signed-in account. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'slice the history locally; the upstream returns at most 100 entries.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'record_recent_song',
    requiresLogin: true,
    paging: { mode: 'local', groups: [{ path: 'data.list', label: 'songs' }] },
    render: (body) => renderSongList((body?.data?.list ?? []).map(slimSong), 'Recently played'),
  },
  {
    name: 'ncm_my_playlists',
    toolset: 'library',
    title: 'My playlists',
    description:
      'Playlists owned or collected by the signed-in account. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}) ` +
      'are applied upstream; the footer reports hasMore and, on the last page, the exact total.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'user_playlist',
    run: async (args, runtime) => {
      const own = await resolveOwnUid(runtime)
      if (!own.ok) {
        return { isError: true, content: [{ type: 'text', text: own.message }] }
      }
      const result = await callNcm(
        'user_playlist',
        { uid: own.uid, ...upstreamWindow(pageRequest(args)) },
        { jar: runtime.jar, fakeIp: runtime.fakeIp },
      )
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: `Failed: ${result.body?.message ?? result.status}` }] }
      }
      // The window requested is exactly the window reported: an endpoint that answers
      // `limit` with `limit + 1` rows must not push one row into the next page, and
      // the extra row is itself proof that more exist.
      const req = pageRequest(args)
      const { items: lists, overDelivered } = takeWindow(result.body?.playlist ?? [], req.pageSize)
      const more = typeof result.body?.more === 'boolean' ? result.body.more : undefined
      const meta = pageMeta(req, lists.length, { hasMore: overDelivered ? true : more })
      const group: PagedGroup = { label: 'playlists', path: 'playlist', unit: 'playlists', meta }
      const text =
        lists
          .map(
            (p: any) =>
              `- ${p.name} (${p.trackCount ?? '?'} tracks${p.subscribed ? ', collected' : ''}) id=${p.id}`,
          )
          .join('\n') || pagingEmptyNote(meta, 'playlists')
      return { content: [{ type: 'text', text: `${text}${pagingFooter([group])}` }] }
    },
    requiresLogin: true,
  },
  {
    name: 'ncm_playlist_create',
    toolset: 'library',
    title: 'Create playlist',
    description: 'Create a new playlist (private by default).',
    input: z.object({
      name: z.string().min(1).max(80),
      public: z.boolean().default(false).describe('true for a public playlist'),
    }),
    annotations: WRITE,
    endpoint: 'playlist_create',
    mapArgs: (args) => ({ name: args.name, privacy: args.public ? 0 : 10 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) =>
      body?.playlist?.id ? `Created playlist "${body.playlist.name}" id=${body.playlist.id}` : JSON.stringify(trimGeneric(body)),
  },
  {
    name: 'ncm_playlist_add_tracks',
    toolset: 'library',
    title: 'Add tracks to playlist',
    description: 'Append one or more songs to a playlist you own.',
    input: z.object({
      id: z.union([z.string(), z.number()]).describe('Playlist id'),
      trackIds: z.string().describe('Comma-separated song ids'),
    }),
    annotations: WRITE,
    endpoint: 'playlist_tracks',
    mapArgs: (args) => ({ op: 'add', pid: args.id, tracks: args.trackIds }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Tracks added.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_playlist_remove_tracks',
    toolset: 'library',
    title: 'Remove tracks from playlist',
    description: 'Remove one or more songs from a playlist you own.',
    input: z.object({
      id: z.union([z.string(), z.number()]).describe('Playlist id'),
      trackIds: z.string().describe('Comma-separated song ids'),
    }),
    annotations: DESTRUCTIVE,
    endpoint: 'playlist_tracks',
    mapArgs: (args) => ({ op: 'del', pid: args.id, tracks: args.trackIds }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Tracks removed.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_playlist_rename',
    toolset: 'library',
    title: 'Rename playlist',
    description: 'Change the name of a playlist you own.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      name: z.string().min(1).max(80),
    }),
    annotations: WRITE,
    endpoint: 'playlist_name_update',
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Renamed.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_playlist_delete',
    toolset: 'library',
    title: 'Delete playlist',
    description: 'Delete a playlist you own. This cannot be undone.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: DESTRUCTIVE,
    endpoint: 'playlist_delete',
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Deleted.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_playlist_subscribe',
    toolset: 'library',
    title: 'Collect / uncollect playlist',
    description: 'Add a playlist to, or remove it from, your collected playlists.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      subscribe: z.boolean().default(true),
    }),
    annotations: WRITE,
    endpoint: 'playlist_subscribe',
    mapArgs: (args) => ({ id: args.id, t: args.subscribe ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_playlist_reorder',
    toolset: 'library',
    title: 'Reorder playlist',
    description: 'Rewrite the track order of a playlist you own.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      trackIds: z.string().describe('Comma-separated song ids in the desired order'),
    }),
    annotations: WRITE,
    endpoint: 'song_order_update',
    mapArgs: (args) => ({ pid: args.id, ids: `[${args.trackIds}]` }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Reordered.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_cloud_songs',
    toolset: 'library',
    title: 'Cloud music library',
    description:
      'Songs uploaded to the personal cloud music library. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the cloud-drive total and hasMore.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'user_cloud',
    paging: { mode: 'offset', groups: [{ path: 'data', label: 'songs', totalPath: 'count' }] },
    requiresLogin: true,
  },
  {
    name: 'ncm_download_list',
    toolset: 'library',
    title: 'Download list',
    description:
      'Songs in the account download list. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'song_downlist',
    paging: { mode: 'offset', groups: [{ path: 'data.list', label: 'songs', totalPath: 'data.totalCount' }] },
    requiresLogin: true,
  },
  {
    name: 'ncm_listen_stats',
    toolset: 'library',
    title: 'Listening statistics',
    description: 'Total listening counts for the signed-in account.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'listen_data_total',
    requiresLogin: true,
  },
  {
    name: 'ncm_user_binding',
    toolset: 'library',
    title: 'Linked accounts',
    description: 'Which third-party accounts are bound to this NetEase account.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'user_binding',
    ownUidParam: true,
    requiresLogin: true,
  },
  {
    name: 'ncm_yunbei',
    toolset: 'library',
    title: 'Cloud coin balance',
    description: 'Yunbei (云贝) balance and recent transactions.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'yunbei',
    requiresLogin: true,
  },
]

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

/**
 * A comment page as text. Comment bodies vary widely in length, so the ceiling is
 * applied per comment: whole comments are dropped from the end and the paging footer
 * reports what was actually delivered.
 */
function renderCommentPage(comments: any[], meta: PageMeta, total?: number): string {
  const unit = 'comments'
  const group: PagedGroup = { label: unit, path: 'comments', unit, meta }
  // The footer already states the total; this header only says it once, from the same
  // value, so a finished collection never reads "unknown" in one place and exact in
  // the other.
  const known = total ?? meta.total
  const header = `${known ?? 'unknown'} comments in total`
  if (comments.length === 0) return `${header}\n${pagingEmptyNote(meta, unit)}${pagingFooter([group])}`
  const lines = comments.map(
    (c: any) =>
      `[${c.likedCount ?? 0} likes] ${c.user?.nickname ?? 'anon'}: ${c.content}${
        c.replies?.length ? `\n    ↳ ${c.replies.length} replies` : ''
      }`,
  )
  const cut = truncateLines(lines, {
    limit: TEXT_LIMITS.result - header.length - 2,
    unit,
    // Items dropped from the tail are missing from *this* page, so re-reading must
    // start at the page whose window begins at or before this offset.
    hint: (record) => {
      const keep = Math.max(1, record.kept)
      const restart = Math.floor(meta.offset / keep) + 1
      return `re-request with pageSize<=${keep} and page=${restart} to read these ${unit}`
    },
  })
  const adjusted: PagedGroup =
    cut.kept < comments.length
      ? {
          ...group,
          meta: { ...meta, returned: cut.kept, truncated: comments.length - cut.kept, hasMore: true },
        }
      : group
  return `${header}\n${cut.text}${pagingFooter([adjusted])}`
}

// ---------------------------------------------------------------------------
// comment tools

const commentTools: ToolDef[] = [
  {
    name: 'ncm_comments',
    toolset: 'comments',
    title: 'Read comments',
    description:
      'Comments of a song, album, playlist, MV, radio programme or video. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the upstream total and hasMore. Comment bodies are capped at ' +
      `${TEXT_LIMITS.description} characters and the whole result at ${TEXT_LIMITS.result}; a page ` +
      'that would exceed it drops whole comments from the end and says how many.',
    input: z.object({
      type: commentType,
      id: z.union([z.string(), z.number()]),
      before: z.union([z.string(), z.number()]).optional().describe('Cursor from a previous page'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'comment_music',
    run: async (args, runtime) => {
      const endpoint = {
        song: 'comment_music',
        mv: 'comment_mv',
        playlist: 'comment_playlist',
        album: 'comment_album',
        dj: 'comment_dj',
        video: 'comment_video',
        event: 'comment_event',
      }[args.type as string] ?? 'comment_music'

      const result = await callNcm(
        endpoint,
        { id: args.id, ...(args.before ? { before: args.before } : {}), ...upstreamWindow(pageRequest(args)) },
        { jar: runtime.jar, fakeIp: runtime.fakeIp },
      )
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: `Failed: ${result.body?.message ?? result.status}` }] }
      }
      const req = pageRequest(args)
      const { items: comments, overDelivered } = takeWindow(
        (result.body?.comments ?? []).map(slimComment),
        req.pageSize,
      )
      const total = typeof result.body?.total === 'number' ? result.body.total : undefined
      const more = typeof result.body?.more === 'boolean' ? result.body.more : undefined
      const meta = pageMeta(req, comments.length, {
        total,
        hasMore: overDelivered ? true : more,
      })
      return {
        content: [
          {
            type: 'text',
            text: renderCommentPage(comments, meta, total),
          },
        ],
      }
    },
  },
  {
    name: 'ncm_comment_hot',
    toolset: 'comments',
    title: 'Hot comments',
    description:
      'Top-liked comments for a song. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'comment_hot',
    paging: { mode: 'offset', groups: [{ path: 'hotComments', label: 'comments' }] },
    render: (body) => {
      const comments = (body?.hotComments ?? []).map(slimComment)
      return (
        comments.map((c: any) => `[${c.likedCount} likes] ${c.user?.nickname ?? 'anon'}: ${c.content}`).join('\n') ||
        '(none)'
      )
    },
  },
  {
    name: 'ncm_comment_post',
    toolset: 'comments',
    title: 'Post comment',
    description: 'Post a comment on a song, album, playlist or MV.',
    input: z.object({
      type: commentType,
      id: z.union([z.string(), z.number()]),
      content: z.string().min(1).max(140),
    }),
    annotations: WRITE,
    endpoint: 'comment_add',
    mapArgs: (args) => ({
      id: args.id,
      type: COMMENT_TYPE_CODE[args.type as string] ?? 0,
      content: args.content,
    }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) =>
      body?.code === 200 ? `Comment posted id=${body.comment?.commentId ?? '?'}` : JSON.stringify(trimGeneric(body)),
  },
  {
    name: 'ncm_comment_delete',
    toolset: 'comments',
    title: 'Delete comment',
    description: 'Delete your own comment.',
    input: z.object({
      type: commentType,
      id: z.union([z.string(), z.number()]).describe('Resource id the comment belongs to'),
      commentId: z.union([z.string(), z.number()]),
    }),
    annotations: DESTRUCTIVE,
    endpoint: 'comment_delete',
    mapArgs: (args) => ({
      id: args.id,
      type: COMMENT_TYPE_CODE[args.type as string] ?? 0,
      cid: args.commentId,
    }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Deleted.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_comment_like',
    toolset: 'comments',
    title: 'Like a comment',
    description: 'Like or unlike a comment.',
    input: z.object({
      type: commentType,
      id: z.union([z.string(), z.number()]).describe('Resource id the comment belongs to'),
      commentId: z.union([z.string(), z.number()]),
      like: z.boolean().default(true),
      threadId: z.string().optional().describe('Thread id for replies'),
    }),
    annotations: WRITE,
    endpoint: 'comment_like',
    mapArgs: (args) => ({
      id: args.id,
      type: COMMENT_TYPE_CODE[args.type as string] ?? 0,
      cid: args.commentId,
      t: args.like ? 1 : 0,
      ...(args.threadId ? { threadId: args.threadId } : {}),
    }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_comment_reply',
    toolset: 'comments',
    title: 'Reply to comment',
    description: 'Reply to an existing comment on a resource.',
    input: z.object({
      type: commentType,
      id: z.union([z.string(), z.number()]),
      commentId: z.union([z.string(), z.number()]),
      content: z.string().min(1).max(140),
    }),
    annotations: WRITE,
    endpoint: 'comment_reply',
    mapArgs: (args) => ({
      id: args.id,
      type: COMMENT_TYPE_CODE[args.type as string] ?? 0,
      commentId: args.commentId,
      content: args.content,
    }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Reply posted.' : JSON.stringify(trimGeneric(body))),
  },
]

// ---------------------------------------------------------------------------
// social
// ---------------------------------------------------------------------------

const socialTools: ToolDef[] = [
  {
    name: 'ncm_follow_user',
    toolset: 'social',
    title: 'Follow / unfollow user',
    description: 'Follow or unfollow another NetEase user.',
    input: z.object({
      uid: z.union([z.string(), z.number()]),
      follow: z.boolean().default(true),
    }),
    annotations: WRITE,
    endpoint: 'follow',
    mapArgs: (args) => ({ id: args.uid, t: args.follow ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_subscribe_artist',
    toolset: 'social',
    title: 'Subscribe / unsubscribe artist',
    description: 'Add or remove an artist from the account subscriptions.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      subscribe: z.boolean().default(true),
    }),
    annotations: WRITE,
    endpoint: 'artist_sub',
    mapArgs: (args) => ({ id: args.id, t: args.subscribe ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_subscribed_artists',
    toolset: 'social',
    title: 'Subscribed artists',
    description:
      'Artists the account has subscribed to. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'the footer reports the subscription total and hasMore.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'artist_sublist',
    paging: {
      mode: 'offset',
      groups: [{ path: 'data', label: 'artists', totalPath: 'total' }],
    },
    requiresLogin: true,
  },
  {
    name: 'ncm_subscribe_mv',
    toolset: 'social',
    title: 'Subscribe / unsubscribe MV',
    description: 'Add or remove an MV from the account subscriptions.',
    input: z.object({
      mvid: z.union([z.string(), z.number()]),
      subscribe: z.boolean().default(true),
    }),
    annotations: WRITE,
    endpoint: 'mv_sub',
    mapArgs: (args) => ({ mvid: args.mvid, t: args.subscribe ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_subscribe_radio',
    toolset: 'social',
    title: 'Subscribe / unsubscribe radio',
    description: 'Add or remove a radio station from the account subscriptions.',
    input: z.object({
      rid: z.union([z.string(), z.number()]),
      subscribe: z.boolean().default(true),
    }),
    annotations: WRITE,
    endpoint: 'dj_sub',
    mapArgs: (args) => ({ rid: args.rid, t: args.subscribe ? 1 : 0 }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Done.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_private_messages',
    toolset: 'social',
    title: 'Private messages',
    description:
      'Recent private message conversations. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'msg_private',
    paging: { mode: 'offset', groups: [{ path: 'msgs', label: 'conversations' }] },
    requiresLogin: true,
  },
  {
    name: 'ncm_user_events',
    toolset: 'social',
    title: 'User activity feed',
    description:
      'Recent activity (shares, posts, follows) of a user. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}). ` +
      'For deeper history pass the `lasttime` cursor from the last event instead of a high page.',
    input: z.object({
      uid: z.union([z.string(), z.number()]),
      lasttime: z.union([z.string(), z.number()]).optional().describe('Cursor: timestamp of the oldest event seen'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'user_event',
    mapArgs: (args) => ({
      uid: args.uid,
      ...(args.lasttime !== undefined ? { lasttime: args.lasttime } : {}),
    }),
    paging: { mode: 'limit', groups: [{ path: 'events', label: 'events' }] },
    render: (body) => {
      const events: any[] = body?.events ?? []
      const lines = events.map((event) => {
        const info = event?.info ?? {}
        const title =
          info.commentThread?.resourceInfo?.name ??
          info?.name ??
          event?.json?.msg ??
          event?.info?.commentThread?.title ??
          '(no title)'
        const who = event?.user?.nickname ?? event?.info?.user?.nickname ?? 'someone'
        const kind = info.commentThread ? 'comment' : info.resourceInfo ? 'share' : 'activity'
        return `- [${kind}] ${who}: ${trimText(String(title), 120)} id=${event?.id ?? event?.discussId ?? '?'}`
      })
      return lines.join('\n') || emptyPageNote(body, 'events', 'events')
    },
  },
  {
    name: 'ncm_similar_users',
    toolset: 'social',
    title: 'Similar users',
    description:
      'Users with similar taste. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'simi_user',
    paging: { mode: 'offset', groups: [{ path: 'followeds', label: 'users' }] },
    render: (body) => renderUserList(body?.followeds ?? [], 'Similar users'),
  },
  {
    name: 'ncm_share',
    toolset: 'social',
    title: 'Share a resource',
    description: 'Share a song, album, playlist or MV to the account activity feed.',
    input: z.object({
      type: z.enum(['song', 'album', 'playlist', 'mv', 'dj']).default('song'),
      id: z.union([z.string(), z.number()]),
      msg: z.string().max(140).optional().describe('Message to attach to the share'),
    }),
    annotations: WRITE,
    endpoint: 'share_resource',
    mapArgs: (args) => ({ type: args.type, id: args.id, ...(args.msg ? { msg: args.msg } : {}) }),
    requiresLogin: true,
    requiresWrite: true,
    render: (body) => (body?.code === 200 ? 'Shared.' : JSON.stringify(trimGeneric(body))),
  },
  {
    name: 'ncm_radio_detail',
    toolset: 'social',
    title: 'Radio station detail',
    description:
      'Programme list and metadata for a radio station. The `programs` array is paginated: page ' +
      `(1-based, default 1) and pageSize (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); ` +
      'station metadata is always returned.',
    input: z.object({ rid: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'dj_detail',
    paging: { mode: 'local', groups: [{ path: 'programs', label: 'programmes' }] },
  },
]

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

const READ_SAFE_RAW = new Set([
  'search',
  'cloudsearch',
  'song_detail',
  'song_url',
  'song_url_v1',
  'lyric',
  'album',
  'artist_detail',
  'artist_songs',
  'artist_album',
  'playlist_detail',
  'playlist_track_all',
  'user_detail',
  'user_playlist',
  'comment',
  'comment_music',
  'comment_hot',
  'dj_detail',
  'mv_detail',
  'toplist',
  'personalized',
  'recommend_songs',
  'simi_song',
  'simi_artist',
  'search_suggest',
  'search_hot',
  'song_download_url',
  'check_music',
  'song_lyrics_mark',
  'related_playlist',
  'song_creators',
  'mv_url',
  'chart_detail',
  'top_song',
  'top_playlist',
  'top_artists',
  'banner',
  'calendar',
  'personalized_newsong',
  'record_recent_song',
  'likelist',
  'user_level',
  'user_subcount',
  'user_follows',
  'user_followeds',
  'vip_info',
  'login_status',
  'user_account',
  'yunbei',
  'song_downlist',
  'user_cloud',
])

const metaTools: ToolDef[] = [
  {
    name: 'ncm_list_endpoints',
    toolset: 'meta',
    title: 'List all endpoints',
    description:
      'List every underlying NetEase API endpoint this server can proxy. Useful before calling ' +
      'ncm_raw for something the curated tools do not cover. ' +
      `Paged: page (1-based, default 1) and pageSize (default ${MAX_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    input: z.object({
      filter: z.string().optional().describe('Only return endpoint names containing this substring'),
      ...paging,
    }),
    annotations: READ_ONLY,
    run: async (args) => {
      const { listEndpointNames } = await import('@/lib/ncm/modules')
      const blocked = blockedRawEndpoints()
      const all = listEndpointNames()
      const allowed = all.filter((name) => !blocked.has(name.toLowerCase()))
      const hidden = all.length - allowed.length
      const filtered = args.filter
        ? allowed.filter((name) => name.toLowerCase().includes(String(args.filter).toLowerCase()))
        : allowed
      const { items, meta } = paginate(filtered, args, { defaultPageSize: MAX_PAGE_SIZE })
      const group: PagedGroup = { label: 'endpoints', path: 'endpoints', unit: 'endpoints', meta }
      return {
        content: [
          {
            type: 'text',
            text:
              `${filtered.length} of ${allowed.length} endpoints:` +
                `${hidden > 0 ? ` (${hidden} hidden: identity mutation and money-spending endpoints)` : ''}\n` +
              `${items.join(', ')}` +
              `${pagingFooter([group])}`,
          },
        ],
      }
    },
  },
  {
    name: 'ncm_raw',
    toolset: 'meta',
    title: 'Raw endpoint call',
    description:
      'Call any underlying NetEase endpoint by name with free-form parameters. Read-only endpoints ' +
      'are always allowed; write endpoints additionally need the ncm:write scope. Endpoints that ' +
      'mutate account identity (profile/avatar/phone/linked-account changes, logout, sign-in, ' +
      'registration, captcha) or spend money (gifting, paid charts, coin spend, digital albums) ' +
      'are blocked outright and are not listed by ncm_list_endpoints. The payload is ' +
      `capped at ${TEXT_LIMITS.raw} characters and long text fields at maxChars (default ` +
      `${TEXT_LIMITS.field}, max ${MAX_TEXT_FIELD_CHARS}); the result names any field it shortened. ` +
      'limit and offset are forwarded to the endpoint as real parameters and take precedence over ' +
      'the same keys inside params, so an offset-capable endpoint pages upstream instead of locally. ' +
      'Note that many NetEase endpoints answer with limit+1 rows to report their own "more" flag; ' +
      'that extra row is the endpoint’s signal, not part of your requested window.',
    input: z.object({
      endpoint: z.string().min(1).describe('Endpoint name, from ncm_list_endpoints'),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe('Parameters passed straight through; limit/offset here are kept unless set on the input'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .optional()
        .describe(
          `Rows to ask the endpoint for (1..${MAX_PAGE_SIZE}). Forwarded upstream as \`limit\`; ` +
            'endpoints that over-deliver may return one extra row for their own "more" flag.',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Rows to skip. Forwarded upstream as `offset`; needs an endpoint that honours it.'),
      maxChars: maxChars.describe(
        `Maximum characters kept from each long text field (default ${TEXT_LIMITS.field}, ` +
          `max ${MAX_TEXT_FIELD_CHARS}).`,
      ),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    // The escape hatch is allowed the larger ceiling; everything else stays at 12000.
    maxTextChars: TEXT_LIMITS.raw,
    run: async (args, runtime) => {
      const { hasEndpoint } = await import('@/lib/ncm/modules')
      if (!hasEndpoint(args.endpoint)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown endpoint "${args.endpoint}". Try ncm_list_endpoints.` }],
        }
      }
      if (blockedRawEndpoints().has(args.endpoint.toLowerCase())) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `"${args.endpoint}" is blocked and cannot be proxied through ncm_raw. Blocked ` +
                'endpoints are the ones that mutate account identity (profile, avatar, phone, ' +
                'linked accounts, session, sign-in/registration) or spend money, and none of them ' +
                'are reachable from this server. Use the curated tools for anything else.',
            },
          ],
        }
      }
      const readSafe = READ_SAFE_RAW.has(args.endpoint)
      if (!readSafe && !runtime.scope.split(' ').includes('ncm:write')) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `"${args.endpoint}" can change account state and needs the ncm:write scope. ` +
                'Reconnect with ncm:write (calling any write tool such as ncm_like_song triggers ' +
                'the step-up flow), or use ncm_list_endpoints to find a read-only alternative.',
            },
          ],
        }
      }
      const fieldLimit = clampTextLimit(args.maxChars, TEXT_LIMITS.field)
      // `limit`/`offset` are real inputs now, so they reach the endpoint instead of
      // being stripped by the schema. A top-level value wins over the same key inside
      // `params`; `params` on its own keeps working exactly as before.
      const upstream: Record<string, unknown> = { ...(args.params ?? {}) }
      if (args.limit !== undefined) upstream.limit = args.limit
      if (args.offset !== undefined) upstream.offset = args.offset
      const result = await callNcm(args.endpoint, upstream, {
        jar: runtime.jar,
        fakeIp: runtime.fakeIp,
      })
      // Echo the window that actually went upstream, plus the endpoint's own "more"
      // flag when it sends one, so a caller can tell the params were honoured.
      const sentLimit = typeof upstream.limit === 'number' ? upstream.limit : undefined
      const sentOffset = typeof upstream.offset === 'number' ? upstream.offset : undefined
      const body = result.body
      let payload = body
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (sentLimit !== undefined || sentOffset !== undefined)
      ) {
        payload = {
          ...body,
          request: {
            ...(sentLimit !== undefined ? { limit: sentLimit } : {}),
            ...(sentOffset !== undefined ? { offset: sentOffset } : {}),
            ...(typeof body.more === 'boolean' ? { hasMore: body.more } : {}),
            ...(typeof body.total === 'number' ? { total: body.total } : {}),
            note: 'window sent upstream as limit/offset; some endpoints answer with limit+1 rows for their own more flag',
          },
        }
      }
      const text = renderJsonResult(payload, fieldLimit, TEXT_LIMITS.raw)
      return { content: [{ type: 'text', text }], isError: !result.ok }
    },
  },
  {
    name: 'ncm_about',
    toolset: 'meta',
    title: 'About this server',
    description: 'Explain what this server is, how login works, and which toolsets are enabled.',
    input: z.object({}),
    annotations: READ_ONLY,
    run: async (_args, runtime) => {
      const loggedIn = Boolean(runtime.jar.MUSIC_U)
      const lines = [
        'NeteaseCloudMusic MCP — a stateless MCP server for the NetEase Cloud Music API, hosted on Vercel.',
        '',
        `Session: ${loggedIn ? `logged in${runtime.nickname ? ` as ${runtime.nickname}` : ''}` : 'anonymous (public read only)'}`,
        `Scopes: ${runtime.scope}`,
        `Outbound IP used for NetEase calls: ${runtime.fakeIp ?? 'none (server default)'}`,
        '',
        'Login happens through the OAuth flow: the browser page offers QR, SMS and password sign-in,',
        'and the resulting session cookie is sealed inside the MCP access token. Nothing is stored',
        'server-side, so this deployment keeps no user data at rest.',
        '',
        'Toolset groups:',
        ...TOOLSETS.map((entry) => `- ${entry.name}: ${entry.title} — ${entry.blurb}`),
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  },
]

export const ALL_TOOLS: ToolDef[] = [
  ...accountTools,
  ...searchTools,
  ...discoverTools,
  ...musicTools,
  ...libraryTools,
  ...commentTools,
  ...socialTools,
  ...metaTools,
]

export const TOOL_COUNT = ALL_TOOLS.length

/** Tool count per group, for the landing page. */
export function toolsetCounts(): Record<ToolsetName, number> {
  const counts = Object.fromEntries(
    TOOLSETS.map((entry) => [entry.name, 0]),
  ) as Record<ToolsetName, number>
  for (const tool of ALL_TOOLS) counts[tool.toolset] += 1
  return counts
}
