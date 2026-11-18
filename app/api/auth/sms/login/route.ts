import { fakeIpFor } from '@/lib/ncm/client'
import { jarToString } from '@/lib/ncm/cookies'
import { loginWithCaptcha } from '@/lib/ncm/login'
import { jsonResponse } from '@/lib/oauth/server'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  let body: { phone?: string; captcha?: string; countrycode?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse({ ok: false, message: 'Body must be JSON' }, 400)
  }

  const phone = (body.phone ?? '').trim()
  const captcha = (body.captcha ?? '').trim()
  if (!phone || !captcha) {
    return jsonResponse({ ok: false, message: 'Phone number and verification code are required' }, 400)
  }

  const outcome = await loginWithCaptcha(
    phone,
    captcha,
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
