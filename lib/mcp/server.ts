import { McpServer, requireScopes, type AuthInfo } from '@modelcontextprotocol/server'

import { SCOPES, enabledToolsets } from '@/lib/config'
import { parseCookieString, type CookieJar } from '@/lib/ncm/cookies'
import { ALL_TOOLS, runTool, type ToolDef, type ToolRuntime } from '@/lib/mcp/registry'

const WRITE_CHALLENGE = requireScopes(SCOPES.read, SCOPES.write)

export interface SessionContext {
  jar: CookieJar
  fakeIp?: string
  userId?: number
  nickname?: string
  scope: string
}

export function sessionFromAuthInfo(authInfo: AuthInfo | undefined, request: Request): SessionContext {
  const extra = (authInfo?.extra ?? {}) as Record<string, unknown>
  const jarString = typeof extra.jar === 'string' ? extra.jar : ''
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return {
    jar: parseCookieString(jarString),
    fakeIp: typeof extra.fakeIp === 'string' ? extra.fakeIp : forwardedIp || undefined,
    userId: typeof extra.userId === 'number' ? extra.userId : undefined,
    nickname: typeof extra.nickname === 'string' ? extra.nickname : undefined,
    scope: authInfo?.scopes?.join(' ') ?? SCOPES.read,
  }
}

function visibleTools(): ToolDef[] {
  const enabled = enabledToolsets()
  if (enabled === 'all') return ALL_TOOLS
  return ALL_TOOLS.filter((tool) => enabled.has(tool.toolset))
}

/** Short instruction block MCP clients surface to the model before the tool list. */
export function serverInstructions(loggedIn: boolean): string {
  const groups = visibleTools().map((tool) => tool.toolset)
  const uniqueGroups = Array.from(new Set(groups))
  const lines = [
    'NeteaseCloudMusic tools. Song/album/artist/playlist ids are NetEase numeric ids.',
    loggedIn
      ? 'The user is signed in; account, library and write tools are available.'
      : 'The session is anonymous, so only public read tools will succeed. If a tool reports it needs login, ask the user to reconnect and sign in.',
    `Enabled toolset groups: ${uniqueGroups.join(', ')}.`,
    'Use ncm_search first to resolve names to ids, then the detail tools.',
    'Play URLs expire quickly; fetch them right before use and never cache them.',
  ]
  return lines.join('\n')
}

export function createServer(context: SessionContext): McpServer {
  const server = new McpServer(
    { name: 'netease-cloud-music', version: '1.0.0' },
    { instructions: serverInstructions(Boolean(context.jar.MUSIC_U)) },
  )

  const runtime: ToolRuntime = {
    jar: context.jar,
    fakeIp: context.fakeIp,
    userId: context.userId,
    nickname: context.nickname,
    scope: context.scope,
  }

  for (const tool of visibleTools()) {
    const config = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: tool.annotations,
      ...(tool.requiresWrite ? { scopeChallenge: WRITE_CHALLENGE } : {}),
    } as never

    server.registerTool(tool.name, config, (async (args: unknown) =>
      runTool(tool, args, runtime)) as never)
  }

  return server
}
