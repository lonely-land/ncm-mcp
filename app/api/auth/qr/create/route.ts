import { fakeIpFor } from '@/lib/ncm/client'
import { jsonResponse } from '@/lib/oauth/server'
import { startQrLogin } from '@/lib/ncm/login'
import { crossOriginRejection, isSameOrigin } from '@/lib/oauth/same-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return crossOriginRejection()
  const result = await startQrLogin(fakeIpFor(request))
  return jsonResponse(result)
}
