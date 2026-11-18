# NeteaseCloudMusic MCP

A **stateless** Model Context Protocol server for the [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) project, designed to run on Vercel. It is its own OAuth 2.1 authorization server: your MCP client registers itself, opens a login page where you scan a QR code (or use an SMS code or password), and the resulting NetEase session is sealed inside the MCP access token.

Because the session lives in the token rather than in a database, **this deployment stores no user data at rest.** Any instance can serve any request.

- 86 curated tools across 8 toolsets, plus `ncm_raw` for the 451 underlying endpoints (account-identity and money-spending ones excluded)
- QR / SMS / password sign-in, all through the same OAuth flow
- PKCE (S256), RFC 9728 protected resource metadata, RFC 8414 authorization server metadata
- Client ID Metadata Documents (CIMD) and stateless dynamic client registration
- Client IP forwarded to NetEase as the per-caller "FakeIP"

---

## How it works

```mermaid
sequenceDiagram
    participant C as MCP client
    participant M as /mcp
    participant A as /authorize
    participant B as Browser
    participant T as /token
    participant N as NetEase

    C->>M: tools/list (no token)
    M-->>C: 401 + WWW-Authenticate
    C->>M: GET PRM, AS metadata
    C->>A: /authorize?client_id&code_challenge&resource
    A-->>B: login page (sealed authz cookie)
    B->>N: QR / SMS / password
    N-->>B: MUSIC_U cookie jar
    B->>A: /api/auth/complete
    A-->>C: 302 redirect_uri?code=…&state=…&iss=…
    C->>T: POST code + code_verifier
    T-->>C: access_token (JWE, carries the jar)
    C->>M: tools/call (Bearer JWE)
    M->>N: upstream call with jar + FakeIP
```

Every piece of state is a compact JWE (`dir` + `A256GCM`) sealed with `NCM_TOKEN_SECRET`:

| Token | Lifetime | Contents |
| --- | --- | --- |
| authz request cookie | 10 min | client, redirect URI, scope, PKCE challenge, state |
| authorization code | 60 s | the above + the sealed NetEase cookie jar |
| access token | 1 h | scope, cookie jar, uid, session expiry |
| refresh token | 30 d | same, extendable up to `NCM_SESSION_MAX_AGE_SECONDS` |
| client id (DCR) | 1 y | redirect URIs, client name, grant types |

---

## Deploy

```bash
npm install
npm run build
```

Set these in the Vercel project, then deploy:

| Variable | Required | Notes |
| --- | --- | --- |
| `NCM_TOKEN_SECRET` | yes | 16+ chars; `openssl rand -base64 32` |
| `NCM_TOOLSETS` | no | e.g. `search,music,discover`; default `all` |
| `NCM_DISABLED_TOOLS` | no | tool names to hide, e.g. `ncm_listen_stats,ncm_yunbei`; empty by default (see [Tool denylist](#tool-denylist)) |
| `NCM_BLOCKED_RAW_ENDPOINTS` | no | endpoints `ncm_raw` refuses, e.g. `digitalAlbum_ordering`; default blocks identity mutation and money-spending endpoints (see [Raw endpoint blocklist](#raw-endpoint-blocklist)) |
| `MCP_PUBLIC_ORIGIN` | no | only for a custom domain |
| `NCM_FALLBACK_RANDOM_CN_IP` | no | see [FakeIP](#fakeip) |

`vercel.json` pins the `hkg1` / `sin1` regions, which keeps NetEase latency low.

---

## Connect a client

Point the client at `https://<your-deployment>/mcp`. Nothing else is needed: the server answers `401`, and the client discovers the rest.

The landing page, the login page and the OAuth/login error messages follow the browser's `Accept-Language` (`en` and `zh-CN`). No language framework is involved: a typed dictionary in `lib/i18n/` is resolved per request, an `ncm_locale` cookie wins over the header when present, and unknown languages fall back to English.

`GET /healthz` is an unauthenticated liveness probe for uptime monitors. It returns `{"status":"ok","uptime":…,"version":…}` and deliberately touches neither NetEase cookies nor the upstream API, so it stays green while NetEase is unreachable.

**Claude Code / Cursor / VS Code** — add an HTTP MCP server:

```json
{
  "mcpServers": {
    "netease-cloud-music": {
      "type": "http",
      "url": "https://<your-deployment>/mcp"
    }
  }
}
```

On first use the client opens a browser tab. Sign in, and the tab closes itself. If your client does not support OAuth, drive the flow with the Inspector:

```bash
npx @modelcontextprotocol/inspector --cli https://<your-deployment>/mcp --transport http \
  --method tools/list
```

---

## Tools

| Toolset | Tools | What it covers |
| --- | --- | --- |
| `account` | 10 | login state, profile, listener level, follow counts/lists, VIP, daily check-in, logout |
| `search` | 8 | songs/albums/artists/playlists/MV/user search, cloud index, suggestions, hot searches, lyric search |
| `discover` | 12 | daily recommendations, personalised playlists, toplists, banners, new releases, release calendar |
| `music` | 20 | song detail, play/download URLs, lyrics, similar songs, albums, artists, playlists, MV |
| `library` | 17 | likes, scrobble, recent plays, playlist CRUD, cloud music, download list, listening stats |
| `comments` | 6 | read/post/delete/like/reply on songs, albums, playlists, MV, radio |
| `social` | 10 | follow users, subscribe artists/MV/radio, DMs, activity feed, share |
| `meta` | 3 | `ncm_list_endpoints`, `ncm_raw`, `ncm_about` |

Counts are the registered totals; `NCM_DISABLED_TOOLS` may hide some of them, and `NCM_TOOLSETS` may drop whole groups.

`ncm_raw` reaches all 451 endpoints, minus the [blocked ones](#raw-endpoint-blocklist). Read-only endpoints are always allowed; any other endpoint needs the `ncm:write` scope, and without it the call returns an error asking the caller to acquire that scope — it does not run a step-up challenge. Only the curated write tools (`scopeChallenge` on registration) take the step-up path.

### Tool denylist

`NCM_DISABLED_TOOLS` takes a comma-separated list of tool names and subtracts them from whatever `NCM_TOOLSETS` enables. A denied tool never appears in `tools/list` and has no registered handler, so calling it by name fails. Unknown names are ignored with a single startup warning rather than an error.

The default is **empty** (`DEFAULT_DISABLED_TOOLS` in `lib/config.ts`), because no curated tool touches account personal info or session identity — the curated set has nothing to ban. The switch exists so an operator can still hide wrappers they do not want, and it is exported so it stays discoverable and testable. Setting the variable replaces the default entirely; `NCM_DISABLED_TOOLS=` (empty) disables nothing.

All curated writes stay enabled by design: follow, like, comment, share, scrobble, cloud upload, and playlist create/delete/remove/add/reorder/rename.

### Raw endpoint blocklist

`ncm_raw` proxies upstream endpoints directly, so it was the route left to the two things the curated tool set deliberately never touches. `NCM_BLOCKED_RAW_ENDPOINTS` closes it, for exactly two reasons:

**Identity mutation** — `user_update`, `avatar_upload`, `setting`, `user_social_status_edit`, `rebind`, `user_replacephone`, `user_bindingcellphone`, `activate_init_profile`, `nickname_check`, `logout`, `device_kickoff`, and every `login*`, `register*` and `captcha*` endpoint.

**Spends money** — `dj_paygift` (radio gifting), `dj_toplist_pay` (paid chart placement), `yunbei_expense` (coin spend), `digitalAlbum_ordering` (digital album purchase).

A blocked endpoint is rejected by name before any upstream call, and is omitted from `ncm_list_endpoints` (whose header reports how many are hidden).

Everything else stays reachable: the playlist, comment, like, follow, share, scrobble and cloud-upload writes, `yunbei_sign`-style earns, the purchase *history* reads (`digitalAlbum_purchased`, `song_purchased`, `digitalAlbum_sales`, `yunbei`, `yunbei_info`, `yunbei_receipt`, `vip_*`), and the download-URL endpoints (`song_download_url`, `song_download_url_v1`, `song_cloud_download`), which return URLs without charging.

Unset uses `DEFAULT_BLOCKED_RAW_ENDPOINTS` from `lib/config.ts`; a set variable replaces it, and `NCM_BLOCKED_RAW_ENDPOINTS=` blocks nothing.

The trade-off, stated exactly: identity mutation and spending are blocked **only through `ncm_raw`**, and curated writes stay open by design. The two switches are independent — `NCM_DISABLED_TOOLS=` clears the (already empty) tool denylist and leaves the raw blocklist fully in force; only clearing `NCM_BLOCKED_RAW_ENDPOINTS` re-exposes those endpoints. And because the blocklist gates the transport, a tool name in `NCM_DISABLED_TOOLS` is still reachable through a *different* unblocked raw endpoint if one wraps the same upstream call — that is accepted, since `ncm_raw` is a deliberate escape hatch and the wrappers are what a model reaches for unprompted.

### Scopes

- `ncm:read` — every read tool. Always granted.
- `ncm:write` — anything that changes account state (likes, playlists, comments, follows). Request it in the authorize call, or let the client step up when a write tool returns `insufficient_scope`.

### FakeIP

The NetEase "FakeIP" here is **the IP your MCP client connected from**, read from `x-forwarded-for` and passed upstream as `realIP` (`X-Real-IP` / `X-Forwarded-For`). Using a stable, plausible client address reduces the chance of tripping region logic, and it keeps a single caller consistent across calls.

`NCM_FALLBACK_RANDOM_CN_IP=true` additionally falls back to a random Chinese IP when no forwarded address is present. Leave it off unless you deliberately want that.

---

## Verification

```bash
# 1. Start locally
NCM_TOKEN_SECRET=$(openssl rand -base64 32) npm run build && npm start

# 2. Full OAuth flow + a live tool call (44 assertions)
npm run e2e

# 3. Every read-only tool once
TOKEN=$(node scripts/oauth-e2e.mjs --print-token | grep ^ACCESS_TOKEN= | cut -d= -f2-)
NCM_SMOKE_TOKEN=$TOKEN npm run smoke
```

`scripts/oauth-e2e.mjs` drives discovery, DCR, PKCE authorize, code exchange, refresh, and authenticated `tools/call`. It uses a synthetic session jar so it runs unattended; set `NCM_E2E_JAR` to a real cookie string to exercise a live account.

### Known upstream limits

Some endpoints refuse anonymous sessions. `npm run smoke` reports these separately:

| Tool | Why |
| --- | --- |
| `ncm_recommend_resource` | requires a signed-in account |
| `ncm_similar_users` | requires a signed-in account |
| `ncm_music_calendar`, `ncm_lyric_mark`, `ncm_user_followeds` | upstream returns 301 for guest sessions |
| `ncm_similar_artists` | occasionally triggers NetEase's human-verification gate |

---

## Security notes

- No database, no session store, no cookies for end users beyond the short-lived sealed authz cookie.
- `Authorization` headers and cookie values are never logged. Upstream failures surface as generic messages.
- Access tokens carry the NetEase jar, so treat them like passwords. Short TTLs (1 h) bound exposure, and rotating `NCM_TOKEN_SECRET` revokes everything at once.
- Authorization codes are stateless, so replay protection is bounded by their 60-second TTL rather than a denylist. A stolen code still needs the PKCE verifier, which never leaves the client.
- The `/authorize` endpoint only accepts a `resource` matching this deployment, and only redirect URIs registered by the client (exact match, plus loopback-any-port per RFC 8252).

---

## Caveats

This proxies the unofficial NetEase Cloud Music API. Use it with an account you own and respect NetEase's terms of service. Endpoints, signatures and risk controls change without notice; the pinned `@neteasecloudmusicapienhanced/api` version is what has been tested.

The service is intended for personal use.
