import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { publicOrigin } from '@/lib/config'
import { TOOL_COUNT } from '@/lib/mcp/registry'
import { format, getMessages } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const { messages } = await getMessages()
  const t = messages.home
  const mcpUrl = `${publicOrigin()}/mcp`

  const links = [
    { href: '/.well-known/oauth-authorization-server', label: t.auth.serverMetadata },
    { href: '/.well-known/oauth-protected-resource/mcp', label: t.auth.resourceMetadata },
    { href: '/healthz', label: t.auth.health },
  ]

  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              <path d="M12 3v9" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {messages.meta.title}
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t.tagline}</p>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap gap-2">
          <Badge variant="secondary">{format(t.pills.tools, { count: TOOL_COUNT })}</Badge>
          <Badge variant="secondary">{t.pills.stateless}</Badge>
          <Badge variant="secondary">{t.pills.oauth}</Badge>
        </div>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{t.endpoint.title}</h2>
          <Card className="mt-3">
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">{t.endpoint.label}</p>
              <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">
                {mcpUrl}
              </code>
              <p className="text-xs leading-relaxed text-muted-foreground">{t.endpoint.copy}</p>
            </CardContent>
          </Card>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{t.features.title}</h2>
          <ul className="mt-3 space-y-2">
            {t.features.items.map((item) => (
              <li key={item} className="flex gap-2.5 text-xs text-muted-foreground">
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{t.auth.title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t.auth.text}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </div>
          <p className="mt-4 rounded-md border-l-2 border-primary bg-muted/50 py-2 pl-3 pr-3 text-xs leading-relaxed text-muted-foreground">
            {t.auth.scopes}
          </p>
        </section>

        <Separator className="mt-12" />
        <footer className="pt-6 text-xs text-muted-foreground">{t.footer}</footer>
      </div>
    </main>
  )
}
