import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * The NetEase API package is CJS and does filesystem work at module scope, so it is
 * kept out of the Next.js bundle (`serverExternalPackages`) and required lazily.
 */
export interface NcmResponse {
  status: number
  body: any
  cookie?: string[]
}

export interface NcmApi {
  [key: string]: ((params: Record<string, unknown>) => Promise<NcmResponse>) | unknown
}

let cached: NcmApi | null = null

export function ncmApi(): NcmApi {
  if (cached) return cached
  const mod = require('@neteasecloudmusicapienhanced/api')
  cached = (mod.default ?? mod) as NcmApi
  return cached
}

export function listEndpointNames(): string[] {
  const api = ncmApi()
  return Object.keys(api)
    .filter((key) => typeof api[key] === 'function')
    .sort()
}

export function hasEndpoint(name: string): boolean {
  const api = ncmApi()
  return typeof api[name] === 'function'
}
