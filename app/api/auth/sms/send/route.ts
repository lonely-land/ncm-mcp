import { fakeIpFor } from '@/lib/ncm/client'
import { sendCaptcha } from '@/lib/ncm/login'
import { messagesFromRequest } from '@/lib/i18n'
import { jsonResponse } from '@/lib/oauth/server'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  const text = messagesFromRequest(request).api
  if (!isSameOrigin(request)) return crossOriginRejection(text.crossOrigin)
  let body: { phone?: string; countrycode?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse({ ok: false, message: text.bodyMustBeJson }, 400)
  }

  const phone = (body.phone ?? '').trim()
  if (!phone) return jsonResponse({ ok: false, message: text.phoneRequired }, 400)

  const result = await sendCaptcha(phone, (body.countrycode ?? '86').trim(), fakeIpFor(request))
  return jsonResponse(result)
}
