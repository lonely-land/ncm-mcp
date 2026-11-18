import { publicOrigin } from '@/lib/config'

/**
 * The login API routes are called by our own page with `credentials: same-origin`.
 * Rejecting cross-site calls keeps another origin from driving someone's in-progress
 * login (and thus harvesting the resulting authorization code).
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) {
    // Non-browser callers (curl, tests) send no Origin; allow those.
    return true
  }
  try {
    return new URL(origin).origin === new URL(publicOrigin()).origin
  } catch {
    return false
  }
}

export function crossOriginRejection(): Response {
  return new Response(
    JSON.stringify({ ok: false, message: 'Cross-origin requests are not allowed' }),
    { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}
