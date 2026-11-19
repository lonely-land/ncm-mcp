#!/usr/bin/env node
/**
 * Unit checks for the one paging contract (lib/mcp/pagination.ts).
 *
 * The bug these pin down: a finished collection reported `total unknown`, so a caller
 * saw `65 playlists · total unknown · hasMore=false` and assumed rows were missing.
 * A last page *does* know its total — `offset + returned` — while a page that says
 * more exists genuinely does not.
 *
 *   node --test scripts/pagination.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pageMeta,
  pageRequest,
  pagingEmptyNote,
  pagingFooter,
  pagingLine,
  paginate,
  paginateGroups,
  takeWindow,
} from '../lib/mcp/pagination.ts'

const req = (page, pageSize) => pageRequest({ page, pageSize })

// --- pageMeta: deriving a total only at the end ----------------------------

test('the last page of a collection reports an exact total', () => {
  // 65 playlists, pageSize 20, page 4 holds the remaining 5.
  const meta = pageMeta(req(4, 20), 5, { hasMore: false })
  assert.equal(meta.total, 65)
  assert.equal(meta.hasMore, false)
  assert.equal(pagingLine(meta, 'playlists'), 'page 4 · 5 playlists · items 61-65 of 65 · hasMore=false')
})

test('a has-more page with no upstream count still says total unknown', () => {
  const meta = pageMeta(req(1, 20), 20, { hasMore: true })
  assert.equal(meta.total, undefined)
  assert.equal(meta.hasMore, true)
  assert.match(pagingLine(meta, 'playlists'), /total unknown/)
})

test('a full page whose upstream gave no more-flag still counts as has-more', () => {
  const meta = pageMeta(req(1, 20), 20, {})
  assert.equal(meta.hasMore, true, 'a full page cannot be assumed to end the collection')
  assert.equal(meta.total, undefined)
})

test('the one-page collection reports its own size', () => {
  const meta = pageMeta(req(1, 20), 7, {})
  assert.equal(meta.hasMore, false)
  assert.equal(meta.total, 7)
})

test('an explicit upstream total still wins and decides hasMore', () => {
  const meta = pageMeta(req(1, 20), 20, { total: 65 })
  assert.equal(meta.total, 65)
  assert.equal(meta.hasMore, true)
  const last = pageMeta(req(4, 20), 5, { total: 65 })
  assert.equal(last.hasMore, false)
  assert.equal(last.total, 65)
})

test('an empty first page is an exact zero, not unknown', () => {
  const meta = pageMeta(req(1, 20), 0, {})
  assert.equal(meta.total, 0)
  assert.equal(meta.hasMore, false)
  assert.equal(pagingLine(meta, 'playlists'), 'page 1 · 0 playlists · 0 playlists available in total · hasMore=false')
})

test('a page beyond the end never reports the offset as the total', () => {
  const meta = pageMeta(req(5, 20), 0, { hasMore: false })
  assert.equal(meta.total, undefined, 'offset 80 is an upper bound, never the count')
  assert.equal(meta.returned, 0)
  assert.match(pagingLine(meta, 'playlists'), /past the end/)
  assert.doesNotMatch(pagingLine(meta, 'playlists'), /of 80/)
  assert.match(pagingEmptyNote(meta, 'playlists'), /no playlists on page 5/)
  assert.doesNotMatch(pagingEmptyNote(meta, 'playlists'), /available/)
})

test('an empty last page after a non-empty one is treated as past the end', () => {
  // The page before the end was full, so a caller walking on lands on nothing.
  const meta = pageMeta(req(3, 20), 0, {})
  assert.equal(meta.total, undefined)
  assert.equal(meta.hasMore, false)
  assert.match(pagingLine(meta, 'songs'), /past the end/)
})

// --- paginate: locally held lists -----------------------------------------

test('paginate reports the true total from the last page onward', () => {
  const list = Array.from({ length: 65 }, (_, i) => i)
  const last = paginate(list, { page: 4, pageSize: 20 })
  assert.equal(last.items.length, 5)
  assert.equal(last.meta.total, 65)
  assert.equal(last.meta.hasMore, false)
  assert.equal(paginate(list, { page: 1, pageSize: 20 }).meta.total, 65)
})

// --- paginateGroups: the JSON path ----------------------------------------

test('a JSON result on its last page carries an exact total', () => {
  const body = { playlist: Array.from({ length: 5 }, (_, i) => ({ id: i })) }
  const { body: paged, groups } = paginateGroups(body, [], { page: 4, pageSize: 20 }, { mode: 'offset' })
  assert.equal(groups[0].meta.total, 65)
  assert.equal(paged.playlist.length, 5)
  assert.equal(groups[0].meta.hasMore, false)
})

test('a JSON has-more page with no count keeps total unknown', () => {
  const body = { playlist: Array.from({ length: 20 }, (_, i) => ({ id: i })) }
  const { body: paged, groups } = paginateGroups(body, [], { page: 1, pageSize: 20 }, { mode: 'offset' })
  assert.equal(groups[0].meta.total, undefined)
  assert.equal(groups[0].meta.hasMore, true)
  assert.equal(paged.paging.playlist.total, undefined)
})

test('offset mode trims a limit+1 over-delivery out of the page', () => {
  // The endpoint answers limit=20 with 21 rows to say "more exists".
  const body = { playlist: Array.from({ length: 21 }, (_, i) => ({ id: i })) }
  const { groups } = paginateGroups(
    body,
    [{ path: 'playlist', label: 'playlists' }],
    { page: 1, pageSize: 20 },
    { mode: 'offset', requestedLimit: 20 },
  )
  assert.equal(groups[0].meta.returned, 20, 'the signal row is not page content')
  assert.equal(groups[0].meta.hasMore, true)
  assert.equal(groups[0].meta.total, undefined)
})

test('a short last page in a limit-mode body still reports an exact total', () => {
  const body = { result: Array.from({ length: 12 }, (_, i) => ({ id: i })) }
  const { groups } = paginateGroups(body, [], { page: 1, pageSize: 40 }, { mode: 'limit', requestedLimit: 40 })
  assert.equal(groups[0].meta.hasMore, false)
  assert.equal(groups[0].meta.total, 12)
})

// --- takeWindow -----------------------------------------------------------

test('takeWindow leaves a normal response alone', () => {
  const { items, overDelivered } = takeWindow([1, 2, 3], 5)
  assert.deepEqual(items, [1, 2, 3])
  assert.equal(overDelivered, false)
})

test('takeWindow trims the limit+1 signal row and reports it', () => {
  const { items, overDelivered } = takeWindow([1, 2, 3, 4 , 5, 6], 5)
  assert.deepEqual(items, [1, 2, 3, 4, 5])
  assert.equal(overDelivered, true)
})

test('takeWindow with no declared limit is a no-op', () => {
  assert.deepEqual(takeWindow([1, 2], undefined).items, [1, 2])
})

// --- the reported footer, before and after --------------------------------

test('the reported footer for a finished 65-playlist collection', () => {
  const meta = pageMeta(req(4, 20), 5, { hasMore: false })
  const footer = pagingFooter([{ label: 'playlists', path: 'playlist', unit: 'playlists', meta }])
  assert.equal(footer, '\n\npaging: page 4 · 5 playlists · items 61-65 of 65 · hasMore=false')
})
