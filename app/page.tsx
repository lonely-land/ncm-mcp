import { SCOPES, publicOrigin } from '@/lib/config'
import { TOOLSETS, TOOL_COUNT, toolsetCounts } from '@/lib/mcp/registry'

export const dynamic = 'force-dynamic'

export default function Home() {
  const origin = publicOrigin()
  const counts = toolsetCounts()

  return (
    <div className="wrap">
      <div className="hero">
        <div className="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
            <path d="M12 3v9" />
          </svg>
        </div>
        <div>
          <h1>NeteaseCloudMusic MCP</h1>
          <p className="tagline">
            Stateless Model Context Protocol server for the NetEase Cloud Music API, with a built-in
            OAuth 2.1 authorization server.
          </p>
        </div>
      </div>

      <div className="pills">
        <span className="pill">
          <strong>{TOOL_COUNT}</strong> tools
        </span>
        <span className="pill">
          <strong>8</strong> toolsets
        </span>
        <span className="pill">
          <strong>451</strong> endpoints proxied
        </span>
        <span className="pill">PKCE + CIMD + stateless DCR</span>
        <span className="pill">zero server-side state</span>
      </div>

      <section>
        <h2>Connect a client</h2>
        <pre>
          <span className="c">{"# Streamable HTTP endpoint"}</span>
          {"\n"}
          {origin}
          <span className="k">/mcp</span>
          {"\n\n"}
          <span className="c">{"# The server answers 401 and the client runs OAuth automatically."}</span>
          {"\n"}
          <span className="c">{"# Login page offers QR, SMS and password sign-in."}</span>
        </pre>
        <div className="note">
          Sign-in happens in your browser. The resulting NetEase session cookie is sealed inside the
          MCP access token and never stored on the server, so this deployment keeps no user data at
          rest. Disconnecting the client is enough to revoke access.
        </div>
      </section>

      <section>
        <h2>
          Endpoints
          <span className="count">OAuth 2.1 discovery</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>/mcp</code>
              </td>
              <td>MCP Streamable HTTP endpoint (Bearer token required)</td>
            </tr>
            <tr>
              <td>
                <code>/.well-known/oauth-protected-resource/mcp</code>
              </td>
              <td>RFC 9728 protected resource metadata</td>
            </tr>
            <tr>
              <td>
                <code>/.well-known/oauth-authorization-server</code>
              </td>
              <td>RFC 8414 authorization server metadata</td>
            </tr>
            <tr>
              <td>
                <code>/register</code>
              </td>
              <td>Dynamic client registration (returns a self-describing client_id)</td>
            </tr>
            <tr>
              <td>
                <code>/authorize</code>
              </td>
              <td>Login page for QR / SMS / password sign-in</td>
            </tr>
            <tr>
              <td>
                <code>/token</code>
              </td>
              <td>Authorization code and refresh token grants</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>
          Toolsets
          <span className="count">{TOOL_COUNT} tools total</span>
        </h2>
        <div className="grid">
          {TOOLSETS.map((entry) => (
            <div className="card" key={entry.name}>
              <h3>
                {entry.title}
                <span className="n">{counts[entry.name]}</span>
              </h3>
              <p>{entry.blurb}</p>
            </div>
          ))}
        </div>
        <div className="note">
          Restrict the exposed surface with <code>NCM_TOOLSETS</code>, for example{' '}
          <code>NCM_TOOLSETS=search,music,discover</code> for a read-only browsing server. Write
          tools additionally require the <code>{SCOPES.write}</code> scope.
        </div>
      </section>

      <section>
        <h2>How the stateless login works</h2>
        <pre>
          <span className="k">1.</span> Client POSTs to <span className="s">/mcp</span> without a token → 401 +{" "}
          <span className="s">WWW-Authenticate</span>
          {"\n"}
          <span className="k">2.</span> Client discovers PRM → authorization server → registers (or uses CIMD)
          {"\n"}
          <span className="k">3.</span> Browser opens <span className="s">/authorize</span>; you scan the QR, or use
          SMS / password
          {"\n"}
          <span className="k">4.</span> NetEase sets <span className="s">MUSIC_U</span>; the cookie jar is sealed into
          a 60-second code
          {"\n"}
          <span className="k">5.</span> Client exchanges code + PKCE verifier at <span className="s">/token</span>
          {"\n"}
          <span className="k">6.</span> Access token embeds the jar; every <span className="s">/mcp</span> call decrypts
          it and replays it upstream
        </pre>
      </section>

      <footer>
        Data comes from the unofficial NetEase Cloud Music API. Use it with an account you own, and
        respect NetEase&apos;s terms of service.
      </footer>
    </div>
  )
}
