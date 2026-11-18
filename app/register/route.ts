import { format, localeFromRequest, messagesFor } from '@/lib/i18n'
import { jsonResponse, oauthError } from '@/lib/oauth/server'
import { sealClientRegistration } from '@/lib/oauth/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RegistrationRequest {
  redirect_uris?: unknown
  client_name?: unknown
  grant_types?: unknown
  response_types?: unknown
  token_endpoint_auth_method?: unknown
}

const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token'])

/**
 * Dynamic client registration without storage: the issued `client_id` is itself a
 * sealed JWE describing the client, so any instance can validate it later.
 */
export async function POST(request: Request): Promise<Response> {
  const text = messagesFor(localeFromRequest(request)).oauth

  let body: RegistrationRequest
  try {
    body = (await request.json()) as RegistrationRequest
  } catch {
    return oauthError('invalid_client_metadata', text.bodyMustBeJson)
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (redirectUris.length === 0) {
    return oauthError('invalid_redirect_uri', text.redirectUrisRequired)
  }
  for (const uri of redirectUris) {
    try {
      new URL(uri)
    } catch {
      return oauthError(
        'invalid_redirect_uri',
        format(text.malformedRedirectUri, { uri }),
      )
    }
  }

  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types.filter(
        (entry): entry is string => typeof entry === 'string' && ALLOWED_GRANTS.has(entry),
      )
    : ['authorization_code', 'refresh_token']

  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return oauthError('invalid_client_metadata', text.publicClientsOnly)
  }

  const clientId = await sealClientRegistration({
    redirectUris,
    clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : undefined,
    grantTypes: grantTypes.length > 0 ? grantTypes : ['authorization_code'],
    tokenEndpointAuthMethod: 'none',
  })

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
      grant_types: grantTypes.length > 0 ? grantTypes : ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  )
}
