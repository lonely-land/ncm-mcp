import { fakeIpFor } from '@/lib/ncm/client'
import { jarToString } from '@/lib/ncm/cookies'
import { format, messagesFromRequest } from '@/lib/i18n'
import { jsonResponse } from '@/lib/oauth/server'
import { pollQr } from '@/lib/ncm/login'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  const text = messagesFromRequest(request).api
  if (!isSameOrigin(request)) return crossOriginRejection(text.crossOrigin)
  let key = ''
  try {
    const body = (await request.json()) as { key?: string }
    key = typeof body.key === 'string' ? body.key : ''
  } catch {
    return jsonResponse({ ok: false, message: text.bodyMustBeJson }, 400)
  }
  if (!key) return jsonResponse({ ok: false, message: text.keyRequired }, 400)

  try {
    const result = await pollQr(key, fakeIpFor(request))
    if (result.outcome?.ok && result.outcome.jar) {
      // The jar crosses to /api/auth/complete in the body; it is never written to a
      // cookie so it cannot leak through a shared browser profile.
      return jsonResponse({
        ok: true,
        status: result.status,
        jar: jarToString(result.outcome.jar),
        userId: result.outcome.userId,
        nickname: result.outcome.nickname,
        message: result.message,
      })
    }
    return jsonResponse({ ok: false, status: result.status, message: result.message })
  } catch (error) {
    console.error('[qr/poll] failed:', error)
    return jsonResponse(
      {
        ok: false,
        status: 502,
        message:
          error instanceof Error
            ? format(text.qrStatusFailed, { detail: error.message })
            : text.qrStatusFailedShort,
      },
      502,
    )
  }
}
