import { fakeIpFor } from '@/lib/ncm/client'
import { jsonResponse } from '@/lib/oauth/server'
import { startQrLogin } from '@/lib/ncm/login'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  try {
    const result = await startQrLogin(fakeIpFor(request))
    return jsonResponse(result)
  } catch (error) {
    // Returning the reason beats an opaque 500: the usual cause is a deployment that
    // did not ship the NetEase dependencies, which the message names directly.
    console.error('[qr/create] failed:', error)
    return jsonResponse(
      {
        ok: false,
        message:
          error instanceof Error
            ? `Could not create a QR code: ${error.message}`
            : 'Could not create a QR code',
      },
      502,
    )
  }
}
