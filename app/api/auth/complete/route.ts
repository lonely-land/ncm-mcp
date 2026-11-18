import { cookies } from 'next/headers'

import { parseCookieString, hasSession } from '@/lib/ncm/cookies'
import { messagesFromRequest } from '@/lib/i18n'
import { jsonResponse } from '@/lib/oauth/server'
import { AUTHZ_COOKIE, finishAuthorization, readAuthzCookie } from '@/lib/oauth/authorize-flow'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface Body {
  jar?: string
  userId?: number
  nickname?: string
}

/**
 * Final step shared by all three login flows. It mints the authorization code from the
 * sealed authz cookie and hands back the redirect the browser must follow, so the
 * client's `redirect_uri` is never taken from user-controlled input here.
 */
export async function POST(request: Request): Promise<Response> {
  const text = messagesFromRequest(request).api
  if (!isSameOrigin(request)) return crossOriginRejection(text.crossOrigin)
  const authz = await readAuthzCookie()
  if (!authz) {
    return jsonResponse({ ok: false, message: text.sessionExpired }, 400)
  }

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return jsonResponse({ ok: false, message: text.bodyMustBeJson }, 400)
  }

  const jar = parseCookieString(body.jar)
  if (!hasSession(jar)) {
    return jsonResponse({ ok: false, message: text.noSessionCookie }, 400)
  }

  const { redirectUrl } = await finishAuthorization(authz, {
    jar,
    userId: body.userId,
    nickname: body.nickname,
  })

  const store = await cookies()
  store.delete(AUTHZ_COOKIE)

  return jsonResponse({ ok: true, redirect: redirectUrl })
}
