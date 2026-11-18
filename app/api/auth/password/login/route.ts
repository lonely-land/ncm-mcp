import { fakeIpFor } from '@/lib/ncm/client'
import { jarToString } from '@/lib/ncm/cookies'
import { loginWithPassword } from '@/lib/ncm/login'
import { jsonResponse } from '@/lib/oauth/server'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  let body: { account?: string; password?: string; countrycode?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse({ ok: false, message: 'Body must be JSON' }, 400)
  }

  const account = (body.account ?? '').trim()
  const password = body.password ?? ''
  if (!account || !password) {
    return jsonResponse({ ok: false, message: 'Account and password are required' }, 400)
  }

  const outcome = await loginWithPassword(
    account,
    password,
    (body.countrycode ?? '86').trim(),
    fakeIpFor(request),
  )

  if (!outcome.ok || !outcome.jar) {
    return jsonResponse({ ok: false, message: outcome.message }, 400)
  }

  return jsonResponse({
    ok: true,
    jar: jarToString(outcome.jar),
    userId: outcome.userId,
    nickname: outcome.nickname,
  })
}
