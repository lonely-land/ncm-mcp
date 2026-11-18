import { jsonResponse, protectedResourceMetadata } from '@/lib/oauth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * RFC 9728 permits path-less discovery at the origin root. Most clients use the
 * per-resource document, but a few probe this first.
 */
export function GET(): Response {
  return jsonResponse(protectedResourceMetadata())
}
