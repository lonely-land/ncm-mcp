#!/usr/bin/env node
/**
 * Unit checks for the raw-escape-hatch window and the truncation vocabulary.
 *
 * The defects these pin down, as reported from the deployed build:
 *
 * 1. `ncm_raw {limit: 2}` returned 12 rows, because nothing bounded a raw endpoint's
 *    array below the 16000-character ceiling — `toplist` ignores `limit` and always
 *    sends all 65 charts, so the character ceiling alone decided the count.
 * 2. That truncated body still said `more: false`, so a partial answer was
 *    indistinguishable from a complete one.
 * 3. The truncation hint told callers to `re-request with pageSize<=12`, but `ncm_raw`
 *    has no `pageSize` parameter — it takes `limit`/`offset`.
 *
 *   node --test scripts/raw-window.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { windowRawBody } from '../lib/mcp/raw-window.ts'
import { pageMeta, pageRequest, pagingLine } from '../lib/mcp/pagination.ts'
import {
  PAGE_WINDOW_VOCAB,
  RAW_WINDOW_VOCAB,
  toStructuredText,
} from '../lib/ncm/serialize.ts'

const rows = (count) => Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}` }))
const ceiling = 16000

// --- the delivered count never exceeds the requested limit ----------------

test('limit=2 over an endpoint that ignores limit delivers 2 rows, not 12', () => {
  // `toplist` answers with all 65 charts whatever limit it is given.
  const body = { code: 200, list: rows(65) }
  const { body: windowed, windows } = windowRawBody(body, { limit: 2 })
  assert.equal(windowed.list.length, 2, 'the caller asked for 2 and must get at most 2')
  assert.equal(windowed.request.limit, 2)
  assert.equal(windowed.request.returned, 2)
  assert.equal(windowed.request.upstreamTotal, 65)
  assert.equal(windowed.request.withheld, 63)
  assert.equal(windows[0].upstreamTotal, 65)
  assert.equal(windows[0].delivered, 2)
})

test('limit=2 over an endpoint that over-delivers limit+1 trims the signal row', () => {
  // `user_playlist` answers limit=2 with 3 rows so it can set its own `more`.
  const body = { code: 200, more: true, playlist: rows(3) }
  const { body: windowed } = windowRawBody(body, { limit: 2 })
  assert.equal(windowed.playlist.length, 2)
  assert.equal(windowed.request.withheld, 1)
  assert.equal(windowed.more, true, 'the trimmed signal row still proves more exists')
})

test('a limit larger than the array delivers the whole array and says so', () => {
  const body = { code: 200, list: rows(5) }
  const { body: windowed } = windowRawBody(body, { limit: 20 })
  assert.equal(windowed.list.length, 5)
  assert.equal(windowed.request.returned, 5)
  assert.equal(windowed.request.withheld, undefined)
  assert.equal(windowed.more, false, 'nothing was withheld, so there is no more')
})

test('a ceiling that bites inside a full window still reports what survived', () => {
  // limit=100 covers all 27 rows, so the window withheld nothing — then the ceiling
  // drops 20 of them. `request.returned` must follow the body down to 7.
  const body = { code: 200, more: false, playlist: rows(27).map((row) => ({ ...row, pad: 'x'.repeat(300) })) }
  const { body: windowed, windows } = windowRawBody(body, { limit: 100 })
  assert.equal(windowed.request.returned, 27, 'the window itself delivered all 27')
  const text = toStructuredText(windowed, { limit: 4000, vocab: RAW_WINDOW_VOCAB, windows })
  const parsed = JSON.parse(text)
  assert.ok(parsed.playlist.length < 27, 'the ceiling must have dropped rows')
  const delivered = parsed.playlist.length
  assert.equal(parsed.request.returned, delivered, 'the echo must not claim rows the body lost')
  assert.equal(parsed.request.withheld, 27 - delivered)
  assert.equal(parsed.more, true)
  assert.equal(parsed.truncated.window[0].delivered, delivered)
  assert.match(parsed.truncated.window[0].next, new RegExp(`offset=${delivered}`))
})

test('no limit leaves the array alone', () => {
  const body = { code: 200, list: rows(65) }
  const { body: windowed } = windowRawBody(body, {})
  assert.equal(windowed.list.length, 65)
})

// --- a truncated response never claims more:false -------------------------

test('a ceiling-truncated body cannot keep more:false', () => {
  const body = { code: 200, more: false, list: rows(65) }
  const text = toStructuredText(body, {
    limit: 2000,
    vocab: RAW_WINDOW_VOCAB,
    correctMore: ['more', 'data.more', 'result.more'],
  })
  const parsed = JSON.parse(text)
  assert.ok(parsed.list.length < 65, 'the ceiling must have dropped items for this test to mean anything')
  assert.equal(parsed.more, true, 'items were withheld, so the flag must not read false')
  assert.ok(parsed.truncated?.dropped?.[0]?.dropped > 0)
})

test('an untruncated body keeps its own more:false', () => {
  const body = { code: 200, more: false, list: rows(3) }
  const text = toStructuredText(body, { limit: ceiling, vocab: RAW_WINDOW_VOCAB, correctMore: ['more'] })
  assert.equal(JSON.parse(text).more, false)
})

test('a windowed body reports more:true whenever it withheld rows', () => {
  const body = { code: 200, more: false, list: rows(65) }
  const { body: windowed } = windowRawBody(body, { limit: 2 })
  assert.equal(windowed.more, true)
})

// --- the hint names the tool's own parameters -----------------------------

test('the raw hint says limit/offset, never pageSize', () => {
  const body = { code: 200, list: rows(65) }
  const text = toStructuredText(body, { limit: 2000, vocab: RAW_WINDOW_VOCAB })
  const parsed = JSON.parse(text)
  const hints = JSON.stringify(parsed.truncated)
  assert.match(hints, /limit<=/)
  assert.doesNotMatch(hints, /pageSize/, 'ncm_raw has no pageSize parameter')
})

test('the default curated hint names pageSize, never limit', () => {
  // No custom hint: the built-in sentence must still use the curated vocabulary.
  const meta = {
    ...pageMeta(pageRequest({ page: 2, pageSize: 10 }), 4, { hasMore: true }),
    truncated: 6,
  }
  const line = pagingLine(meta, 'songs', PAGE_WINDOW_VOCAB)
  assert.match(line, /pageSize<=4/)
  // Offset 10 at 4 kept rows restarts at page 3 — the window start, not the page asked.
  assert.match(line, /page=3/)
  assert.doesNotMatch(line, /limit/)
})

// --- the reported accounting is about the upstream array ------------------

test('truncation accounting reports kept/dropped/total against the array it was given', () => {
  // A windowed slice that is still too tall for the ceiling: the drop accounting must
  // describe that array (12 rows), while the window report keeps the real upstream size.
  const body = { code: 200, list: rows(65).map((row) => ({ ...row, pad: 'x'.repeat(200) })) }
  const { body: windowed, windows } = windowRawBody(body, { limit: 12 })
  assert.equal(windowed.list.length, 12)
  const text = toStructuredText(windowed, { limit: 1200, vocab: RAW_WINDOW_VOCAB, windows })
  const parsed = JSON.parse(text)
  const drop = parsed.truncated?.dropped?.[0]
  assert.ok(drop, 'a slice this size must be trimmed')
  assert.equal(drop.total, 12, 'the ceiling accounting counts the array it was given')
  assert.equal(drop.kept + drop.dropped, drop.total)
  assert.equal(parsed.truncated.window[0].upstreamTotal, 65, 'the window report keeps the real upstream size')
})

test('a limit=2 caller can tell they got 2 of 65', () => {
  const body = { code: 200, list: rows(65) }
  const { body: windowed, windows } = windowRawBody(body, { limit: 2 })
  const text = toStructuredText(windowed, { limit: ceiling, vocab: RAW_WINDOW_VOCAB, windows })
  const parsed = JSON.parse(text)
  const report = parsed.truncated.window[0]
  assert.equal(report.delivered, 2)
  assert.equal(report.upstreamTotal, 65)
  assert.equal(report.withheld, 63)
  assert.match(report.next, /2 of 65/)
  assert.match(report.next, /offset=2/)
})
