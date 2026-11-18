/**
 * NetEase payloads are verbose: every list of songs arrives with `privileges`, cover
 * metadata, `rtUrls` and similar noise. Trimming keeps tool results inside a sane
 * context budget while staying lossless for the fields an assistant actually uses.
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
  /** Whole serialised tool result written as JSON. */
  result: 12000,
  /** Raw escape-hatch results. */
  raw: 16000,
} as const

/** Cut `text` at `max` characters and append a marker naming what was dropped. */
export function capText(text: string, max: number = TEXT_LIMITS.field): string {
  if (typeof text !== 'string') return text
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated: ${text.length - max} of ${text.length} characters dropped; request a smaller slice or use paging]`
}

/**
 * Cap every string in a nested payload and note each truncation in place, so a
 * verbose field cannot dominate a JSON result.
 */
export function capTextFields(value: Json, max: number = TEXT_LIMITS.field, depth = 0): Json {
  if (depth > 6) return value
  if (typeof value === 'string') return capText(value, max)
  if (Array.isArray(value)) return value.map((entry) => capTextFields(entry, max, depth + 1))
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, entry] of Object.entries(value)) out[key] = capTextFields(entry, max, depth + 1)
    return out
  }
  return value
}

/**
 * Generic deep trim for endpoints that have no dedicated normalizer: removes the heavy
 * key set at any depth and caps arrays so a search page cannot blow the budget.
 */
export function trimGeneric(value: Json, depth = 0, maxArray = 50): Json {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArray).map((entry) => trimGeneric(entry, depth + 1, maxArray))
    if (value.length > maxArray) sliced.push(`…(${value.length - maxArray} more)`)
    return sliced
  }
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, entry] of Object.entries(value)) {
      if (ALWAYS_DROP.has(key) || HEAVY_KEYS.has(key)) continue
      if (entry === null || entry === undefined) continue
      if (typeof entry === 'string' && entry.length > TEXT_LIMITS.field) {
        out[key] = capText(entry, TEXT_LIMITS.field)
        continue
      }
      out[key] = trimGeneric(entry, depth + 1, maxArray)
    }
    return out
  }
  return value
}

/** Serialize for a tool result with a hard character ceiling. */
export function toToolText(body: Json, limit = 12000): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…truncated (${text.length - limit} chars omitted)`
}

/**
 * Serialize with a ceiling that protects the tail: the final `tailLines` lines
 * (where paging metadata lives) survive truncation, so a huge payload can never
 * hide how to ask for the next page.
 */
export function toToolTextKeepingTail(body: Json, limit = 12000, tailLines = 12): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  if (text.length <= limit) return text
  const tail = text.split('\n').slice(-tailLines).join('\n')
  const budget = Math.max(0, limit - tail.length - 80)
  const head = text.slice(0, budget)
  return `${head}\n…truncated (${text.length - head.length - tail.length} chars omitted; paging metadata below)\n${tail}`
}
