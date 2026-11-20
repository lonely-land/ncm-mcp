/**
 * Bounding the payload of a raw endpoint by the window its caller asked for.
 *
 * `ncm_raw` forwards `limit`/`offset` straight to the endpoint, but NetEase endpoints
 * are not obliged to honour either. Some ignore `limit` outright (`toplist` always
 * sends all 65 charts whatever limit it is given; `simi_song` always sends 5 songs) and
 * some answer `limit + 1` rows so they can set their own `more` flag. Nothing used to
 * trim a raw response below the character ceiling, so `limit=2` over a 65-row endpoint
 * returned whatever fit in 16000 characters — 12 rows — while the body still said
 * `more: false`. A caller could not tell 12 of 65 from 12 of 12.
 *
 * This module makes the requested count authoritative: every payload array is sliced
 * to `limit`, the withheld remainder is stated, and `more` can never read `false` when
 * something was left out.
 */

import { findDominantArray, readPath } from './pagination.ts'
import type { WindowReport } from '../ncm/serialize.ts'

/** The window the caller asked for, as it was forwarded upstream. */
export interface RawWindow {
  limit?: number
  offset?: number
}

export interface WindowedRawBody {
  body: any
  /** Arrays whose upstream size is worth reporting, empty when no window was asked. */
  windows: WindowReport[]
  /** Dot paths of boolean "more exists" flags the truncation pass may correct. */
  morePaths: string[]
}

/** Boolean `more` flags NetEase puts in different places, kept in sync by the notice. */
export const RAW_MORE_PATHS = [
  'more',
  'hasMore',
  'data.more',
  'data.hasMore',
  'result.more',
  'result.hasMore',
]

/**
 * Bound a raw endpoint's payload by the caller's `limit` and record what was withheld.
 *
 * `offset` is not re-applied here: the endpoint was already asked for it. An endpoint
 * that ignores `offset` returns the collection from the start, and the window is then
 * sliced from that start — which is what the caller can actually retrieve, so the
 * reported numbers stay true to what was delivered.
 */
export function windowRawBody(rawBody: any, window: RawWindow): WindowedRawBody {
  const morePaths = [...RAW_MORE_PATHS]
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { body: rawBody, windows: [], morePaths }
  }

  const target = findDominantArray(rawBody)
  const list = target ? readPath(rawBody, target) : undefined
  const key = target ? target[target.length - 1] : undefined
  const bounded = target !== undefined && key !== undefined && Array.isArray(list) && window.limit !== undefined

  const request: Record<string, unknown> = {}
  if (window.limit !== undefined) request.limit = window.limit
  if (window.offset !== undefined) request.offset = window.offset

  if (!bounded || !target || key === undefined) {
    // No limit asked for: the character ceiling is the only bound left, and the
    // endpoint's own `more` flag is left to the notice's correction pass.
    return {
      body: Object.keys(request).length > 0 ? { ...rawBody, request } : rawBody,
      windows: [],
      morePaths,
    }
  }

  const upstreamTotal = list.length
  // Over-delivery is the endpoint's signal, not page content: the caller asked for
  // `limit` rows and that is what it receives.
  const items = list.slice(0, window.limit)
  const withheld = upstreamTotal - items.length
  const more = items.length > 0 && (withheld > 0 || rawBody.more === true)

  return {
    body: {
      ...rawBody,
      [key]: items,
      more,
      request: {
        ...request,
        returned: items.length,
        upstreamTotal,
        ...(withheld > 0 ? { withheld } : {}),
        more,
        note:
          'the window was sent upstream as limit/offset; `returned` is what this result carries, ' +
          "`upstreamTotal` is how many the endpoint's array held, and `withheld` is the difference",
      },
    },
    windows: [{ path: target.join('.'), unit: key, upstreamTotal, delivered: items.length }],
    morePaths,
  }
}
