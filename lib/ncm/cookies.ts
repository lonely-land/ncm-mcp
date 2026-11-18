/**
 * NetEase hands back a `Set-Cookie` array on every response. The parts we need to keep
 * a session alive are few, and keeping the jar small matters because the whole jar
 * travels inside the access token.
 */

const KEEP = new Set([
  'MUSIC_U',
  'MUSIC_A',
  'MUSIC_A_T',
  'MUSIC_R_T',
  'MUSIC_SNS',
  '__csrf',
  'NMTID',
  'deviceId',
  'sDeviceId',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
])

export type CookieJar = Record<string, string>

export function parseSetCookie(setCookies: string[] | undefined): CookieJar {
  const jar: CookieJar = {}
  if (!setCookies) return jar
  for (const raw of setCookies) {
    const pair = raw.split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name || !KEEP.has(name)) continue
    jar[name] = value
  }
  return jar
}

export function parseCookieString(cookie: string | undefined): CookieJar {
  const jar: CookieJar = {}
  if (!cookie) return jar
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    // Only forward the cookies NetEase actually authenticates with; this also drops
    // cookie attributes that leak in when a raw Set-Cookie string is passed through.
    if (name && KEEP.has(name)) jar[name] = value
  }
  return jar
}

export function mergeJar(base: CookieJar | undefined, update: CookieJar): CookieJar {
  return { ...(base ?? {}), ...update }
}

export function jarToString(jar: CookieJar): string {
  return Object.entries(jar)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * A guest jar carries `MUSIC_A` but no `MUSIC_U`. It can read public data and play
 * previews, which is enough to bind a session to a token, but not enough for the
 * tools marked `requiresLogin`.
 */
export function hasSession(jar: CookieJar | undefined): boolean {
  return Boolean(jar?.MUSIC_U || jar?.MUSIC_A)
}
