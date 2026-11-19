import { callNcm } from '@/lib/ncm/client'
import type { CookieJar } from '@/lib/ncm/cookies'
import { resolveUid, type OwnUidResult } from '@/lib/ncm/uid'

/**
 * Resolving the current account id for the MCP tool layer.
 *
 * `lib/ncm/uid.ts` holds the resolution order; this module adds the transport (upstream
 * `user_account`) and the request-lifetime cache.
 */

/** The slice of the tool runtime uid resolution needs. The object itself is the cache key. */
export interface OwnUidContext {
  jar: CookieJar
  fakeIp?: string
  userId?: number
}

export type { OwnUidResult }

/**
 * Cached per runtime object. A runtime is built once per MCP HTTP request and handed to
 * every tool call in it, so a WeakMap keyed by that object gives request-lifetime reuse
 * without a module-level slot that could leak one account's id into another's request,
 * and without retaining anything after the request is collected.
 */
const resolved = new WeakMap<OwnUidContext, Promise<OwnUidResult>>()

/**
 * The NetEase user id behind this session, from the token when it has one and from the
 * upstream session otherwise. Pass the runtime object itself, never a copy, or the cache
 * is bypassed.
 */
export function resolveOwnUid(context: OwnUidContext): Promise<OwnUidResult> {
  const cached = resolved.get(context)
  if (cached) return cached
  const pending = resolveUid({
    tokenUid: context.userId,
    lookupAccount: () => callNcm('user_account', {}, { jar: context.jar, fakeIp: context.fakeIp }),
  })
  resolved.set(context, pending)
  return pending
}
