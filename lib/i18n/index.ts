import { headers } from 'next/headers'

import { DEFAULT_LOCALE, type Locale, LOCALES, type Messages, messagesFor } from './messages'

export { DEFAULT_LOCALE, LOCALES, format, messagesFor } from './messages'
export type { Locale, Messages, OAuthMessageKey } from './messages'

export const LOCALE_COOKIE = 'ncm_locale'

/** Best match for one tag: exact, then base language (`zh-Hans` → `zh-CN`). */
function matchTag(tag: string): Locale | undefined {
  const lower = tag.toLowerCase()
  const exact = LOCALES.find((locale) => locale.toLowerCase() === lower)
  if (exact) return exact
  const base = lower.split('-')[0]
  return LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === base)
}

/**
 * Parse an `Accept-Language` header into ordered tags, honouring q-values.
 * `zh-TW` still resolves to `zh-CN` because it is the only Chinese variant we ship.
 */
export function preferredLocales(acceptLanguage: string | null | undefined): Locale[] {
  if (!acceptLanguage) return []
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.find((param) => param.trim().startsWith('q='))
      const q = qParam ? Number.parseFloat(qParam.split('=')[1]) : 1
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index }
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)

  const out: Locale[] = []
  for (const entry of ranked) {
    const locale = matchTag(entry.tag)
    if (locale && !out.includes(locale)) out.push(locale)
  }
  return out
}

/**
 * Pick a locale from an explicit override, a stored preference, then
 * `Accept-Language`, falling back to English.
 */
export function resolveLocale(input: {
  acceptLanguage?: string | null
  cookie?: string | null
}): Locale {
  const stored = input.cookie?.trim()
  if (stored) {
    const match = matchTag(stored)
    if (match) return match
  }
  return preferredLocales(input.acceptLanguage)[0] ?? DEFAULT_LOCALE
}

/** Locale for the current server component request. */
export async function getLocale(): Promise<Locale> {
  const store = await headers()
  return resolveLocale({
    acceptLanguage: store.get('accept-language'),
    cookie: readCookie(store.get('cookie'), LOCALE_COOKIE),
  })
}

/** Locale plus its dictionary for the current server component request. */
export async function getMessages(): Promise<{ locale: Locale; messages: Messages }> {
  const locale = await getLocale()
  return { locale, messages: messagesFor(locale) }
}

/** Same resolution for route handlers, which own their `Request`. */
export function localeFromRequest(request: Request): Locale {
  return resolveLocale({
    acceptLanguage: request.headers.get('accept-language'),
    cookie: readCookie(request.headers.get('cookie'), LOCALE_COOKIE),
  })
}

/** Messages for a route handler request. */
export function messagesFromRequest(request: Request): Messages {
  return messagesFor(localeFromRequest(request))
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}
