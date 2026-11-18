import { bootstrapNcm, resolveFakeIp } from '@/lib/ncm/bootstrap'
import { type CookieJar, jarToString, parseSetCookie, mergeJar } from '@/lib/ncm/cookies'
import { ncmApi, type NcmResponse } from '@/lib/ncm/modules'

export interface NcmCallContext {
  jar?: CookieJar
  fakeIp?: string
}

export interface NcmCallResult {
  ok: boolean
  status: number
  body: any
  /** Cookies the upstream refreshed during this call, if any. */
  jar?: CookieJar
}

/**
 * One NetEase call. Errors come back as values: the package throws `{status, body}` for
 * non-200 upstreams, which is a normal outcome for e.g. a private playlist.
 */
export async function callNcm(
  endpoint: string,
  params: Record<string, unknown>,
  context: NcmCallContext = {},
): Promise<NcmCallResult> {
  const api = ncmApi()
  const fn = api[endpoint]
  if (typeof fn !== 'function') {
    return {
      ok: false,
      status: 404,
      body: { code: 404, message: `Unknown NetEase endpoint: ${endpoint}` },
    }
  }

  await bootstrapNcm()

  const query: Record<string, unknown> = {
    ...params,
    cookie: jarToString(context.jar ?? {}),
  }
  if (context.fakeIp) query.realIP = context.fakeIp

  try {
    const response = (await fn(query)) as NcmResponse
    const refreshed = parseSetCookie(response.cookie)
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body: response.body,
      jar: Object.keys(refreshed).length > 0 ? refreshed : undefined,
    }
  } catch (error) {
    const thrown = error as Partial<NcmResponse> & { message?: string }
    if (typeof thrown.status === 'number') {
      const refreshed = parseSetCookie(thrown.cookie)
      return {
        ok: false,
        status: thrown.status,
        body: thrown.body ?? { code: thrown.status, message: thrown.message ?? 'Upstream error' },
        jar: Object.keys(refreshed).length > 0 ? refreshed : undefined,
      }
    }
    return {
      ok: false,
      status: 502,
      body: {
        code: 502,
        message: thrown?.message ? String(thrown.message) : 'Upstream request failed',
      },
    }
  }
}

/** Same as {@link callNcm} but throws on failure, for the login routes. */
export async function callNcmStrict(
  endpoint: string,
  params: Record<string, unknown>,
  context: NcmCallContext = {},
): Promise<{ body: any; jar: CookieJar }> {
  const result = await callNcm(endpoint, params, context)
  if (!result.ok) {
    const message = result.body?.message ?? result.body?.msg ?? 'NetEase request failed'
    throw new Error(`${endpoint}: ${message}`)
  }
  return { body: result.body, jar: context.jar ? mergeJar(context.jar, result.jar ?? {}) : (result.jar ?? {}) }
}

export function fakeIpFor(request: Request): string | undefined {
  return resolveFakeIp(request)
}
