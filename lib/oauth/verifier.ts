import type { AuthInfo } from '@modelcontextprotocol/server'
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import { jwtDecrypt } from 'jose'

import { TOKEN_TTL_SECONDS, mcpResourceUrl, publicOrigin, tokenSecret } from '@/lib/config'
import { openAccessToken } from '@/lib/oauth/tokens'

/**
 * Verifies the JWE access token this server issues. No key lookup and no network call:
 * the token is self-contained, which is what makes the whole endpoint stateless.
 */
export const accessTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await openAccessToken(token)
    if (!payload) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token')
    }

    // Read `exp` straight off the JWE so the SDK enforces the real lifetime rather than
    // a value invented here.
    let expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    try {
      const { payload: claims } = await jwtDecrypt(token, tokenSecret(), {
        issuer: publicOrigin(),
        clockTolerance: 5,
      })
      if (typeof claims.exp === 'number') expiresAt = claims.exp
    } catch {
      // openAccessToken already validated it; keep the fallback.
    }

    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scope.split(' ').filter(Boolean),
      expiresAt,
      resource: mcpResourceUrl(),
      extra: {
        jar: payload.jar,
        userId: payload.userId,
        nickname: payload.nickname,
        sessionExpiresAt: payload.sessionExpiresAt,
      },
    }
  },
}
