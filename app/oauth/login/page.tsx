import { LoginScreen } from '@/app/oauth/login-screen'
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

  if (params.error) {
    return (
      <LoginScreen
        clientName={params.client ?? 'this client'}
        scope={params.scope ?? ''}
        error={{ code: params.error, message: params.message ?? 'The authorization request was rejected.' }}
      />
    )
  }

  const authz = await readAuthzCookie()
  if (!authz) {
    return (
      <LoginScreen
        clientName={params.client ?? 'this client'}
        scope={params.scope ?? ''}
        error={{
          code: 'session_expired',
          message:
            'This sign-in link has expired or the cookie was lost. Close this tab and reconnect from your MCP client.',
        }}
      />
    )
  }

  return <LoginScreen clientName={params.client ?? 'an MCP client'} scope={authz.scope} />
}
