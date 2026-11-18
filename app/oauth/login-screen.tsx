'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2, Music4, RefreshCw, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Phase = 'idle' | 'busy' | 'done'

/** Shared sizing so inputs and inline buttons line up on every breakpoint. */
const FIELD = 'h-10 border-border/80 bg-muted/40'
const FIELD_BUTTON = 'h-10 px-3.5'

interface QrState {
  key: string
  image: string
}

export interface LoginScreenProps {
  clientName: string
  scope: string
  error?: { code: string; message: string }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  })
  const text = await response.text()

  // A platform-level failure (function crashed, protection page, HTML error page)
  // does not answer with our JSON envelope. Say so plainly instead of surfacing a
  // parse error or a bare status code — this is what made a packaging bug look like
  // "Unexpected server response (500)".
  let parsed: T
  try {
    parsed = JSON.parse(text) as T
  } catch {
    const detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(
      response.ok
        ? 'The server returned a response that is not valid JSON. Try again.'
        : `The server failed with HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
    )
  }

  if (!response.ok) {
    const message = (parsed as { message?: string })?.message
    throw new Error(message ?? `The server rejected the request (HTTP ${response.status}).`)
  }
  return parsed
}

/** Hands the session jar to the server and follows the resulting client redirect. */
async function finishLogin(payload: Record<string, unknown>): Promise<void> {
  const data = await postJson<{ ok: boolean; redirect?: string; message?: string }>(
    '/api/auth/complete',
    payload,
  )
  if (!data.ok || !data.redirect) {
    throw new Error(data.message ?? 'Sign-in finished, but the redirect back to your client failed.')
  }
  window.location.replace(data.redirect)
}export function LoginScreen({ clientName, scope, error }: LoginScreenProps) {
  if (error) return <ErrorScreen clientName={clientName} error={error} />
  return <LoginForm clientName={clientName} scope={scope} />
}

function LoginForm({ clientName, scope }: { clientName: string; scope: string }) {
  return (
    <Shell clientName={clientName} scope={scope}>
      <Tabs defaultValue="qr" className="gap-5">
        <TabsList className="w-full">
          <TabsTrigger value="qr">QR code</TabsTrigger>
          <TabsTrigger value="sms">SMS code</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
        </TabsList>
        <TabsContent value="qr" keepMounted>
          <QrPanel />
        </TabsContent>
        <TabsContent value="sms" keepMounted>
          <SmsPanel />
        </TabsContent>
        <TabsContent value="password" keepMounted>
          <PasswordPanel />
        </TabsContent>
      </Tabs>
    </Shell>
  )
}

function Shell({
  clientName,
  scope,
  children,
}: {
  clientName: string
  scope: string
  children: React.ReactNode
}) {
  const scopes = scope.split(' ').filter(Boolean)
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-2 text-center">
          <div className="mx-auto mb-1 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Music4 className="size-5" aria-hidden="true" />
          </div>
          <CardTitle className="text-lg">Sign in to NetEase Cloud Music</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{clientName}</span> wants to use your
            NetEase account through this MCP server.
          </CardDescription>
          {scopes.length > 0 ? (
            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground">Scopes:</span>
              {scopes.map((entry) => (
                <Badge key={entry} variant="secondary" className="font-mono text-[11px]">
                  {entry}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-0">{children}</CardContent>
        <div className="px-6 pb-6">
          <Separator className="mb-3" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Your NetEase session is sealed inside the MCP access token and never stored on the
            server. Disconnecting the client revokes access.
          </p>
        </div>
      </Card>
    </main>
  )
}

function ErrorScreen({
  clientName,
  error,
}: {
  clientName: string
  error: { code: string; message: string }
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-2">
          <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <TriangleAlert className="size-5" aria-hidden="true" />
          </div>
          <CardTitle className="text-lg">Can&apos;t continue sign-in</CardTitle>
          <CardDescription>
            The authorization request for <span className="font-medium text-foreground">{clientName}</span>{' '}
            was rejected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle className="font-mono text-xs">{error.code}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">
            Close this tab and start again from your MCP client. If it keeps failing, the client is
            sending a request this server does not accept.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}

function QrPanel() {
  const [qr, setQr] = useState<QrState | null>(null)
  const [status, setStatus] = useState<{ tone: 'muted' | 'warn' | 'ok' | 'error'; text: string }>({
    tone: 'muted',
    text: 'Generating QR code…',
  })
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const finished = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    finished.current = false
    setLoading(true)
    setQr(null)
    setStatus({ tone: 'muted', text: 'Generating QR code…' })

    postJson<{ ok: boolean; key?: string; qrImage?: string; message?: string }>(
      '/api/auth/qr/create',
      {},
    )
      .then((data) => {
        if (cancelled) return
        if (!data.ok || !data.key || !data.qrImage) {
          setLoading(false)
          setStatus({ tone: 'error', text: data.message ?? 'Could not create a QR code.' })
          return
        }
        setQr({ key: data.key, image: data.qrImage })
        setLoading(false)
        setStatus({ tone: 'muted', text: 'Waiting for scan…' })

        timer = setInterval(async () => {
          if (finished.current) return
          try {
            const poll = await postJson<{
              ok: boolean
              status?: number
              jar?: string
              userId?: number
              nickname?: string
              message?: string
            }>('/api/auth/qr/poll', { key: data.key })
            if (cancelled || finished.current) return

            if (poll.status === 801) {
              setStatus({ tone: 'muted', text: 'Waiting for scan…' })
              return
            }
            if (poll.status === 802) {
              setStatus({ tone: 'warn', text: 'Scanned — confirm on your phone' })
              return
            }
            if (poll.status === 800) {
              clearInterval(timer)
              setStatus({ tone: 'error', text: 'This QR code expired. Request a new one.' })
              return
            }
            if (poll.ok && poll.jar) {
              finished.current = true
              clearInterval(timer)
              setStatus({ tone: 'ok', text: 'Signed in — finishing…' })
              await finishLogin({
                jar: poll.jar,
                userId: poll.userId,
                nickname: poll.nickname,
              })
              return
            }
            if (poll.status === 400) {
              clearInterval(timer)
              setStatus({ tone: 'error', text: poll.message ?? 'QR sign-in was blocked.' })
              return
            }
            clearInterval(timer)
            setStatus({ tone: 'error', text: poll.message ?? 'QR sign-in failed.' })
          } catch {
            setStatus({ tone: 'warn', text: 'Connection hiccup, retrying…' })
          }
        }, 2000)
      })
      .catch((cause: Error) => {
        if (cancelled) return
        setLoading(false)
        setStatus({ tone: 'error', text: cause.message })
      })

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [reloadKey])

  const toneClass = {
    muted: 'text-muted-foreground',
    warn: 'text-amber-500',
    ok: 'text-emerald-500',
    error: 'text-destructive',
  }[status.tone]

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="mx-auto flex size-40 items-center justify-center overflow-hidden rounded-xl border border-border bg-white p-2.5">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr.image}
              alt="NetEase sign-in QR code"
              className="size-full"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center text-xs text-neutral-500">
              {loading ? (
                <>
                  <Loader2 className="size-5 animate-spin" />
                  <span>Generating…</span>
                </>
              ) : (
                <>
                  <AlertCircle className="size-5" />
                  <span>QR unavailable</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2.5">
          <p className="text-sm font-medium">Scan with the NetEase Cloud Music app</p>
          <ol className="space-y-1 text-xs text-muted-foreground">
            <li>1. Open the NetEase Cloud Music mobile app</li>
            <li>
              2. Tap <span className="font-medium text-foreground">Scan</span> in the search bar
            </li>
            <li>3. Confirm the sign-in on your phone</li>
          </ol>

          <p
            className={`flex items-start gap-1.5 text-xs ${toneClass}`}
            role="status"
            aria-live="polite"
          >
            {status.tone === 'ok' ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
            <span>{status.text}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw className="size-3.5" />
          Get a new QR code
        </Button>
        {status.tone === 'error' ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SmsPanel() {
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('86')
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [cooldown, setCooldown] = useState(0)
  const [status, setStatus] = useState<{ tone: 'muted' | 'ok' | 'error'; text: string }>({
    tone: 'muted',
    text: '',
  })

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const sendCode = useCallback(async () => {
    if (!phone.trim() || cooldown > 0) return
    setStatus({ tone: 'muted', text: 'Sending…' })
    try {
      const data = await postJson<{ ok: boolean; message?: string }>('/api/auth/sms/send', {
        phone: phone.trim(),
        countrycode: country.trim() || '86',
      })
      if (!data.ok) {
        setStatus({ tone: 'error', text: data.message ?? 'Could not send the code.' })
        return
      }
      setStatus({ tone: 'ok', text: 'Verification code sent.' })
      setCooldown(60)
    } catch (cause) {
      setStatus({ tone: 'error', text: (cause as Error).message })
    }
  }, [phone, country, cooldown])

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!phone.trim() || !code.trim()) {
        setStatus({ tone: 'error', text: 'Enter your phone number and the code.' })
        return
      }
      setPhase('busy')
      setStatus({ tone: 'muted', text: 'Signing in…' })
      try {
        const data = await postJson<{
          ok: boolean
          jar?: string
          userId?: number
          nickname?: string
          message?: string
        }>('/api/auth/sms/login', {
          phone: phone.trim(),
          countrycode: country.trim() || '86',
          captcha: code.trim(),
        })
        if (!data.ok || !data.jar) {
          setPhase('idle')
          setStatus({ tone: 'error', text: data.message ?? 'Sign-in failed.' })
          return
        }
        setPhase('done')
        setStatus({ tone: 'ok', text: 'Signed in — finishing…' })
        await finishLogin({ jar: data.jar, userId: data.userId, nickname: data.nickname })
      } catch (cause) {
        setPhase('idle')
        setStatus({ tone: 'error', text: (cause as Error).message })
      }
    },
    [phone, country, code],
  )

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="sms-phone">Phone number</Label>
        <div className="flex gap-2">
          <Input
            id="sms-country"
            aria-label="Country code"
            className={`w-[4.5rem] shrink-0 text-center tabular-nums ${FIELD}`}
            inputMode="numeric"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
          <Input
            id="sms-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="13800000000"
            className={`min-w-0 flex-1 ${FIELD}`}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sms-code">Verification code</Label>
        <div className="flex gap-2">
          <Input
            id="sms-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 digits"
            className={`min-w-0 flex-1 ${FIELD}`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            className={`shrink-0 tabular-nums ${FIELD_BUTTON}`}
            disabled={cooldown > 0 || !phone.trim()}
            onClick={sendCode}
          >
            {cooldown > 0 ? `${cooldown}s` : 'Send code'}
          </Button>
        </div>
      </div>

      <Button type="submit" className={`w-full ${FIELD_BUTTON}`} disabled={phase === 'busy'}>
        {phase === 'busy' ? <Loader2 className="size-4 animate-spin" /> : null}
        Sign in
      </Button>

      <StatusLine {...status} />
    </form>
  )
}

function PasswordPanel() {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [country, setCountry] = useState('86')
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState<{ tone: 'muted' | 'ok' | 'error'; text: string }>({
    tone: 'muted',
    text: '',
  })

  const isEmail = account.includes('@')

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!account.trim() || !password) {
        setStatus({ tone: 'error', text: 'Enter your account and password.' })
        return
      }
      setPhase('busy')
      setStatus({ tone: 'muted', text: 'Signing in…' })
      try {
        const data = await postJson<{
          ok: boolean
          jar?: string
          userId?: number
          nickname?: string
          message?: string
        }>('/api/auth/password/login', {
          account: account.trim(),
          password,
          countrycode: country.trim() || '86',
        })
        if (!data.ok || !data.jar) {
          setPhase('idle')
          setStatus({ tone: 'error', text: data.message ?? 'Sign-in failed.' })
          return
        }
        setPhase('done')
        setStatus({ tone: 'ok', text: 'Signed in — finishing…' })
        await finishLogin({ jar: data.jar, userId: data.userId, nickname: data.nickname })
      } catch (cause) {
        setPhase('idle')
        setStatus({ tone: 'error', text: (cause as Error).message })
      }
    },
    [account, password, country],
  )

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="account">Phone number or email</Label>
        <Input
          id="account"
          autoComplete="username"
          placeholder="13800000000 or you@example.com"
          className={FIELD}
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        />
      </div>

      {isEmail ? null : (
        <div className="space-y-2">
          <Label htmlFor="country">Country code</Label>
          <Input
            id="country"
            inputMode="numeric"
            className={FIELD}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          className={FIELD}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <Button type="submit" className={`w-full ${FIELD_BUTTON}`} disabled={phase === 'busy'}>
        {phase === 'busy' ? <Loader2 className="size-4 animate-spin" /> : null}
        Sign in
      </Button>

      <StatusLine {...status} />
    </form>
  )
}

function StatusLine({
  tone,
  text,
}: {
  tone: 'muted' | 'ok' | 'error'
  text: string
}) {
  if (!text) return null
  const toneClass = {
    muted: 'text-muted-foreground',
    ok: 'text-emerald-500',
    error: 'text-destructive',
  }[tone]
  return (
    <p className={`text-xs ${toneClass}`} role="status" aria-live="polite">
      {text}
    </p>
  )
}
