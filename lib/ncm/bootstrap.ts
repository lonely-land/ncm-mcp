import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { FALLBACK_RANDOM_CN_IP } from '@/lib/config'

const require = createRequire(import.meta.url)

const ANON_TOKEN = resolve(tmpdir(), 'anonymous_token')
const XEAPI_KEY = resolve(tmpdir(), 'xeapi_public_key')
const NEAPI_KEY = resolve(tmpdir(), 'neapi_key')

export interface BootstrapResult {
  ok: boolean
  xeapiKey: boolean
  neapiKey: boolean
  anonymousToken: boolean
  deviceId: string
  errors: string[]
}

let bootstrapPromise: Promise<BootstrapResult> | null = null
let loggedFailure = false

/**
 * `/tmp` is the only writable path in a Vercel function, and it is shared by every
 * invocation that lands on the same warm instance. The NetEase package reads these
 * three files lazily, so seeding them here is enough to unlock the eapi/xeapi/neapi
 * code paths without running the full `generateConfig()` sweep over 451 modules.
 */
export function bootstrapNcm(): Promise<BootstrapResult> {
  if (!bootstrapPromise) bootstrapPromise = runBootstrap()
  return bootstrapPromise
}

async function runBootstrap(): Promise<BootstrapResult> {
  const errors: string[] = []

  if (!existsSync(ANON_TOKEN)) {
    // An empty file is the package's own "not yet registered" sentinel.
    writeFileSync(ANON_TOKEN, '', 'utf-8')
  }

  // The package reads `global.deviceId` when signing xeapi requests; without it the
  // key endpoint rejects the handshake.
  if (!globalThis.deviceId) {
    try {
      const { generateDeviceId } = require('@neteasecloudmusicapienhanced/api/util/index.js')
      globalThis.deviceId = generateDeviceId()
    } catch (error) {
      errors.push(`deviceId: ${describe(error)}`)
    }
  }

  const [xeapiKey, neapiKey] = await Promise.all([
    ensureXeapiKey(errors),
    ensureNeapiKey(errors),
  ])

  if (errors.length > 0 && !loggedFailure) {
    loggedFailure = true
    console.warn('[ncm] bootstrap finished with warnings:', errors.join('; '))
  }

  return {
    ok: xeapiKey,
    xeapiKey,
    neapiKey,
    anonymousToken: existsSync(ANON_TOKEN),
    deviceId: String(globalThis.deviceId ?? ''),
    errors,
  }
}

async function ensureXeapiKey(errors: string[]): Promise<boolean> {
  const current = readJson(XEAPI_KEY)
  if (current?.sk) return true
  try {
    const { getXeapiPublicKey } = require('@neteasecloudmusicapienhanced/api/util/xeapiKey.js')
    const key = await getXeapiPublicKey(current ?? {}, String(globalThis.deviceId ?? ''))
    writeFileSync(XEAPI_KEY, JSON.stringify(key), 'utf-8')
    return true
  } catch (error) {
    errors.push(`xeapi public key: ${describe(error)}`)
    return false
  }
}

async function ensureNeapiKey(errors: string[]): Promise<boolean> {
  const current = readFileSyncSafe(NEAPI_KEY)
  if (current) return true
  try {
    const registerNeapikey = require('@neteasecloudmusicapienhanced/api/module/register_neapikey.js')
    await registerNeapikey({ version: 0, behavior: 'open' }, null)
    return readFileSyncSafe(NEAPI_KEY).length > 0
  } catch (error) {
    errors.push(`neapi key: ${describe(error)}`)
    return false
  }
}

function readFileSyncSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : ''
  } catch {
    return ''
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const raw = readFileSyncSafe(path)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'body' in error) {
    return JSON.stringify((error as { body: unknown }).body).slice(0, 160)
  }
  return String(error).slice(0, 160)
}

declare global {
  // eslint-disable-next-line no-var
  var deviceId: string | undefined
}

/**
 * The "FakeIP" for this request: the IP the MCP client itself connected from, so the
 * upstream sees a consistent geography per caller. Falls back to a random Chinese IP
 * only when explicitly enabled and no forwarded address is present.
 */
export function resolveFakeIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const candidate = forwarded.split(',')[0]?.trim()
    if (candidate && isPublicIp(candidate)) return candidate
  }

  for (const header of ['x-real-ip', 'cf-connecting-ip', 'x-vercel-forwarded-for']) {
    const value = request.headers.get(header)?.split(',')[0]?.trim()
    if (value && isPublicIp(value)) return value
  }

  if (!FALLBACK_RANDOM_CN_IP) return undefined

  try {
    const { generateRandomChineseIP } = require('@neteasecloudmusicapienhanced/api/util/index.js')
    return generateRandomChineseIP() as string
  } catch {
    return undefined
  }
}

function isPublicIp(value: string): boolean {
  // Strip an IPv6-mapped suffix that proxies sometimes leave on IPv4 addresses.
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 10) return false
    if (a === 127) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
    if (a === 0) return false
    return true
  }
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return false
  return ip.includes(':')
}
