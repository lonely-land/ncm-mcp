import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type McpRequestContext,
} from '@modelcontextprotocol/server'

import { SCOPES, mcpResourceUrl } from '@/lib/config'
import { accessTokenVerifier } from '@/lib/oauth/verifier'
import { createServer, sessionFromAuthInfo } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const resourceUrl = mcpResourceUrl()

/**
 * The handler builds a fresh McpServer per HTTP request and hands it the caller's
 * authInfo, so nothing is shared between callers and no session store is needed.
 */
const handler = createMcpHandler((ctx: McpRequestContext) =>
  createServer(sessionFromAuthInfo(ctx.authInfo, ctx.requestInfo ?? new Request(resourceUrl))),
)

const gate = requireBearerAuth({
  verifier: accessTokenVerifier,
  requiredScopes: [SCOPES.read],
  expectedResource: resourceUrl,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
})

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version',
}

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value)
  return response
}

async function serve(request: Request): Promise<Response> {
  const auth = await gate(request)
  if (auth instanceof Response) return withCors(auth)
  return withCors(await handler.fetch(request, { authInfo: auth }))
}
export async function POST(request: Request): Promise<Response> {
  return serve(request)
}

export async function GET(request: Request): Promise<Response> {
  return serve(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return serve(request)
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}
