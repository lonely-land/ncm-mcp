import { LoginScreen } from '@/app/oauth/login-screen'
import { getMessages } from '@/lib/i18n'
import { readAuthzCookie } from '@/lib/oauth/authorize-flow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The visible login UI. `/authorize` validates the request and sets the sealed authz
 * cookie, then redirects here so the form can be built from React components.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; client?: string; scope?: string }>
}) {
  const params = await searchParams
  const { messages } = await getMessages()
  const clientName = params.client ?? messages.login.unknownClient

  if (params.error) {
    return (
      <LoginScreen
        messages={messages.login}
        clientName={clientName}
        scope={params.scope ?? ''}
        error={{ code: params.error, message: params.message ?? messages.login.errorScreen.fallback }}
      />
    )
  }

  const authz = await readAuthzCookie()
  if (!authz) {
    return (
      <LoginScreen
        messages={messages.login}
        clientName={clientName}
        scope={params.scope ?? ''}
        error={{ code: 'session_expired', message: messages.login.client.sessionExpired }}
      />
    )
  }

  return <LoginScreen messages={messages.login} clientName={clientName} scope={authz.scope} />
}
