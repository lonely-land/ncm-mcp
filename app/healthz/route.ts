import pkg from '../../package.json'
import { jsonResponse } from '@/lib/oauth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Unauthenticated liveness probe. It deliberately touches nothing but the process:
 * no NetEase cookies, no upstream calls, no token secret, so it stays green while
 * the upstream API is down or misconfigured.
 */
export function GET(): Response {
  return jsonResponse(
    {
      status: 'ok',
      uptime: Number(process.uptime().toFixed(3)),
      version: pkg.version,
    },
    200,
    { 'cache-control': 'no-store, max-age=0' },
  )
}
