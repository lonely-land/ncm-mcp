/**
 * One paging contract for every list-returning tool.
 *
 * Clients ask with `page` (1-based) and `pageSize`; `pageSize` is clamped into
 * 1..MAX_PAGE_SIZE rather than rejected, so an over-eager model can never fail a
 * call by asking for 5000 items. Every page reports metadata (page, pageSize,
 * returned, total when known, hasMore) so the model can tell "this is all of it"
 * from "there is more" and ask for the next page instead of guessing.
 */

import * as z from 'zod'

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 20
/** Ceiling on how much one page may pull from an upstream that cannot offset. */
export const MAX_FETCH = 400

export const pageSchema = z.number().int().optional().describe('Page number, 1-based. Default 1.')

export const pageSizeSchema = z
  .number()
  .int()
  .optional()
  .describe(
    `Items per page. Default ${DEFAULT_PAGE_SIZE}; values above ${MAX_PAGE_SIZE} are clamped to ` +
      `${MAX_PAGE_SIZE}, values below 1 are clamped to 1.`,
  )

/** Spread into a tool's zod input object. */
export const pagingShape = { page: pageSchema, pageSize: pageSizeSchema }

export interface PageArgs {
  page?: number
  pageSize?: number
}

export interface PageRequest {
  page: number
  pageSize: number
  offset: number
}

export interface PageMeta {
  page: number
  pageSize: number
  /** Zero-based index of the first item on this page. */
  offset: number
  /** How many items this page actually carries. */
  returned: number
  /** Total available, only when it is actually known. Never a guess. */
  total?: number
  hasMore: boolean
  /**
   * Items this page was measured to hold but the body ceiling removed from the end.
   * The page is still the requested window; those items exist and are only missing
   * from the text, so a caller re-reads the same page with a smaller pageSize.
   */
  truncated?: number
}

export interface PagedGroup {
  /** Human label, e.g. "songs". */
  label: string
  /** Dot path of the paged array in the body. */
  path: string
  /** Noun for counts, e.g. "songs". */
  unit: string
  meta: PageMeta
}

function toInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.trunc(value)
}

export function clampPageSize(value: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  const raw = toInt(value) ?? fallback
  return Math.min(MAX_PAGE_SIZE, Math.max(1, raw))
}

/** Normalise raw args into a concrete window. Never throws, always clamps. */
export function pageRequest(args: PageArgs | undefined, defaultPageSize = DEFAULT_PAGE_SIZE): PageRequest {
  const page = Math.max(1, toInt(args?.page) ?? 1)
  const pageSize = clampPageSize(args?.pageSize, defaultPageSize)
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** `limit`/`offset` pair for endpoints that page upstream. */
export function upstreamWindow(req: PageRequest): { limit: number; offset: number } {
  return { limit: req.pageSize, offset: req.offset }
}

/**
 * For endpoints that take `limit` but no `offset`: ask for everything up to the end
 * of the requested page so the page can be sliced locally. Capped by MAX_FETCH so a
 * deep page cannot drag thousands of rows through one call.
 */
export function localFetchLimit(req: PageRequest, cap = MAX_FETCH): number {
  return Math.min(cap, req.offset + req.pageSize)
}

/**
 * Total for a locally held list that came from a request capped at `fetchLimit`:
 * the length is only a real total when the upstream sent less than we asked for.
 */
export function knownTotal(list: readonly unknown[] | undefined, fetchLimit?: number): number | undefined {
  if (!Array.isArray(list)) return undefined
  if (fetchLimit === undefined) return list.length
  return list.length < fetchLimit ? list.length : undefined
}

/**
 * Describe one page.
 *
 * `total` is only ever reported when someone actually knows it: the upstream sent a
 * count, or the caller holds the complete list. A short page proves the end of a
 * collection, so it is used as a `hasMore` signal — never as a total, because an
 * endpoint with its own cap (e.g. 29 rows whatever `limit` asks) would otherwise
 * report "of 29" for a feed that really holds 47.
 */
export function pageMeta(
  req: PageRequest,
  returned: number,
  options: { total?: number; hasMore?: boolean } = {},
): PageMeta {
  const total =
    typeof options.total === 'number' && Number.isFinite(options.total) ? options.total : undefined
  const hasMore =
    typeof options.hasMore === 'boolean'
      ? options.hasMore
      : total !== undefined
        ? req.offset + returned < total
        : returned > 0 && returned >= req.pageSize
  return {
    page: req.page,
    pageSize: req.pageSize,
    offset: req.offset,
    returned,
    ...(total !== undefined ? { total } : {}),
    hasMore,
  }
}

export interface PaginateOptions {
  /** Total available, when the upstream reports one. */
  total?: number
  /** Explicit "more exists" flag from the upstream, overrides inference. */
  hasMore?: boolean
  defaultPageSize?: number
}

export interface Paginated<T> {
  items: T[]
  meta: PageMeta
}

/**
 * Slice an in-memory list into one page and describe what is left. `options.total`
 * is for callers that hold only part of a collection; when omitted the list is
 * assumed to be complete and its length becomes the total.
 */
export function paginate<T>(
  items: readonly T[] | undefined | null,
  args: PageArgs | undefined,
  options: PaginateOptions = {},
): Paginated<T> {
  const req = pageRequest(args, options.defaultPageSize)
  const list = Array.isArray(items) ? items : []
  const declared =
    typeof options.total === 'number' && Number.isFinite(options.total) ? options.total : undefined
  const total = declared ?? list.length
  const slice = list.slice(req.offset, req.offset + req.pageSize)
  return { items: slice, meta: pageMeta(req, slice.length, { total, hasMore: options.hasMore }) }
}

/** One-line, model-readable summary printed under every paged result. */
export function pagingLine(meta: PageMeta, unit = 'items'): string {
  const noun = meta.returned === 1 ? unit.replace(/s$/, '') : unit
  const parts = [`page ${meta.page}`, `${meta.returned} ${noun}`]
  if (meta.total !== undefined) {
    if (meta.returned > 0) {
      parts.push(`items ${meta.offset + 1}-${meta.offset + meta.returned} of ${meta.total}`)
    } else {
      parts.push(`${meta.total} ${unit} available in total`)
    }
  } else {
    parts.push('total unknown')
  }
  parts.push(`hasMore=${meta.hasMore}`)
  if (meta.truncated && meta.returned > 0) {
    // The window was the requested one but its tail did not fit. Point at a page
    // whose window starts at or before this offset, so re-reading never skips items.
    const smaller = meta.returned
    const restartPage = Math.floor(meta.offset / smaller) + 1
    parts.push(`${meta.truncated} dropped by the size ceiling`)
    parts.push(`re-request with pageSize<=${smaller} and page=${restartPage} to read this range, then continue`)
  } else if (meta.hasMore) {
    parts.push(`next: page=${meta.page + 1}`)
  }
  return parts.join(' · ')
}

/** Empty-page note so a caller past the end sees why nothing came back. */
export function pagingEmptyNote(meta: PageMeta, unit = 'items'): string {
  if (meta.page <= 1) return `(no ${unit})`
  const total = meta.total !== undefined ? `; ${meta.total} ${unit} available` : ''
  return `(no ${unit} on page ${meta.page}${total})`
}

/** Trailer appended to a rendered tool result so the model sees the paging state. */
export function pagingFooter(groups: PagedGroup[]): string {
  if (groups.length === 0) return ''
  const single = groups.length === 1
  // Always emitted for a paged tool: an empty page still needs to say "0 of N",
  // otherwise the caller cannot tell an empty result from a missing one.
  const lines = groups.map((group) =>
    single
      ? `paging: ${pagingLine(group.meta, group.unit)}`
      : `${group.label}: ${pagingLine(group.meta, group.unit)}`,
  )
  return `\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Body paging: slice arrays inside an upstream payload, keep everything else
// ---------------------------------------------------------------------------

function splitPath(path: string): string[] {
  return path.split('.').filter(Boolean)
}

export function readPath(value: any, path: string | string[]): any {
  const keys = typeof path === 'string' ? splitPath(path) : path
  let cursor = value
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function writePath(body: any, path: string[], replacement: any): any {
  if (path.length === 0) return replacement
  const [head, ...rest] = path
  const source = body && typeof body === 'object' ? body : {}
  return { ...source, [head]: writePath(source[head], rest, replacement) }
}

/** Score an array for "is this the payload?": object arrays first, then the longest. */
function collectionScore(value: unknown[]): number {
  if (value.length === 0) return -1
  let objects = 0
  for (const entry of value) {
    if (entry && typeof entry === 'object') objects += 1
  }
  return objects * 2 >= value.length ? value.length * 2 : value.length
}

/** Pick the array that most likely carries the payload of an untagged endpoint. */
export function findDominantArray(body: any): string[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const candidates: { path: string[]; score: number }[] = []
  const consider = (path: string[], value: unknown) => {
    if (Array.isArray(value)) candidates.push({ path, score: collectionScore(value) })
  }
  const walk = (prefix: string[], node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 2) return
    for (const [key, value] of Object.entries(node)) {
      consider([...prefix, key], value)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk([...prefix, key], value, depth + 1)
      }
    }
  }
  walk([], body, 0)
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return best && best.score >= 0 ? best.path : undefined
}

export interface GroupSpec {
  /** Dot path to the array, e.g. "result.songs". */
  path: string
  /** Footer label, e.g. "songs". */
  label: string
  /** Noun for counts; defaults to the label. */
  unit?: string
  /** Dot path to a total count, when the body carries one. */
  totalPath?: string
  /** Dot path to a boolean "more exists" flag. */
  hasMorePath?: string
}

export type PagingMode = 'offset' | 'limit' | 'local'

export interface PagingSpec {
  mode: PagingMode
  defaultPageSize?: number
  /**
   * The `limit` this call actually sent upstream. Some endpoints return `limit+1`
   * rows so they can report `more`; that extra row is an over-delivery signal, not a
   * page item, so it is trimmed before the page is measured.
   */
  requestedLimit?: number
}

export interface BodyPagingResult {
  body: any
  groups: PagedGroup[]
  /** Set when an upstream `limit+1` over-delivery was trimmed off an array. */
  trimmed?: { path: string; count: number }
}

/** Boolean "more exists" flags that endpoints put in different places. */
const GENERIC_MORE_PATHS = ['more', 'hasMore', 'data.more', 'data.hasMore', 'result.more', 'result.hasMore']
const GENERIC_TOTAL_PATHS = ['total', 'count', 'data.totalCount', 'data.total']

function firstBoolean(body: any, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const value = readPath(body, path)
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function firstFiniteNumber(body: any, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = readPath(body, path)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Page one or more arrays inside an upstream body, keeping sibling metadata intact,
 * and attach a `paging` object keyed by array path for JSON-returning tools.
 *
 * - `offset`: upstream applied limit/offset, so each array already holds the page
 * - `limit`:  upstream applied only limit (we asked for everything up to the page
 *             end), so slice locally; a short response means the collection ended
 * - `local`:  upstream sent everything, so slice locally and the list is complete
 *
 * `total` is only reported when a real count is available (the tool's `totalPath`,
 * a conventional counter, or a complete local list). `hasMore` prefers the upstream
 * flag — the tool's `hasMorePath`, a conventional `more`/`hasMore` key, or the
 * `limit+1` over-delivery an endpoint uses to signal more rows — and otherwise infers
 * from a short page, which can only ever turn `hasMore` off, never on.
 */
export function paginateGroups(
  body: any,
  specs: GroupSpec[],
  args: PageArgs | undefined,
  spec: PagingSpec = { mode: 'local' },
): BodyPagingResult {
  if (!body || typeof body !== 'object') return { body, groups: [] }

  // No pinned paths (or none present in this response) means: page whichever array
  // actually carries the payload, rather than handing back an unbounded list.
  let effective = specs
  const anyPresent = specs.some((group) => Array.isArray(readPath(body, group.path)))
  if (!anyPresent) {
    const detected = findDominantArray(body)?.join('.')
    if (!detected) {
      // Nothing array-shaped here at all. If the tool declares list semantics, say
      // "0 items" rather than staying silent, so the model is not left guessing.
      if (specs.length === 0) return { body, groups: [] }
      const req = pageRequest(args, spec.defaultPageSize)
      const emptyGroups: PagedGroup[] = specs.map((group) => ({
        label: group.label,
        path: group.path,
        unit: group.unit ?? group.label,
        meta: pageMeta(req, 0, { total: 0 }),
      }))
      const paging = Object.fromEntries(emptyGroups.map((group) => [group.path, { ...group.meta }]))
      return { body: { ...body, paging }, groups: emptyGroups }
    }
    // An auto-detected array has no declared paths, so conventional flags still apply.
    effective = [{ path: detected, label: detected.split('.').pop() ?? detected }]
  }

  const req = pageRequest(args, spec.defaultPageSize)
  const fetchLimit = spec.mode === 'limit' ? localFetchLimit(req) : undefined
  // Conventional flags only describe a single collection; with several groups each
  // array needs its own declared path or an explicit count.
  const single = effective.length === 1
  const bodyHasMore = single ? firstBoolean(body, GENERIC_MORE_PATHS) : undefined
  const bodyTotal = single ? firstFiniteNumber(body, GENERIC_TOTAL_PATHS) : undefined
  const groups: PagedGroup[] = []
  let patched: any = body
  let trimmed: { path: string; count: number } | undefined

  for (const group of effective) {
    const path = splitPath(group.path)
    const rawList = readPath(body, path)
    if (!Array.isArray(rawList)) continue
    let list: any[] = rawList

    const rawTotal = group.totalPath ? readPath(body, group.totalPath) : undefined
    const declaredTotal = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : undefined
    const rawHasMore = group.hasMorePath ? readPath(body, group.hasMorePath) : undefined
    const declaredHasMore = typeof rawHasMore === 'boolean' ? rawHasMore : undefined
    const upstreamHasMore = declaredHasMore ?? bodyHasMore
    const upstreamTotal = declaredTotal ?? bodyTotal

    // A `limit+1` over-delivery means "there is at least one more row": the extra row
    // is the signal, not a page item, so it never inflates `returned` or `hasMore`
    // accounting, and never leaks into a page.
    let overDelivered = false
    if (spec.requestedLimit !== undefined && list.length > spec.requestedLimit) {
      list = list.slice(0, spec.requestedLimit)
      overDelivered = true
      trimmed = { path: group.path, count: rawList.length - spec.requestedLimit }
    }

    let items: any[]
    let meta: PageMeta

    // A page that starts at or past a known total cannot hold anything. Some
    // endpoints answer such an offset with an unrelated block of rows, which would
    // otherwise be reported as page content.
    const pastEnd = upstreamTotal !== undefined && req.offset >= upstreamTotal

    if (spec.mode === 'offset') {
      // The upstream already applied limit/offset: this array *is* the page.
      items = pastEnd ? [] : list
      const reachedEnd = upstreamTotal !== undefined && req.offset + items.length >= upstreamTotal
      meta = pageMeta(req, items.length, {
        total: upstreamTotal,
        hasMore: reachedEnd ? false : (upstreamHasMore ?? (overDelivered ? true : undefined)),
      })
    } else {
      // The array starts at index 0 in both local modes.
      // - `local`: the upstream sent everything, so the list is complete and its
      //   length is a real total.
      // - `limit`: we asked for everything up to the page end; a short response
      //   proves the end but says nothing about a total, so none is reported.
      const complete = spec.mode === 'local' || (!overDelivered && list.length < (fetchLimit ?? 0))
      items = pastEnd ? [] : list.slice(req.offset, req.offset + req.pageSize)
      const inferredMore = complete
        ? req.offset + items.length < list.length
        : items.length >= req.pageSize
      const reachedEnd = upstreamTotal !== undefined && req.offset + items.length >= upstreamTotal
      meta = pageMeta(req, items.length, {
        total: upstreamTotal ?? (spec.mode === 'local' ? list.length : undefined),
        hasMore: reachedEnd ? false : (upstreamHasMore ?? (overDelivered ? true : inferredMore)),
      })
    }

    patched = writePath(patched, path, items)
    groups.push({ label: group.label, path: group.path, unit: group.unit ?? group.label, meta })
  }

  if (groups.length === 0) return { body, groups: [] }
  const paging = Object.fromEntries(groups.map((group) => [group.path, { ...group.meta }]))
  const result: BodyPagingResult = { body: { ...patched, paging }, groups }
  if (trimmed) result.trimmed = trimmed
  return result
}
