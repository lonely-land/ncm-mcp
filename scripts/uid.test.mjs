#!/usr/bin/env node
/**
 * Unit checks for account-id resolution (lib/ncm/uid.ts).
 *
 * The interesting case is a session whose access token carries no uid — what a QR login
 * produces when the 803 body omits `account` — which must still resolve an account from
 * the cookie jar rather than fail. Kept free of network access by injecting the upstream
 * call.
 *
 *   node --test scripts/uid.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveUid, UID_DIAGNOSTIC } from '../lib/ncm/uid.ts'

const ok = (body) => ({ ok: true, status: 200, body })

test('a token with a uid never calls upstream', async () => {
  let calls = 0
  const result = await resolveUid({
    tokenUid: 32953014,
    lookupAccount: async () => {
      calls += 1
      return ok({ account: { id: 1 }, profile: { userId: 1 } })
    },
  })
  assert.deepEqual(result, { ok: true, uid: 32953014, source: 'token' })
  assert.equal(calls, 0, 'the uid-less fallback must not run when the token has a uid')
})

test('a numeric-string token uid is accepted', async () => {
  const result = await resolveUid({
    tokenUid: '32953014',
    lookupAccount: async () => assert.fail('upstream must not be called'),
  })
  assert.deepEqual(result, { ok: true, uid: 32953014, source: 'token' })
})

test('a uid-less token falls back to the upstream account', async () => {
  const result = await resolveUid({
    tokenUid: undefined,
    lookupAccount: async () => ok({ account: { id: 32953014 }, profile: { userId: 32953014 } }),
  })
  assert.deepEqual(result, { ok: true, uid: 32953014, source: 'upstream' })
})

test('profile.userId alone is enough', async () => {
  const result = await resolveUid({
    tokenUid: undefined,
    lookupAccount: async () => ok({ profile: { userId: 32953014 } }),
  })
  assert.deepEqual(result, { ok: true, uid: 32953014, source: 'upstream' })
})

test('account.id alone is enough', async () => {
  const result = await resolveUid({
    tokenUid: undefined,
    lookupAccount: async () => ok({ account: { id: '32953014' } }),
  })
  assert.deepEqual(result, { ok: true, uid: 32953014, source: 'upstream' })
})

test('an upstream body with null account/profile fails honestly', async () => {
  const result = await resolveUid({
    tokenUid: undefined,
    lookupAccount: async () => ok({ code: 200, account: null, profile: null }),
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /did not expose one/)
  assert.match(result.message, /user_account/)
  assert.match(result.message, /ncm_raw/)
  assert.ok(result.message.includes(UID_DIAGNOSTIC))
  assert.doesNotMatch(result.message, /sign in again|re-login|reconnect/i)
})

test('a failed upstream call names the failure and the diagnostic', async () => {
  const result = await resolveUid({
    tokenUid: undefined,
    lookupAccount: async () => ({ ok: false, status: 301, body: { code: 301, message: '用户未登录' } }),
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /301/)
  assert.match(result.message, /user_account/)
  assert.doesNotMatch(result.message, /sign in again|re-login|reconnect/i)
})

test('a zero or non-numeric id is treated as absent, not as account 0', async () => {
  for (const bad of [0, '0', '', 'abc', null, { id: 1 }]) {
    const result = await resolveUid({
      tokenUid: bad,
      lookupAccount: async () => ok({ account: null, profile: null }),
    })
    assert.equal(result.ok, false, `token uid ${JSON.stringify(bad)} must not resolve`)
  }
})
