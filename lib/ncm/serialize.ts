/**
 * NetEase payloads are verbose: every list of songs arrives with `privileges`, cover
 * metadata, `rtUrls` and similar noise. Trimming keeps tool results inside a sane
 * context budget while staying lossless for the fields an assistant actually uses.
 *
 * Size control happens in three layers, all of them structural:
 *
 * 1. `trimGeneric` drops heavy keys, projects repeated user objects and caps arrays.
 * 2. `capTextFields` shortens individual long strings.
 * 3. `toStructuredText` / `enforceCeiling` keep the *whole result* under a character
 *    ceiling by dropping complete array items and appending a notice that names the
 *    array, counts what went missing and says how to fetch the rest. A result is
 *    therefore always valid JSON (when JSON was returned) or valid plain text.
 */

type Json = any

const HEAVY_KEYS = new Set([
  'privileges',
  'rtUrls',
  'rtUrl',
  'crbt',
  'cf',
  'h',
  'm',
  'l',
  'sq',
  'hr',
  'mm',
  'noCopyrightRcmd',
  'fee',
  'mv',
  'v',
  'st',
  'pst',
  't',
  'rt',
  'cd',
  'popularity',
  'a',
  'f',
  'r',
  'type',
  'canExtendPrivilege',
  'downloadMaxBrLevel',
  'playMaxBrLevel',
  'downloadMaxBr',
  'playMaxBr',
  'flLevel',
  'plLevel',
  'dlLevel',
  'maxBrLevel',
  'freeTrialPrivilege',
  'chargeInfoList',
  'freeTrialInfo',
  'level',
  'encodeType',
  'time',
  'size',
  'md5',
  'sr',
  'gain',
  'peak',
  'fee',
  'payed',
  'flag',
  'copyrightId',
  'albumId',
  'artistIds',
  'transNames',
  'alg',
  'lrclink',
  'unsername',
])

/** Keys dropped even though they read as small, because they are repeated per item. */
const ALWAYS_DROP = new Set(['privileges', 'rtUrls', 'chargeInfoList'])

/** Keys that hold a NetEase user object. They repeat once per list item, so a full
 * 27-key profile (≈1 KB) times a hundred playlists is most of the response. Only the
 * identity fields survive; anything a caller needs beyond that comes from
 * `ncm_user_detail`, which returns the full profile on purpose. */
const USER_OBJECT_KEYS = new Set([
  'creator',
  'user',
  'uploader',
  'dj',
  'host',
  'mainCreator',
  'shareUser',
  'purchasedUser',
  'lastPlayUser',
  'creatorUser',
])

/** Arrays whose entries are user objects: `subscribers`, `follow`, `followeds`, ... */
const USER_ARRAY_KEYS = new Set([
  'subscribers',
  'subscribedUsers',
  'follow',
  'followeds',
  'users',
  'userProfiles',
  'commentUserList',
  'similarUsers',
])

export interface UserProjection {
  userId: number | string
  nickname: string
  avatarUrl?: string
}

/**
 * Collapse a nested user object to `{userId, nickname, avatarUrl?}`. Returns
 * undefined when the object is not user-shaped, so unrelated objects (a song has
 * `id` + `name`, not `nickname`) keep their normal treatment.
 */
export function projectUser(value: Json): UserProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const userId = value.userId ?? value.id
  const nickname = value.nickname ?? (value.userId !== undefined ? value.name : undefined)
  if (typeof userId !== 'number' && typeof userId !== 'string') return undefined
  if (typeof nickname !== 'string') return undefined
  return {
    userId,
    nickname,
    // Cover art URLs are short and the one profile field a list view needs.
    ...(typeof value.avatarUrl === 'string' && value.avatarUrl.length <= 200
      ? { avatarUrl: value.avatarUrl }
      : {}),
  }
}

function normalizeArtist(artist: Json): Json {
  if (!artist || typeof artist !== 'object') return artist
  return {
    id: artist.id,
    name: artist.name,
    ...(artist.alias?.length ? { alias: artist.alias } : {}),
    ...(artist.trans ? { trans: artist.trans } : {}),
  }
}

function normalizeAlbum(album: Json): Json {
  if (!album || typeof album !== 'object') return album
  return {
    id: album.id,
    name: album.name,
    ...(album.picUrl ? { picUrl: album.picUrl } : {}),
    ...(album.publishTime ? { publishTime: album.publishTime } : {}),
    ...(album.size ? { size: album.size } : {}),
    ...(album.company ? { company: album.company } : {}),
  }
}

export function slimSong(song: Json): Json {
  if (!song || typeof song !== 'object') return song
  const out: Json = {
    id: song.id,
    name: song.name,
  }
  if (song.alias?.length) out.alias = song.alias
  if (song.transNames?.length) out.transNames = song.transNames
  const artists = song.ar ?? song.artists
  if (Array.isArray(artists)) out.artists = artists.map(normalizeArtist)
  const album = song.al ?? song.album
  if (album) out.album = normalizeAlbum(album)
  if (song.dt ?? song.duration) out.durationMs = song.dt ?? song.duration
  if (song.publishTime) out.publishTime = song.publishTime
  if (typeof song.fee === 'number') out.fee = song.fee
  if (typeof song.mv === 'number' && song.mv > 0) out.mvId = song.mv
  if (song.pop !== undefined) out.popularity = song.pop
  return out
}

export function slimPlaylist(playlist: Json): Json {
  if (!playlist || typeof playlist !== 'object') return playlist
  return {
    id: playlist.id,
    name: playlist.name,
    ...(playlist.coverImgUrl ? { coverImgUrl: playlist.coverImgUrl } : {}),
    ...(playlist.trackCount !== undefined ? { trackCount: playlist.trackCount } : {}),
    ...(playlist.playCount !== undefined ? { playCount: playlist.playCount } : {}),
    ...(playlist.subscribedCount !== undefined ? { subscribedCount: playlist.subscribedCount } : {}),
    ...(playlist.creator ? { creator: { id: playlist.creator.userId, name: playlist.creator.nickname } } : {}),
    ...(playlist.description ? { description: trimText(playlist.description, 400) } : {}),
    ...(playlist.tags?.length ? { tags: playlist.tags } : {}),
    ...(playlist.createTime ? { createTime: playlist.createTime } : {}),
    ...(Array.isArray(playlist.tracks) && playlist.tracks.length
      ? { tracks: playlist.tracks.map(slimSong) }
      : {}),
  }
}

/**
 * Full user profile, used by the account tools a caller explicitly asks for. This is
 * deliberately not projected: `ncm_user_detail` is the escape hatch for profile data.
 */
export function slimUser(user: Json): Json {
  if (!user || typeof user !== 'object') return user
  return {
    userId: user.userId ?? user.id,
    nickname: user.nickname ?? user.name,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.signature ? { signature: trimText(user.signature, 200) } : {}),
    ...(user.vipType !== undefined ? { vipType: user.vipType } : {}),
    ...(user.followed !== undefined ? { followed: user.followed } : {}),
    ...(user.followeds !== undefined ? { followeds: user.followeds } : {}),
    ...(user.follows !== undefined ? { follows: user.follows } : {}),
    ...(user.playlistCount !== undefined ? { playlistCount: user.playlistCount } : {}),
    ...(user.level !== undefined ? { level: user.level } : {}),
  }
}

export function slimComment(comment: Json): Json {
  if (!comment || typeof comment !== 'object') return comment
  return {
    id: comment.commentId ?? comment.id,
    content: trimText(comment.content ?? '', 1000),
    likedCount: comment.likedCount,
    time: comment.time,
    ...(comment.user ? { user: slimUser(comment.user) } : {}),
    ...(comment.beReplied?.length
      ? { replies: comment.beReplied.map((reply: Json) => slimComment(reply)) }
      : {}),
  }
}

export function trimText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Ceilings for free-form text that arrives in bulk (lyrics, bios, descriptions).
 * A single call must never be able to spend the whole context window on one field,
 * so anything longer is cut and says so.
 */
export const TEXT_LIMITS = {
  /** Lyrics bodies (plain, translated, romanised, LRC). */
  lyrics: 4000,
  /** Lyrics marks / highlight blobs. */
  lyricMark: 1200,
  /** Descriptions, signatures, bios. */
  description: 600,
  /** Any other long string in a generic payload. */
  field: 1200,
  /** Default ceiling on one whole tool result (JSON or rendered text). */
  result: 12000,
  /** Ceiling for the raw escape hatch, which asks for unsimplified bodies. */
  raw: 16000,
} as const

/** Hard bound: no tool may declare a result ceiling above this. */
export const MAX_TOOL_TEXT = TEXT_LIMITS.raw

/** Hard bound on the per-call `maxChars` input, so one field cannot flood a result. */
export const MAX_TEXT_FIELD_CHARS = 5000

/** Keeps a caller-supplied ceiling sane: positive, and never above the hard bound. */
export function clampTextLimit(
  value: unknown,
  fallback: number,
  max = MAX_TEXT_FIELD_CHARS,
): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(max, Math.max(200, numeric))
}

/** Cut `text` at `max` characters and append a marker naming what was dropped. */
export function capText(text: string, max: number = TEXT_LIMITS.field): string {
  if (typeof text !== 'string') return text
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated field: ${text.length - max} of ${text.length} characters dropped; request a smaller slice or use paging]`
}

/**
 * Cap every string in a nested payload and note each truncation in place, so a
 * verbose field cannot dominate a JSON result. Depth is unbounded on purpose: the old
 * depth-6 cutoff left deep strings completely uncapped, which is how a 50 KB field
 * survived a 100-character cap.
 */
export function capTextFields(value: Json, max: number = TEXT_LIMITS.field, depth = 0): Json {
  if (typeof value === 'string') return capText(value, max)
  if (Array.isArray(value)) return value.map((entry) => capTextFields(entry, max, depth + 1))
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, entry] of Object.entries(value)) out[key] = capTextFields(entry, max, depth + 1)
    return out
  }
  return value
}

/** One array that `trimGeneric` shortened, so the caller can say what it did. */
export interface TrimNote {
  /** Dot path of the array in the body. */
  path: string
  kept: number
  dropped: number
  total: number
}

/**
 * Generic deep trim for endpoints that have no dedicated normalizer: removes the heavy
 * key set at any depth, projects nested user objects and caps arrays so a search page
 * cannot blow the budget.
 *
 * Shortened arrays keep their real element type — no marker string is injected — and
 * the drop is reported through `notes` instead, so item counts stay honest.
 */
export function trimGeneric(
  value: Json,
  depth = 0,
  maxArray = 100,
  notes: TrimNote[] = [],
  path = '',
): Json {
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray).map((entry, index) =>
      trimGeneric(entry, depth + 1, maxArray, notes, `${path}[${index}]`),
    )
    if (value.length > maxArray) {
      notes.push({ path, kept: kept.length, dropped: value.length - maxArray, total: value.length })
    }
    return kept
  }
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, entry] of Object.entries(value)) {
      if (ALWAYS_DROP.has(key) || HEAVY_KEYS.has(key)) continue
      if (entry === null || entry === undefined) continue
      const childPath = path ? `${path}.${key}` : key
      if (USER_OBJECT_KEYS.has(key)) {
        const projected = projectUser(entry)
        if (projected) {
          out[key] = projected
          continue
        }
      }
      if (Array.isArray(entry) && USER_ARRAY_KEYS.has(key) && entry.length > 0) {
        // A list of users is projected entry by entry; a non-user entry keeps its
        // normal trim so an unexpected shape is not silently emptied.
        const projected = entry.map((item) => projectUser(item) ?? trimGeneric(item, depth + 2, maxArray, notes, childPath))
        out[key] = projected.every((item) => item && typeof item === 'object' && 'userId' in item)
          ? projected.slice(0, maxArray)
          : projected
        continue
      }
      if (typeof entry === 'string' && entry.length > TEXT_LIMITS.field) {
        out[key] = capText(entry, TEXT_LIMITS.field)
        continue
      }
      out[key] = trimGeneric(entry, depth + 1, maxArray, notes, childPath)
    }
    return out
  }
  return value
}

/** `trimGeneric`, returning the array-level notes alongside the trimmed body. */
export function trimGenericWithNotes(
  value: Json,
  maxArray = 100,
): { body: Json; notes: TrimNote[] } {
  const notes: TrimNote[] = []
  const body = trimGeneric(value, 0, maxArray, notes, '')
  return { body, notes }
}

// ---------------------------------------------------------------------------
// Structured truncation
// ---------------------------------------------------------------------------

export interface DropRecord {
  /** Dot path of the array that was shortened, e.g. "playlists". */
  path: string
  /** Noun for the dropped items, e.g. "playlists". */
  unit: string
  /** How many items of that array the result still carries. */
  kept: number
  /** How many items were dropped from the tail. */
  dropped: number
  /** How many items the array held before truncation. */
  total: number
  /** The page size this array carried before truncation. */
  pageSize: number
}

/**
 * The paging parameters a tool actually exposes, so a hint never names one the caller
 * cannot pass. Curated paged tools take `page`/`pageSize`; the raw escape hatch takes
 * `limit`/`offset`. Hardcoding either wording told `ncm_raw` callers to re-request with
 * a `pageSize` argument that tool does not have.
 */
export interface WindowVocab {
  /** Item-count parameter name, e.g. "pageSize" or "limit". */
  size: string
  /** Zero-based start parameter name, e.g. "offset". Omit for tools without one. */
  start?: string
  /** Page-number parameter name, e.g. "page". Omit for tools without one. */
  page?: string
}

export const PAGE_WINDOW_VOCAB: WindowVocab = { size: 'pageSize', page: 'page' }
export const RAW_WINDOW_VOCAB: WindowVocab = { size: 'limit', start: 'offset' }

export interface TruncationOptions {
  /** Ceiling on the returned text, in characters. */
  limit: number
  /** Noun for a dropped array when its key alone is not descriptive. */
  unit?: string
  /** Overrides the "what to do next" sentence for a dropped array. */
  hint?: (record: DropRecord) => string
  /** Paging footer to preserve verbatim at the end of a rendered result. */
  keepTail?: string
  /** Arrays `trimGeneric` shortened before serialization; reported in the notice. */
  notes?: TrimNote[]
  /** Parameter vocabulary for hints; defaults to the curated `pageSize`/`page` wording. */
  vocab?: WindowVocab
  /**
   * Arrays the caller bounded with the tool's own window parameters. Each entry carries
   * the array's true upstream size, so a shortfall can be stated against the array
   * rather than against the slice that survived — and so `total` in the drop accounting
   * is the upstream size, not the post-window length.
   */
  windows?: WindowReport[]
  /**
   * Dot paths of boolean "more exists" flags to keep honest. When any item is withheld,
   * a flag at one of these paths that reads `false` is corrected to `true`: a truncated
   * payload must never claim it delivered everything.
   */
  correctMore?: string[]
}

export interface WindowReport {
  /** Dot path of the array the caller asked a bounded slice of. */
  path: string
  /** Noun for the items when the path alone is not descriptive. */
  unit?: string
  /** How many items the upstream array held, before the requested window applied. */
  upstreamTotal: number
  /** How many items the requested window actually allowed. */
  delivered: number
}

/** "Re-request with ... to read them", in the tool's own parameter names. */
function reRequest(vocab: WindowVocab, size: number, page?: number): string {
  const pagePart = vocab.page && page !== undefined ? ` and ${vocab.page}=${page}` : ''
  return `re-request with ${vocab.size}<=${size}${pagePart}`
}

/** The re-request sentence with a tool's own parameter names, for custom hints. */
export function reRequestWith(vocab: WindowVocab, size: number, page?: number): string {
  return reRequest(vocab, size, page)
}

/**
 * Hint for a rendered page whose tail was dropped: restart the window at a size the
 * ceiling can hold, beginning at or before `offset` so nothing is skipped. Lives here so
 * every tool names the parameters it actually exposes.
 */
export function restartHint(record: DropRecord, offset: number, vocab: WindowVocab): string {
  const keep = Math.max(1, record.kept)
  const restart = vocab.page ? Math.floor(offset / keep) + 1 : undefined
  return reRequest(vocab, keep, restart)
}

/** "3 playlist" reads as a bug; singular for one, plural otherwise. */
export function pluralize(unit: string, count: number): string {
  if (count === 1) return unit.replace(/s$/, '')
  return /s$/.test(unit) ? unit : `${unit}s`
}

function defaultHint(record: DropRecord, vocab: WindowVocab): string {
  const noun = pluralize(record.unit, record.total)
  return (
    `${record.dropped} ${noun} at the end of this page were not delivered; ` +
    `${reRequest(vocab, Math.max(1, record.kept))} to receive all ${record.total}`
  )
}

/**
 * The page that restarts the same range at a smaller page size. Item `offset` of the
 * collection is the first item of the truncated page, so with `pageSize = kept` it
 * lands at page `floor(offset / kept) + 1`.
 */
function restartPageFor(record: DropRecord, offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 1
  return Math.floor(offset / Math.max(1, record.kept)) + 1
}

function hintFor(record: DropRecord, restartPage: number, vocab: WindowVocab): string {
  const noun = pluralize(record.unit, record.total)
  const where = restartPage > 1 ? `, starting at ${vocab.page ?? 'page'}=${restartPage}` : ''
  return (
    `${record.dropped} of this page's ${record.total} ${noun} were not delivered; ` +
    `${reRequest(vocab, Math.max(1, record.kept), vocab.page ? restartPage : undefined)}${where} to read them`
  )
}

/** Splits a rendered result into its body and a trailing paging footer. */
export function splitPagingFooter(text: string): { body: string; footer: string } {
  const lines = text.split('\n')
  let start = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (/^([^\n]{0,40}: )?paging: /.test(line)) start = index
    else break
  }
  if (start < 0) return { body: text, footer: '' }
  return { body: lines.slice(0, start).join('\n').replace(/\n+$/, ''), footer: lines.slice(start).join('\n') }
}

interface ArraySite {
  /** Path from the document root; `*` walks every element of the preceding array. */
  path: string[]
  /** Nesting depth of the array's owner. */
  depth: number
  /** Longest array at this site. */
  length: number
  /** Total items across every array at this site. */
  total: number
}

interface Handle {
  list: Json[]
  assign: (next: Json[]) => void
}

function collectArraySites(root: Json): ArraySite[] {
  const seen = new Map<string, ArraySite>()
  const record = (path: string[], depth: number, list: Json[]) => {
    const key = path.join('.')
    const existing = seen.get(key)
    if (existing) {
      existing.length = Math.max(existing.length, list.length)
      existing.total += list.length
      return
    }
    seen.set(key, { path, depth, length: list.length, total: list.length })
  }
  const scan = (node: Json, path: string[], depth: number) => {
    if (!node || typeof node !== 'object' || depth > 8) return
    for (const [key, value] of Object.entries(node)) {
      // Paging metadata and our own notice are never the payload.
      if (key === 'paging' || key === 'truncated') continue
      const childPath = [...path, key]
      if (Array.isArray(value)) {
        if (value.length > 1) record(childPath, depth, value)
        for (const entry of value) {
          if (entry && typeof entry === 'object') scan(entry, [...childPath, '*'], depth + 1)
        }
      } else if (value && typeof value === 'object') {
        scan(value, childPath, depth + 1)
      }
    }
  }
  if (Array.isArray(root)) record(['*'], 0, root)
  else scan(root, [], 0)
  return [...seen.values()]
}

/** Every array a site path points at, each with a setter for its new contents. */
function resolveHandles(root: Json, path: string[]): Handle[] {
  const handles: Handle[] = []
  const walk = (node: Json, index: number) => {
    if (index >= path.length) return
    if (node === null || node === undefined) return
    const key = path[index]
    if (key === '*') {
      if (!Array.isArray(node)) return
      for (const entry of node) walk(entry, index + 1)
      return
    }
    if (typeof node !== 'object' || Array.isArray(node)) return
    if (index === path.length - 1) {
      if (!Array.isArray(node[key])) return
      const owner = node
      handles.push({
        list: owner[key],
        assign: (next) => {
          owner[key] = next
        },
      })
      return
    }
    walk(node[key], index + 1)
  }
  walk(root, 0)
  return handles
}

function setHandles(handles: Handle[], cap: number): void {
  for (const handle of handles) {
    if (handle.list.length > cap) handle.assign(handle.list.slice(0, cap))
  }
}

function maxLength(handles: Handle[]): number {
  return handles.reduce((max, handle) => Math.max(max, handle.list.length), 0)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stringify(value: Json): string {
  return JSON.stringify(value, null, 2)
}

/** The structured notice: which field, how many items, and what to do next. */
function truncationNotice(
  limit: number,
  drops: DropRecord[],
  options: TruncationOptions,
  restartPage: (record: DropRecord) => number,
) {
  const notes = options.notes ?? []
  const vocab = options.vocab ?? PAGE_WINDOW_VOCAB
  return {
    reason: `the full result exceeded ${limit} characters, so whole items were dropped from the tail`,
    ...(drops.length > 0
      ? {
          dropped: drops.map((record) => ({
            field: record.path,
            dropped: record.dropped,
            kept: record.kept,
            total: record.total,
            next: options.hint
              ? options.hint(record)
              : hintFor(record, restartPage(record), vocab),
          })),
        }
      : {}),
    ...(notes.length > 0
      ? {
          shortened: notes.map((note) => ({
            field: note.path,
            dropped: note.dropped,
            kept: note.kept,
            total: note.total,
            next: 'narrow the query, or page through the collection',
          })),
        }
      : {}),
  }
}

/**
 * The window the caller asked for versus what the upstream array actually held.
 *
 * When a caller bounds an array with `limit`, the delivered slice is *supposed* to be
 * smaller than the array — that is the request working, not truncation. Reporting the
 * slice's own length as `total` made `limit=2` on a 65-row endpoint read as "2 of 2",
 * indistinguishable from having received everything. This block states the real
 * upstream size and names the parameters that page through it.
 */
function windowNotice(options: TruncationOptions, deliveredNow?: (path: string) => number | undefined) {
  const reports = options.windows ?? []
  if (reports.length === 0) return undefined
  const vocab = options.vocab ?? PAGE_WINDOW_VOCAB
  const entries = reports.map((report) => {
    // The ceiling may have taken part of this window's tail, so the delivered figure is
    // read back from the body rather than trusted from the pre-ceiling pass.
    const delivered = deliveredNow?.(report.path) ?? report.delivered
    const noun = pluralize(report.unit ?? 'item', report.upstreamTotal)
    const withheld = report.upstreamTotal - delivered
    // The remainder starts right after what was delivered, so the exact call is
    // `limit=withheld` at `offset=delivered`. This is the window talking, not the
    // ceiling, so it names the exact arguments rather than an upper bound.
    const startParam = vocab.start ?? vocab.page ?? 'offset'
    const next =
      withheld > 0
        ? `${delivered} of ${report.upstreamTotal} ${noun} delivered for the requested window; ` +
          `pass ${vocab.size}=${withheld} with ${startParam}=${delivered} to read the remaining ${withheld}`
        : `all ${report.upstreamTotal} ${noun} the endpoint holds were delivered`
    return {
      field: report.path,
      delivered,
      upstreamTotal: report.upstreamTotal,
      withheld,
      next,
    }
  })
  return { window: entries }
}

/**
 * Force every "more exists" flag at `paths` to `true`, because something was withheld.
 * A body that says `more: false` next to a truncated tail is a lie the caller cannot
 * detect, so the flag is corrected rather than left to be misread as completeness.
 */
function correctMoreFlags(body: Json, paths: string[]): { body: Json; corrected: string[] } {
  if (paths.length === 0 || !body || typeof body !== 'object') return { body, corrected: [] }
  const corrected: string[] = []
  let next = body
  for (const path of paths) {
    const keys = path.split('.').filter(Boolean)
    if (keys.length === 0) continue
    const current = readPathLoose(next, keys)
    if (current === undefined || current === null) continue
    next = writePathLoose(next, keys, true)
    corrected.push(path)
  }
  return { body: next, corrected }
}

function readPathLoose(body: Json, keys: string[]): Json {
  let cursor = body
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function writePathLoose(body: Json, keys: string[], value: Json): Json {
  const [head, ...rest] = keys
  const source = body && typeof body === 'object' ? body : {}
  if (rest.length === 0) return { ...source, [head]: value }
  const child = source[head]
  // Only descend through a real object; an absent flag stays absent rather than
  // materialising a whole branch the endpoint never sent.
  if (!child || typeof child !== 'object' || Array.isArray(child)) return body
  return { ...source, [head]: writePathLoose(child, rest, value) }
}

/**
 * Shrink `body` until its pretty-printed JSON fits `limit` by dropping whole items
 * from the tail of arrays.
 *
 * Deeper arrays give way before shallower ones, so a nested `tracks` preview is
 * shortened before the array the caller actually asked for; `paging` is never
 * touched. The result carries a `truncated` object naming each shortened field, how
 * many items went missing and how to fetch the rest, and is always valid JSON.
 */
export function trimJsonToLimit(
  body: Json,
  options: TruncationOptions,
): { text: string; drops: DropRecord[] } {
  const limit = Math.max(400, Math.trunc(options.limit))
  const rootIsArray = Array.isArray(body)
  const container: Json = clone(rootIsArray ? { items: body } : body)
  const prefix = rootIsArray ? ['items'] : []

  const original = stringify(container)
  if (original.length <= limit) return { text: original, drops: [] }

  const sites = collectArraySites(container).map((site) => ({ ...site, path: [...prefix, ...site.path] }))
  // Deepest first, biggest first: nested previews absorb the cut before payloads.
  sites.sort((a, b) => (b.depth === a.depth ? b.length - a.length : b.depth - a.depth))

  const drops: DropRecord[] = []
  const caps: { site: ArraySite; cap: number; record: DropRecord }[] = []

  // Capture the page sizes as published, before any truncation, so `paging` can be
  // corrected against a fixed baseline instead of against its own last output.
  const baseline = new Map<string, { meta: Record<string, unknown>; returned: number; hasMore: boolean }>()
  {
    const paging = container?.paging
    if (paging && typeof paging === 'object') {
      for (const [key, meta] of Object.entries(paging)) {
        if (!meta || typeof meta !== 'object') continue
        const record = meta as Record<string, unknown>
        baseline.set(key, {
          meta: record,
          returned: typeof record.returned === 'number' ? record.returned : 0,
          hasMore: record.hasMore === true,
        })
      }
    }
  }

  const build = () => {
    syncPaging()
    syncRequest()
    const notice = truncationNotice(limit, drops, options, (record) => {
      const key = record.path
      const original = baseline.get(key)
      const offset =
        original && original.meta && typeof original.meta.offset === 'number'
          ? (original.meta.offset as number)
          : 0
      return restartPageFor(record, offset)
    })
    const window = windowNotice(options, (path) => finalLength(path))
    return stringify({
      ...container,
      truncated: window ? { ...notice, ...window } : notice,
    })
  }

  /** Items an array at `path` still carries, after every cap applied so far. */
  const finalLength = (path: string): number | undefined => {
    const list = readPathLoose(container, path.split('.').filter(Boolean))
    return Array.isArray(list) ? list.length : undefined
  }

  /**
   * Keep the `request` echo about what the result actually carries.
   *
   * The window pass records what it delivered, but the ceiling can still drop part of
   * that tail. Leaving `request.returned` at the pre-ceiling number told a caller it had
   * 27 rows in a result holding 7 — the same class of lie as `more: false`.
   */
  const syncRequest = () => {
    const request = container?.request
    if (!request || typeof request !== 'object' || Array.isArray(request)) return
    const report = (options.windows ?? [])[0]
    if (!report) return
    const delivered = finalLength(report.path)
    if (delivered === undefined) return
    const upstreamTotal =
      typeof request.upstreamTotal === 'number' ? request.upstreamTotal : report.upstreamTotal
    request.returned = delivered
    request.upstreamTotal = upstreamTotal
    const withheld = Math.max(0, upstreamTotal - delivered)
    if (withheld > 0) request.withheld = withheld
    else delete request.withheld
    if (withheld > 0) request.more = true
    if (withheld > 0 && typeof container.more === 'boolean') container.more = true
  }

  /** Keep `paging` honest: a dropped tail is no longer part of `returned`. */
  const syncPaging = () => {
    for (const [key, original] of baseline) {
      const site = sites.find((entry) => entry.path.filter((s) => s !== '*').join('.') === key)
      if (!site) continue
      const handles = resolveHandles(container, site.path)
      if (handles.length === 0) continue
      const list = handles[0].list
      const delivered = original.returned > 0 ? Math.min(original.returned, list.length) : list.length
      const dropped = Math.max(0, original.returned - delivered)
      original.meta.returned = delivered
      if (dropped > 0) {
        original.meta.truncated = dropped
        // A dropped tail always means there is more to read.
        original.meta.hasMore = true
      } else if (typeof original.meta.truncated === 'number') {
        delete original.meta.truncated
        original.meta.hasMore = original.hasMore
      }
    }
  }

  for (const site of sites) {
    if (build().length <= limit) break
    const handles = resolveHandles(container, site.path)
    if (handles.length === 0 || maxLength(handles) <= 1) continue

    // Binary-search the largest uniform cap whose document still fits.
    const budget = Math.max(200, limit - 800)
    let low = 0
    let high = maxLength(handles)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const probe = clone(container)
      setHandles(resolveHandles(probe, site.path), mid)
      if (stringify(probe).length <= budget) low = mid
      else high = mid - 1
    }
    // Capping this array to nothing still would not bring the payload under budget,
    // and a shallower array is still available to absorb the cut. Emptying this one
    // would then lose detail for no gain, so leave it for the shallower pass.
    const shallower = sites.some((other) => other.depth < site.depth)
    if (low === 0 && shallower) continue
    if (low >= maxLength(handles)) continue

    const kept = Math.max(0, low)
    const before = maxLength(handles)
    setHandles(handles, kept)
    const key = site.path.filter((segment) => segment !== '*').join('.') || 'items'
    const record: DropRecord = {
      path: key,
      unit: options.unit && sites.length === 1 ? options.unit : (site.path.filter((s) => s !== '*').pop() ?? 'items'),
      kept,
      dropped: site.total - kept * handles.length,
      total: site.total,
      pageSize: before,
    }
    if (record.dropped <= 0) continue
    drops.push(record)
    caps.push({ site, cap: kept, record })
  }

  // The notice itself costs characters: shave the deepest recorded array until the
  // whole document fits, then move outward.
  let output = build()
  let guard = 0
  while (output.length > limit && guard < 80) {
    guard += 1
    const target = [...caps].reverse().find((entry) => entry.cap > 0)
    if (!target) break
    target.cap -= 1
    setHandles(resolveHandles(container, target.site.path), target.cap)
    const handleCount = Math.max(1, resolveHandles(container, target.site.path).length)
    target.record.kept = target.cap
    target.record.dropped = target.record.total - target.cap * handleCount
    output = build()
  }

  // A withheld tail means the payload is not complete, whatever the endpoint's own
  // `more` flag said before the ceiling was applied. Correcting it here covers the one
  // case a caller cannot detect from the outside: `more: false` beside a short tail.
  if (drops.length > 0 && (options.correctMore?.length ?? 0) > 0) {
    const corrected = correctMoreFlags(container, options.correctMore ?? [])
    if (corrected.corrected.length > 0) {
      Object.assign(container, corrected.body)
      output = build()
    }
  }

  if (output.length > limit) {
    // Nothing array-shaped could absorb the payload: report the size rather than hand
    // back a severed fragment.
    output = stringify({
      truncated: {
        reason: `the result exceeded ${limit} characters and held no list that could be shortened`,
        next: 'request a narrower slice of this resource',
      },
    })
  }
  return { text: output, drops }
}

/** Plain-text ceiling: keeps whole lines and a structured trailing notice. */
export function truncateText(text: string, options: TruncationOptions): string {
  return truncateTextDetailed(text, options).text
}

/** `truncateText`, also reporting how many lines survived and how many were dropped. */
export function truncateTextDetailed(
  text: string,
  options: TruncationOptions,
): { text: string; kept: number; dropped: number } {
  const limit = Math.max(400, Math.trunc(options.limit))
  const { body, footer } = options.keepTail ? { body: text, footer: options.keepTail } : splitPagingFooter(text)
  const tail = footer ? `\n\n${footer}` : ''
  const lines = body.split('\n')
  if (body.length + tail.length <= limit) {
    return { text: `${body}${tail}`, kept: lines.length, dropped: 0 }
  }

  const budget = Math.max(200, limit - tail.length - 260)
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > budget) break
    kept.push(line)
    size += line.length + 1
  }
  if (kept.length === 0) kept.push(body.slice(0, budget))
  const dropped = lines.length - kept.length
  const unit = options.unit ?? 'lines'
  const hint =
    options.hint?.({
      path: '',
      unit,
      kept: kept.length,
      dropped,
      total: lines.length,
      pageSize: lines.length,
    }) ?? 'request a smaller range or fewer items per call'
  const notice = `…[truncated: dropped ${dropped} of ${lines.length} ${unit} (${kept.length} kept, ${body.length - size} characters); ${hint}]`
  return { text: `${kept.join('\n')}\n${notice}${tail}`, kept: kept.length, dropped }
}

/**
 * Trim already-rendered lines to a ceiling, dropping whole items from the tail and
 * naming how many are missing. Returns the kept count so the caller can correct its
 * paging metadata instead of reporting items it did not deliver.
 */
export function truncateLines(
  lines: string[],
  options: TruncationOptions & { unit: string },
): { text: string; kept: number; dropped: number } {
  const limit = Math.max(400, Math.trunc(options.limit))
  const reserve = 260
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > limit - reserve) break
    kept.push(line)
    size += line.length + 1
  }
  if (kept.length === lines.length) {
    return { text: kept.join('\n'), kept: kept.length, dropped: 0 }
  }
  const record: DropRecord = {
    path: options.unit ?? 'items',
    unit: options.unit ?? 'items',
    kept: kept.length,
    dropped: lines.length - kept.length,
    total: lines.length,
    pageSize: lines.length,
  }
  const hint = options.hint?.(record) ?? defaultHint(record, options.vocab ?? PAGE_WINDOW_VOCAB)
  return {
    text: `${kept.join('\n')}\n…[truncated: dropped ${record.dropped} of ${record.total} ${options.unit} (${kept.length} kept); ${hint}]`,
    kept: kept.length,
    dropped: record.dropped,
  }
}

// ---------------------------------------------------------------------------
// One entry point for a tool result's text
// ---------------------------------------------------------------------------

const JSON_START = /^\s*[[{]/

/**
 * Serialize a body for a tool result under a hard ceiling. JSON stays valid JSON
 * (parsed first when a handler hands over a string that looks like JSON); plain text
 * is trimmed on line boundaries. Never returns a fragment `JSON.parse` rejects.
 *
 * A `windows` report is always surfaced, not only when the ceiling bites: a caller who
 * asked `limit=2` of a 65-row endpoint must be able to see "2 of 65" even in a result
 * small enough to need no trimming.
 */
export function toStructuredText(body: Json, options: TruncationOptions): string {
  let parsed: Json = body
  if (typeof body === 'string') {
    if (!JSON_START.test(body)) return truncateText(body, options)
    try {
      parsed = JSON.parse(body)
    } catch {
      return truncateText(body, options)
    }
  }
  const window = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? windowNotice(options) : undefined
  const withWindow = window ? { ...parsed, truncated: { ...(parsed.truncated ?? {}), ...window } } : parsed
  const text = stringify(withWindow)
  if (text.length <= options.limit) return text
  return trimJsonToLimit(withWindow, options).text
}

/** Matches the "items 1-20 of 680" range in a paging footer. */
const FOOTER_RANGE = /items (\d+)-(\d+) of (\d+)/

/**
 * Rewrite a paging footer after items were dropped from the body, so it describes what
 * was actually delivered. A truncated page still starts at the same offset, so the range
 * shrinks, the count drops to the delivered number, and `hasMore` becomes true.
 */
export function adjustFooterForDrops(footer: string, delivered: number, dropped: number): string {
  if (!footer || dropped <= 0) return footer
  return footer
    .split('\n')
    .map((line) => {
      const range = FOOTER_RANGE.exec(line)
      let out = line
      if (range) {
        const start = Number(range[1])
        const end = start - 1 + delivered
        out = out.replace(FOOTER_RANGE, `items ${start}-${end} of ${range[3]}`)
      }
      out = out.replace(/· (\d+) ([a-zA-Z]+) ·/, (_match, _count, noun) => `· ${delivered} ${noun} ·`)
      if (!/hasMore=/.test(out)) return out
      return out.replace(/hasMore=\w+/, 'hasMore=true').replace(/ · next: page=\d+/, '')
    })
    .join('\n')
}

/**
 * Last line of defence, applied to every tool result whatever produced it. Returns
 * the text unchanged when it fits, otherwise re-truncates structurally — JSON stays
 * parseable, plain text keeps whole lines — and preserves the paging footer, corrected
 * to the number of items that actually made it into the result.
 */
export function enforceCeiling(text: string, options: TruncationOptions): string {
  if (typeof text !== 'string') return ''
  const { body, footer } = splitPagingFooter(text)
  const total = body.length + (footer ? footer.length + 2 : 0)
  if (total <= options.limit) return footer ? `${body}\n\n${footer}` : body
  const budget = Math.max(400, options.limit - (footer ? footer.length + 2 : 0))
  if (JSON_START.test(body)) {
    try {
      const parsed = JSON.parse(body)
      const trimmed = toStructuredText(parsed, { ...options, limit: budget })
      return footer ? `${trimmed}\n\n${footer}` : trimmed
    } catch {
      // Not JSON after all; fall through to the line path.
    }
  }
  const kept = truncateTextDetailed(body, { ...options, limit: budget })
  const delivered = kept.kept
  const rewritten = footer ? adjustFooterForDrops(footer, delivered, kept.dropped) : ''
  return rewritten ? `${kept.text}\n\n${rewritten}` : kept.text
}

