import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { SCOPES, publicOrigin } from '@/lib/config'
import { TOOLSETS, TOOL_COUNT, toolsetCounts } from '@/lib/mcp/registry'

export const dynamic = 'force-dynamic'

const ENDPOINTS = [
  { path: '/mcp', purpose: 'MCP Streamable HTTP endpoint (Bearer token required)' },
  { path: '/.well-known/oauth-protected-resource/mcp', purpose: 'RFC 9728 protected resource metadata' },
  { path: '/.well-known/oauth-authorization-server', purpose: 'RFC 8414 authorization server metadata' },
  { path: '/register', purpose: 'Dynamic client registration (self-describing client_id)' },
  { path: '/authorize', purpose: 'Login entry point for QR / SMS / password sign-in' },
  { path: '/token', purpose: 'Authorization code and refresh token grants' },
]

const FLOW = [
  'Client posts to /mcp without a token → 401 with WWW-Authenticate',
  'Client discovers PRM, then the authorization server, then registers (or uses CIMD)',
  'Browser opens /authorize; you scan the QR, or use SMS / password',
  'NetEase sets MUSIC_U; the cookie jar is sealed into a 60-second code',
  'Client exchanges the code plus its PKCE verifier at /token',
  'The access token carries the jar; every /mcp call decrypts it and replays it upstream',
]

export default function Home() {
  const origin = publicOrigin()
  const counts = toolsetCounts()

  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-20">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              <path d="M12 3v9" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">NeteaseCloudMusic MCP</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Stateless Model Context Protocol server for the NetEase Cloud Music API, with a
              built-in OAuth 2.1 authorization server.
            </p>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap gap-2">
          <Badge variant="secondary">{TOOL_COUNT} tools</Badge>
          <Badge variant="secondary">{TOOLSETS.length} toolsets</Badge>
          <Badge variant="secondary">451 endpoints proxied</Badge>
          <Badge variant="secondary">PKCE · CIMD · stateless DCR</Badge>
          <Badge variant="secondary">zero server-side state</Badge>
        </div>

        <section className="mt-12">
          <h2 className="text-sm font-semibold">Connect a client</h2>
          <Card className="mt-3">
            <CardContent className="space-y-3 pt-6">
              <div>
                <p className="text-xs text-muted-foreground">Streamable HTTP endpoint</p>
                <code className="mt-1 block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {origin}/mcp
                </code>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The server answers <code className="font-mono">401</code> and the client runs OAuth
                automatically. Sign-in happens in your browser: the NetEase session is sealed inside
                the MCP access token and never stored on the server.
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">Endpoints</h2>
          <Card className="mt-3 overflow-hidden">
            <div className="divide-y">
              {ENDPOINTS.map((entry) => (
                <div key={entry.path} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
                  <code className="shrink-0 font-mono text-xs text-foreground">{entry.path}</code>
                  <span className="text-xs text-muted-foreground">{entry.purpose}</span>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Toolsets</h2>
            <span className="text-xs text-muted-foreground">{TOOL_COUNT} tools total</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLSETS.map((entry) => (
              <Card key={entry.name}>
                <CardHeader className="gap-1 pb-3">
                  <CardTitle className="flex items-center justify-between text-sm">
                    {entry.title}
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {counts[entry.name]}
                    </span>
                  </CardTitle>
                  <CardDescription className="text-xs">{entry.blurb}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Restrict the surface with <code className="font-mono">NCM_TOOLSETS</code>, for example{' '}
            <code className="font-mono">NCM_TOOLSETS=search,music,discover</code>. Write tools also
            need the <code className="font-mono">{SCOPES.write}</code> scope.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">How the stateless login works</h2>
          <Card className="mt-3">
            <CardContent className="pt-6">
              <ol className="space-y-2">
                {FLOW.map((step, index) => (
                  <li key={step} className="flex gap-3 text-xs text-muted-foreground">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-foreground">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </section>

        <Separator className="mt-12" />
        <footer className="pt-6 text-xs text-muted-foreground">
          Data comes from the unofficial NetEase Cloud Music API. Use it with an account you own,
          and respect NetEase&apos;s terms of service.
        </footer>
      </div>
    </main>
  )
}
