import { fakeIpFor } from '@/lib/ncm/client'
import { jarToString } from '@/lib/ncm/cookies'
import { jsonResponse } from '@/lib/oauth/server'
import { pollQr } from '@/lib/ncm/login'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  let key = ''
  try {
    const body = (await request.json()) as { key?: string }
    key = typeof body.key === 'string' ? body.key : ''
  } catch {
    return jsonResponse({ ok: false, message: 'Body must be JSON' }, 400)
  }
  if (!key) return jsonResponse({ ok: false, message: 'key is required' }, 400)

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
            ? `Could not check the QR status: ${error.message}`
            : 'Could not check the QR status',
      },
      502,
    )
  }
}
