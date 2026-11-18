import { fakeIpFor } from '@/lib/ncm/client'
import { sendCaptcha } from '@/lib/ncm/login'
import { jsonResponse } from '@/lib/oauth/server'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  let body: { phone?: string; countrycode?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse({ ok: false, message: 'Body must be JSON' }, 400)
  }

  const phone = (body.phone ?? '').trim()
  if (!phone) return jsonResponse({ ok: false, message: 'Phone number is required' }, 400)

  const result = await sendCaptcha(phone, (body.countrycode ?? '86').trim(), fakeIpFor(request))
  return jsonResponse(result)
}
