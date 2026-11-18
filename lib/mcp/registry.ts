import type { ToolAnnotations } from '@modelcontextprotocol/server'
import * as z from 'zod'

import { callNcm } from '@/lib/ncm/client'
import type { CookieJar } from '@/lib/ncm/cookies'
import {
  slimComment,
  slimPlaylist,
  slimSong,
  slimUser,
  toToolText,
  trimGeneric,
  trimText,
} from '@/lib/ncm/serialize'

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
  requiresWrite?: boolean
  requiresLogin?: boolean
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

const paging = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100'),
  offset: z.number().int().min(0).optional().describe('Offset for paging'),
}

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

/** Default runner: endpoint call, generic trim, JSON text. */
async function defaultRun(def: ToolDef, args: any, runtime: ToolRuntime): Promise<ToolResult> {
  const params = def.mapArgs ? def.mapArgs(args, runtime) : { ...args }
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

  const text = def.render
    ? def.render(result.body, args)
    : toToolText(trimGeneric(result.body))
  return { content: [{ type: 'text', text }] }
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
    return def.run ? await def.run(args, runtime) : await defaultRun(def, args, runtime)
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool failed: ${(error as Error).message}` }],
    }
  }
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
    render: (body) => {
      const data = body?.data ?? body
      if (!data?.account) {
        return [
          'Anonymous session: no NetEase account is linked to this connection.',
          'Public read tools work. Anything personal (library, playlists, likes, writes) needs sign-in:',
          'disconnect the server in your MCP client, reconnect, and use the login page that opens.',
        ].join('\n')
      }
      return [
        `Logged in as ${data.profile?.nickname ?? '(unknown)'}`,
        `userId: ${data.account.id}`,
        `VIP type: ${data.account.vipType ?? 0}`,
        `created: ${data.account.createTime ?? 'n/a'}`,
      ].join('\n')
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
    description: 'Users the given account follows.',
    input: z.object({
      uid: z.union([z.string(), z.number()]).describe('User id; use ncm_account_status for your own'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'user_follows',
    render: (body) => renderUserList(body?.follow ?? [], 'Following'),
  },
  {
    name: 'ncm_user_followeds',
    toolset: 'account',
    title: 'Follower list',
    description: 'Users following the given account.',
    input: z.object({
      uid: z.union([z.string(), z.number()]).describe('User id'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'user_followeds',
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
  },
]

function renderUserList(users: any[], heading: string): string {
  if (!users.length) return `${heading}\n(empty)`
  return `${heading}\n${users
    .map((u) => `- ${u.nickname ?? u.name} id=${u.userId ?? u.id}${u.signature ? ` — ${trimText(u.signature, 80)}` : ''}`)
    .join('\n')}`
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
      'Returns a compact list with ids you can pass to the detail tools.',
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
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
    }),
    render: (body, args) => renderSearch(body?.result ?? {}, args.type),
  },
  {
    name: 'ncm_search_cloud',
    toolset: 'search',
    title: 'Search (cloud index)',
    description: 'Search against the cloud index, which has better coverage for niche and new releases.',
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
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
    }),
    render: (body, args) => renderSearch(body?.result ?? {}, args.type),
  },
  {
    name: 'ncm_search_suggest',
    toolset: 'search',
    title: 'Search suggestions',
    description: 'Autocomplete suggestions for a partial query.',
    input: z.object({ keywords: z.string().min(1) }),
    annotations: READ_ONLY,
    endpoint: 'search_suggest',
    render: (body) =>
      (body?.result?.allMatch ?? []).map((entry: any) => `- ${entry.keyword}`).join('\n') ||
      '(no suggestions)',
  },
  {
    name: 'ncm_search_hot',
    toolset: 'search',
    title: 'Trending searches',
    description: 'Current hot search keywords on NetEase.',
    input: z.object({ detail: z.boolean().optional().describe('Include trending topic details') }),
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
      return {
        content: [
          {
            type: 'text',
            text:
              list
                .slice(0, 40)
                .map((entry: any, index: number) => `${index + 1}. ${entry.first ?? entry.searchWord ?? entry.keyword}`)
                .join('\n') || JSON.stringify(trimGeneric(result.body), null, 2),
          },
        ],
      }
    },
  },
  {
    name: 'ncm_search_multimatch',
    toolset: 'search',
    title: 'Multi-match search',
    description: 'Search across multiple result kinds in one call and get ids for each match.',
    input: z.object({
      keywords: z.string().min(1),
      type: z.number().int().min(1).max(100).optional().describe('Result kind bitmask; default 1 (songs)'),
    }),
    annotations: READ_ONLY,
    endpoint: 'search_multimatch',
  },
  {
    name: 'ncm_search_default',
    toolset: 'search',
    title: 'Default search landing',
    description: 'The default discovery payload NetEase shows on an empty search box.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'search_default',
  },
  {
    name: 'ncm_search_lyric',
    toolset: 'search',
    title: 'Search by lyric',
    description: 'Find songs whose lyrics match a phrase.',
    input: z.object({
      keywords: z.string().min(1),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'search',
    mapArgs: (args) => ({
      keywords: args.keywords,
      type: SEARCH_TYPE_CODE.lyric,
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
    }),
    render: (body) => {
      const songs = body?.result?.songs ?? []
      return renderSongList(songs.map(slimSong), 'Lyric matches')
    },
  },
  {
    name: 'ncm_search_song_page',
    toolset: 'search',
    title: 'Search song page',
    description: 'Paged song-only search results, cheaper than a mixed search when you only need songs.',
    input: z.object({
      keywords: z.string().min(1),
      page: z.number().int().min(1).max(100).optional().describe('1-based page number, default 1'),
      pageSize: z.number().int().min(1).max(100).optional().describe('Songs per page, default 20'),
    }),
    annotations: READ_ONLY,
    endpoint: 'search',
    mapArgs: (args) => {
      const pageSize = args.pageSize ?? 20
      const page = args.page ?? 1
      return {
        keywords: args.keywords,
        type: SEARCH_TYPE_CODE.song,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }
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
      `Albums\n${result.albums
        .slice(0, 20)
        .map((a: any) => `- ${a.name} — ${a.artist?.name ?? ''} id=${a.id}`)
        .join('\n')}`,
    )
  }
  if (result.artists?.length) {
    lines.push(
      `Artists\n${result.artists
        .slice(0, 20)
        .map((a: any) => `- ${a.name}${a.alias?.length ? ` (${a.alias.join(', ')})` : ''} id=${a.id}`)
        .join('\n')}`,
    )
  }
  if (result.playlists?.length) {
    lines.push(
      `Playlists\n${result.playlists
        .slice(0, 20)
        .map((p: any) => `- ${p.name} — ${p.trackCount ?? '?'} tracks id=${p.id}`)
        .join('\n')}`,
    )
  }
  if (result.users?.length) {
    lines.push(renderUserList(result.users, 'Users'))
  }
  if (result.mvs?.length) {
    lines.push(
      `Music videos\n${result.mvs.slice(0, 20).map((m: any) => `- ${m.name} id=${m.id}`).join('\n')}`,
    )
  }
  if (result.djRadios?.length) {
    lines.push(
      `Radio\n${result.djRadios
        .slice(0, 20)
        .map((d: any) => `- ${d.name} id=${d.id}`)
        .join('\n')}`,
    )
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
    description: 'Personalised playlist recommendations for the current session.',
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    annotations: READ_ONLY,
    endpoint: 'personalized',
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
      'one otherwise.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'recommend_songs',
    render: (body) => {
      const songs = body?.data?.dailySongs ?? body?.recommend ?? []
      return renderSongList(songs.map(slimSong), 'Daily recommendations')
    },
  },
  {
    name: 'ncm_recommend_resource',
    toolset: 'discover',
    title: 'Recommended resources',
    description: 'Mixed recommended resources: playlists, radio and albums.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'recommend_resource',
    render: (body) =>
      (body?.recommend ?? [])
        .map((r: any) => `- ${r.name} (${r.type}) id=${r.id}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_new_songs',
    toolset: 'discover',
    title: 'New releases',
    description: 'Newly released songs, per region.',
    input: z.object({
      area: z.enum(['ALL', 'ZH', 'EA', 'KR', 'JP']).optional().describe('Region, default ALL'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    annotations: READ_ONLY,
    endpoint: 'personalized_newsong',
    render: (body) => renderSongList((body?.result ?? []).map(slimSong), 'New songs'),
  },
  {
    name: 'ncm_toplist',
    toolset: 'discover',
    title: 'All toplists',
    description: 'Every NetEase chart: soars, new songs, originals, and the global top 500.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'toplist',
    render: (body) =>
      (body?.list ?? [])
        .map((l: any) => `- ${l.name} id=${l.id}${l.updateFrequency ? ` (${l.updateFrequency})` : ''}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_toplist_detail',
    toolset: 'discover',
    title: 'Toplist summaries',
    description: 'Summary of every toplist with its top tracks.',
    input: z.object({}),
    annotations: READ_ONLY,
    endpoint: 'toplist_detail_v2',
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
    description: 'Full track list of one toplist, newest first.',
    input: z.object({
      id: z.union([z.string(), z.number()]).describe('Toplist id from ncm_toplist'),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'playlist_detail',
    mapArgs: (args) => ({ id: args.id }),
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
    description: 'Home page promotional banners.',
    input: z.object({
      type: z.enum(['pc', 'android', 'iphone', 'ipad']).optional(),
    }),
    annotations: READ_ONLY,
    endpoint: 'banner',
    mapArgs: (args) => ({
      type: ({ pc: 0, android: 1, iphone: 2, ipad: 3 } as Record<string, number>)[args.type ?? 'pc'],
    }),
    render: (body) =>
      (body?.banners ?? []).map((b: any) => `- ${b.typeTitle ?? b.song?.name ?? b.url}`).join('\n') || '(none)',
  },
  {
    name: 'ncm_top_songs',
    toolset: 'discover',
    title: 'Top songs by region',
    description: 'Regional charts of the most played songs.',
    input: z.object({ area: z.enum(['all', 'zh', 'ea', 'kr', 'ja']).optional() }),
    annotations: READ_ONLY,
    endpoint: 'top_song',
    mapArgs: (args) => ({
      type: ({ all: 0, zh: 7, ea: 96, kr: 16, ja: 8 } as Record<string, number>)[args.area ?? 'all'],
    }),
    render: (body) => renderSongList((body?.data ?? []).map(slimSong), 'Top songs'),
  },
  {
    name: 'ncm_top_playlists',
    toolset: 'discover',
    title: 'Top playlists',
    description: 'Popular playlists, optionally by category.',
    input: z.object({
      cat: z.string().optional().describe('Category name, e.g. 华语 / 摇滚 / 电子'),
      order: z.enum(['hot', 'new']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'top_playlist',
  },
  {
    name: 'ncm_top_artists',
    toolset: 'discover',
    title: 'Top artists',
    description: 'Most popular artists on the platform.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'top_artists',
  },
  {
    name: 'ncm_music_calendar',
    toolset: 'discover',
    title: 'Release calendar',
    description: 'Albums and singles released in a date range.',
    input: z.object({
      startTime: z.union([z.string(), z.number()]).describe('Start of range in epoch ms'),
      endTime: z.union([z.string(), z.number()]).describe('End of range in epoch ms'),
    }),
    annotations: READ_ONLY,
    endpoint: 'calendar',
    render: (body) => {
      const days = Object.entries(body?.data ?? {}) as [string, any][]
      if (!days.length) return '(nothing released in range)'
      return days
        .map(
          ([day, payload]) =>
            `${day}\n${(payload?.newAlbums ?? [])
              .map((a: any) => `  · ${a.name} — ${a.artist?.name ?? ''} id=${a.id}`)
              .join('\n')}`,
        )
        .join('\n')
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
      'publish time and whether a play URL is available.',
    input: z.object({
      ids: z.string().describe('Comma-separated song ids, e.g. "347230,186016"'),
    }),
    annotations: READ_ONLY,
    endpoint: 'song_detail',
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
      'empty url and a `code` explaining the reason (region lock or VIP requirement).',
    input: z.object({
      ids: z.string().describe('Comma-separated song ids'),
      level: quality.optional(),
    }),
    annotations: READ_ONLY,
    endpoint: 'song_url_v1',
    run: async (args, runtime) => {
      const ids = String(args.ids)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)

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
      return { content: [{ type: 'text', text: lines.join('\n') || '(nothing resolved)' }] }
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
    description: 'Plain and translated lyrics plus the LRC timestamped version.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      includeLrc: z.boolean().optional().describe('Include raw LRC with timestamps'),
      includeTranslation: z.boolean().optional().describe('Include the translated lyrics'),
    }),
    annotations: READ_ONLY,
    endpoint: 'lyric',
    render: (body, args) => {
      const parts: string[] = []
      if (body?.lrc?.lyric) parts.push(args.includeLrc ? body.lrc.lyric : stripLrcTimestamps(body.lrc.lyric))
      if (args.includeTranslation !== false && body?.tlyric?.lyric) {
        parts.push(`--- translation ---\n${stripLrcTimestamps(body.tlyric.lyric)}`)
      }
      if (body?.romalrc?.lyric && args.includeTranslation !== false) {
        parts.push(`--- romanised ---\n${stripLrcTimestamps(body.romalrc.lyric)}`)
      }
      if (body?.nolyric) parts.push('(instrumental, no lyrics)')
      return parts.join('\n\n') || '(no lyrics available)'
    },
  },
  {
    name: 'ncm_lyric_mark',
    toolset: 'music',
    title: 'Lyric highlights',
    description: 'Curated "lyric marks" (highlighted lines) for a song.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'song_lyrics_mark',
  },
  {
    name: 'ncm_similar_songs',
    toolset: 'music',
    title: 'Similar songs',
    description: 'Songs musically similar to the given one.',
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'simi_song',
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Similar songs'),
  },
  {
    name: 'ncm_song_creators',
    toolset: 'music',
    title: 'Song credits',
    description: 'Songwriters, composers and producers for a song.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'song_creators',
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
    description: 'Album metadata and its full track list.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'album',
    render: (body) => {
      const album = body?.album ?? {}
      const songs = (body?.songs ?? []).map(slimSong)
      const head = `${album.name} — ${(album.artist?.name ?? '')}${album.publishTime ? ` (${new Date(album.publishTime).toISOString().slice(0, 10)})` : ''}\nid=${album.id} tracks=${songs.length}`
      return `${head}\n\n${songs.map(songLine).join('\n')}`
    },
  },
  {
    name: 'ncm_new_albums',
    toolset: 'music',
    title: 'New albums',
    description: 'Newly released albums by region.',
    input: z.object({
      area: z.enum(['ALL', 'ZH', 'EA', 'KR', 'JP']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'album_new',
  },
  {
    name: 'ncm_artist',
    toolset: 'music',
    title: 'Artist detail',
    description: 'Artist bio, aliases, follower counts and hot songs.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'artist_detail',
  },
  {
    name: 'ncm_artist_songs',
    toolset: 'music',
    title: 'Artist songs',
    description: 'Songs by an artist, ordered by popularity or release time.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      order: z.enum(['hot', 'time']).optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'artist_songs',
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Artist songs'),
  },
  {
    name: 'ncm_artist_albums',
    toolset: 'music',
    title: 'Artist albums',
    description: 'Albums released by an artist.',
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'artist_album',
    render: (body) =>
      (body?.hotAlbums ?? [])
        .map((a: any) => `- ${a.name} (${a.size ?? '?'} tracks) id=${a.id}`)
        .join('\n') || '(none)',
  },
  {
    name: 'ncm_artist_top_songs',
    toolset: 'music',
    title: 'Artist top songs',
    description: 'The most popular songs of an artist.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'artist_top_song',
    render: (body) => renderSongList((body?.songs ?? []).map(slimSong), 'Top songs'),
  },
  {
    name: 'ncm_similar_artists',
    toolset: 'music',
    title: 'Similar artists',
    description: 'Artists similar to the given one.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'simi_artist',
  },
  {
    name: 'ncm_playlist',
    toolset: 'music',
    title: 'Playlist detail',
    description: 'Playlist metadata plus its first tracks. Use ncm_playlist_tracks for full paging.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'playlist_detail',
    render: (body) => {
      const playlist = body?.playlist ?? {}
      const slimmer = slimPlaylist(playlist)
      const tracks = (playlist.tracks ?? []).map(slimSong)
      return [
        `${slimmer.name} — ${slimmer.trackCount ?? tracks.length} tracks${slimmer.playCount ? `, ${slimmer.playCount} plays` : ''}`,
        `id=${slimmer.id}${slimmer.creator ? ` by ${slimmer.creator.name}` : ''}`,
        slimmer.description ? `\n${slimmer.description}` : '',
        `\n${tracks.map(songLine).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n')
    },
  },
  {
    name: 'ncm_playlist_tracks',
    toolset: 'music',
    title: 'Playlist tracks',
    description: 'Page through a playlist track list without loading the whole playlist.',
    input: z.object({
      id: z.union([z.string(), z.number()]),
      ...paging,
    }),
    annotations: READ_ONLY,
    endpoint: 'playlist_track_all',
    render: (body) => {
      const songs = (body?.songs ?? []).map(slimSong)
      return renderSongList(songs, `Tracks (${songs.length} in this page)`)
    },
  },
  {
    name: 'ncm_related_playlists',
    toolset: 'music',
    title: 'Related playlists',
    description: 'Playlists that contain the same track.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'related_playlist',
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
    description: 'Every song id in the account "I like" playlist.',
    input: z.object({ uid: z.union([z.string(), z.number()]).optional().describe('Defaults to yourself') }),
    annotations: READ_ONLY,
    endpoint: 'likelist',
    requiresLogin: true,
    render: (body) => {
      const ids: Array<number | string> = body?.ids ?? []
      return `${ids.length} liked songs\nids: ${ids.join(',')}`
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
    description: 'Recently played songs for the signed-in account.',
    input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    annotations: READ_ONLY,
    endpoint: 'record_recent_song',
    requiresLogin: true,
    render: (body) => renderSongList((body?.data?.list ?? []).map(slimSong), 'Recently played'),
  },
  {
    name: 'ncm_my_playlists',
    toolset: 'library',
    title: 'My playlists',
    description: 'Playlists owned or collected by the signed-in account.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'user_playlist',
    run: async (args, runtime) => {
      const uid = runtime.userId
      if (!uid) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'No account id in this session; sign in again to refresh it.' }],
        }
      }
      const result = await callNcm(
        'user_playlist',
        { uid, ...(args.limit ? { limit: args.limit } : {}), ...(args.offset ? { offset: args.offset } : {}) },
        { jar: runtime.jar, fakeIp: runtime.fakeIp },
      )
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: `Failed: ${result.body?.message ?? result.status}` }] }
      }
      const lists = result.body?.playlist ?? []
      return {
        content: [
          {
            type: 'text',
            text:
              lists
                .map(
                  (p: any) =>
                    `- ${p.name} (${p.trackCount ?? '?'} tracks${p.subscribed ? ', collected' : ''}) id=${p.id}`,
                )
                .join('\n') || '(no playlists)',
          },
        ],
      }
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
    description: 'Songs uploaded to the personal cloud music library.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'user_cloud',
    requiresLogin: true,
  },
  {
    name: 'ncm_download_list',
    toolset: 'library',
    title: 'Download list',
    description: 'Songs in the account download list.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'song_downlist',
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

const commentTools: ToolDef[] = [
  {
    name: 'ncm_comments',
    toolset: 'comments',
    title: 'Read comments',
    description: 'Comments of a song, album, playlist, MV, radio programme or video.',
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
        { id: args.id, ...(args.before ? { before: args.before } : {}), ...(args.limit ? { limit: args.limit } : {}) },
        { jar: runtime.jar, fakeIp: runtime.fakeIp },
      )
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text', text: `Failed: ${result.body?.message ?? result.status}` }] }
      }
      const comments = (result.body?.comments ?? []).map(slimComment)
      const total = result.body?.total
      const header = `${total ?? comments.length} comments${result.body?.more ? ' (more available)' : ''}`
      const body = comments
        .map(
          (c: any) =>
            `[${c.likedCount} likes] ${c.user?.nickname ?? 'anon'}: ${c.content}${
              c.replies?.length ? `\n    ↳ ${c.replies.length} replies` : ''
            }`,
        )
        .join('\n')
      return { content: [{ type: 'text', text: `${header}\n${body}` }] }
    },
  },
  {
    name: 'ncm_comment_hot',
    toolset: 'comments',
    title: 'Hot comments',
    description: 'Top-liked comments for a song.',
    input: z.object({ id: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'comment_hot',
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
    description: 'Artists the account has subscribed to.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'artist_sublist',
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
    description: 'Recent private message conversations.',
    input: z.object({ ...paging }),
    annotations: READ_ONLY,
    endpoint: 'msg_private',
    requiresLogin: true,
  },
  {
    name: 'ncm_user_events',
    toolset: 'social',
    title: 'User activity feed',
    description: 'Recent activity (shares, posts, follows) of a user.',
    input: z.object({
      uid: z.union([z.string(), z.number()]),
      limit: z.number().int().min(1).max(100).optional(),
      lasttime: z.union([z.string(), z.number()]).optional(),
    }),
    annotations: READ_ONLY,
    endpoint: 'user_event',
  },
  {
    name: 'ncm_similar_users',
    toolset: 'social',
    title: 'Similar users',
    description: 'Users with similar taste.',
    input: z.object({ id: z.union([z.string(), z.number()]), ...paging }),
    annotations: READ_ONLY,
    endpoint: 'simi_user',
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
    description: 'Programme list and metadata for a radio station.',
    input: z.object({ rid: z.union([z.string(), z.number()]) }),
    annotations: READ_ONLY,
    endpoint: 'dj_detail',
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
      'ncm_raw for something the curated tools do not cover.',
    input: z.object({
      filter: z.string().optional().describe('Only return endpoint names containing this substring'),
    }),
    annotations: READ_ONLY,
    run: async (args) => {
      const { listEndpointNames } = await import('@/lib/ncm/modules')
      const all = listEndpointNames()
      const filtered = args.filter
        ? all.filter((name) => name.toLowerCase().includes(String(args.filter).toLowerCase()))
        : all
      return {
        content: [
          {
            type: 'text',
            text: `${filtered.length} of ${all.length} endpoints:\n${filtered.join(', ')}`,
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
      'are always allowed; write endpoints additionally need the ncm:write scope.',
    input: z.object({
      endpoint: z.string().min(1).describe('Endpoint name, from ncm_list_endpoints'),
      params: z.record(z.string(), z.any()).optional().describe('Parameters passed straight through'),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (args, runtime) => {
      const { hasEndpoint } = await import('@/lib/ncm/modules')
      if (!hasEndpoint(args.endpoint)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown endpoint "${args.endpoint}". Try ncm_list_endpoints.` }],
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
      const result = await callNcm(args.endpoint, args.params ?? {}, {
        jar: runtime.jar,
        fakeIp: runtime.fakeIp,
      })
      const text = toToolText(trimGeneric(result.body), 16000)
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
