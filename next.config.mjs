import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * The NetEase package is CJS and discovers its 451 endpoint modules with `readdirSync`,
 * which the bundler cannot follow. Keeping it external preserves that behaviour, but
 * Next then traces only the package directory, and every third-party module those
 * endpoint files `require` is left out of the Lambda.
 *
 * Rather than hardcoding that list (which drifts with every upstream release), walk the
 * dependency graph from the package's own `dependencies` and include the closure.
 */
function resolvePackageDir(name) {
  // Deployments use a flat install; fall back to nested lookup for safety.
  const candidates = [
    join(root, 'node_modules', name),
    join(root, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'node_modules', name),
    join(root, 'node_modules', '@neteasecloudmusicapienhanced', 'unblockmusic-utils', 'node_modules', name),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

function dependenciesOf(name) {
  const dir = resolvePackageDir(name)
  if (!dir) return []
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return Object.keys(manifest.dependencies ?? {})
  } catch {
    return []
  }
}

function closure(rootNames) {
  const seen = new Map()
  const queue = [...rootNames]
  while (queue.length > 0) {
    const name = queue.shift()
    if (!name || seen.has(name) || name === 'https') continue
    const dir = resolvePackageDir(name)
    if (!dir) continue
    seen.set(name, dir)
    queue.push(...dependenciesOf(name))
  }
  return [...seen.keys()].sort()
}

const neteaseRoots = [
  ...dependenciesOf('@neteasecloudmusicapienhanced/api'),
  ...dependenciesOf('@neteasecloudmusicapienhanced/unblockmusic-utils'),
]

const tracedPackages = closure(neteaseRoots)

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@neteasecloudmusicapienhanced/api'],
  outputFileTracingIncludes: {
    '/**': [
      'node_modules/@neteasecloudmusicapienhanced/api/**',
      'node_modules/@neteasecloudmusicapienhanced/unblockmusic-utils/**',
      ...tracedPackages.map((name) => `node_modules/${name}/**`),
    ],
  },
  poweredByHeader: false,
}

export default nextConfig
