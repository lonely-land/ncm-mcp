#!/usr/bin/env node
/**
 * Recent-play rows are history records. The song is nested at `data`
 * (`/api/play-record/song/list`), with `playTime` on the record. Reading `name`
 * and `id` off the record itself renders `undefined`.
 *
 *   node --test scripts/recent-songs.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context)
    const base = join(root, specifier.slice(2))
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`].find((file) => existsSync(file))
    if (!hit) throw new Error(`Cannot resolve ${specifier}`)
    return nextResolve(pathToFileURL(hit).href, context)
  },
})

const { ALL_TOOLS } = await import('../lib/mcp/registry.ts')
const { paginateGroups, pagingFooter } = await import('../lib/mcp/pagination.ts')

const tool = ALL_TOOLS.find((entry) => entry.name === 'ncm_recent_songs')

/** The published record shape: song under `data`, play time beside it. */
function record(overrides = {}) {
  const song = {
    name: '情非得已 (童声版)',
    id: 33894312,
    ar: [{ id: 122455, name: '群星', tns: [], alias: [] }],
    al: { id: 3263929, name: '热门华语275', picUrl: 'http://p4.music.126.net/cover.jpg' },
    dt: 267232,
    ...(overrides.song ?? {}),
  }
  return {
    resourceId: String(song.id),
    playTime: 1680530816264,
    resourceType: 'SONG',
    data: song,
    banned: false,
    ...overrides.record,
  }
}

function renderPage(body, args = { page: 1, pageSize: 20 }) {
  const paged = paginateGroups(body, tool.paging.groups, args, { mode: tool.paging.mode })
  return `${tool.render(paged.body, args)}${pagingFooter(paged.groups)}`
}

test('a recent-play record renders the nested song, not the record', () => {
  const played = new Date(1680530816264).toISOString()
  const text = tool.render(
    {
      code: 200,
      data: {
        total: 300,
        list: [record()],
      },
    },
    {},
  )
  assert.equal(
    text,
    `Recently played\n- 情非得已 (童声版) — 群星 (热门华语275) [267s] id=33894312 played=${played}`,
  )
  assert.doesNotMatch(text, /undefined/)
})

test('missing artist and play time are omitted', () => {
  const text = tool.render(
    {
      code: 200,
      data: {
        list: [
          record({
            song: { ar: [], al: {}, dt: 0 },
            record: { playTime: undefined },
          }),
        ],
      },
    },
    {},
  )
  assert.equal(text, 'Recently played\n- 情非得已 (童声版) id=33894312')
  assert.doesNotMatch(text, /undefined|played=|—/)
})

test('song and resource nest the same way when data is absent', () => {
  const song = { name: '海阔天空', id: 347230, ar: [{ id: 11127, name: 'Beyond' }] }
  const text = tool.render(
    {
      code: 200,
      data: {
        list: [
          { resourceId: '1', playTime: 1700000000000, song },
          { resourceId: '2', resource: { name: '光辉岁月', id: 346576, artists: [{ id: 1, name: 'Beyond' }] } },
        ],
      },
    },
    {},
  )
  assert.match(text, /^- 海阔天空 — Beyond id=347230 played=2023-11-14T22:13:20.000Z/m)
  assert.match(text, /^- 光辉岁月 — Beyond id=346576$/m)
  assert.doesNotMatch(text, /undefined/)
})

test('an empty history does not invent rows', () => {
  assert.equal(tool.render({ code: 200, data: { total: 0, list: [] } }, {}), 'Recently played\n(no songs)')
})

test('a page of nested records keeps the paging footer and never prints undefined', () => {
  const list = Array.from({ length: 40 }, (_, index) =>
    record({
      song: { name: `Track ${index + 1}`, id: 1000 + index, ar: [{ id: 7, name: 'Artist' }] },
      record: { playTime: index === 3 ? undefined : 1680530816264 + index },
    }),
  )
  const text = renderPage({ code: 200, data: { total: 300, list } })
  const lines = text.split('\n')
  const played = new Date(1680530816264).toISOString()
  assert.equal(lines[0], 'Recently played')
  assert.equal(lines[1], `- Track 1 — Artist (热门华语275) [267s] id=1000 played=${played}`)
  assert.equal(lines[4], '- Track 4 — Artist (热门华语275) [267s] id=1003')
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 20)
  assert.equal(
    lines.at(-1),
    'paging: page 1 · 20 songs · items 1-20 of 300 · hasMore=true · next: page=2',
  )
  assert.doesNotMatch(text, /undefined/)
})
