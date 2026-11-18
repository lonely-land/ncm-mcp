import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server'

import { ALL_SCOPES, mcpResourceUrl, publicOrigin } from '@/lib/config'

export function oauthMetadata(): OAuthMetadata {
  const origin = publicOrigin()
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ALL_SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: `${origin}/`,
  }
}

export function protectedResourceMetadata(): OAuthProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl().href,
    authorization_servers: [publicOrigin()],
    scopes_supported: ALL_SCOPES,
    resource_name: 'NeteaseCloudMusic MCP',
    resource_documentation: `${publicOrigin()}/`,
    bearer_methods_supported: ['header'],
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

export function oauthError(
  error: string,
  description: string,
  status = 400,
  headers?: HeadersInit,
): Response {
  return jsonResponse({ error, error_description: description }, status, headers)
}
