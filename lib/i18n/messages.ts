/**
 * Typed message dictionary. English is the source of truth for the shape; adding a
 * locale means adding one object that satisfies `Messages`, so a missing or extra
 * key is a type error rather than a silently untranslated string.
 */

export const LOCALES = ['en', 'zh-CN'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

const en = {
  meta: {
    title: 'NeteaseCloudMusic MCP',
    description:
      'A stateless Model Context Protocol server for the NetEase Cloud Music API, with a built-in OAuth 2.1 authorization server.',
  },
  home: {
    tagline:
      'A stateless MCP server for the NetEase Cloud Music API, with a built-in OAuth 2.1 authorization server.',
    pills: {
      tools: '{count} tools',
      stateless: 'Stateless — nothing stored at rest',
      oauth: 'OAuth 2.1 · PKCE',
    },
    endpoint: {
      title: 'MCP endpoint',
      label: 'Streamable HTTP',
      copy: 'Add this URL to your MCP client as an HTTP server. Unauthenticated calls answer 401 and the client runs OAuth automatically.',
    },
    features: {
      title: 'What you can do',
      items: [
        'Search songs, albums, artists, playlists, lyrics and radio',
        'Play and download URLs, lyrics, album and artist detail',
        'Daily recommendations, toplists, new releases and banners',
        'Your library: likes, playlists, cloud uploads, listening stats',
        'Comments, follows, subscriptions and account status',
      ],
    },
    auth: {
      title: 'Authorization',
      text: 'Sign-in happens in your browser through the built-in OAuth 2.1 server: QR code, SMS or password. The NetEase session is sealed inside the access token instead of a database.',
      linksTitle: 'Endpoints',
      signIn: 'Sign-in page',
      serverMetadata: 'Authorization server metadata',
      resourceMetadata: 'Protected resource metadata',
      health: 'Health check',
      scopes: 'Scopes: ncm:read is always granted; ncm:write unlocks anything that changes your account.',
    },
    footer:
      'Unofficial client for the NetEase Cloud Music API. Use it with an account you own and respect NetEase’s terms of service.',
  },
  login: {
    pageTitle: 'Sign in to NetEase Cloud Music',
    heading: 'Sign in to NetEase Cloud Music',
    unknownClient: 'an MCP client',
    subtitleBefore: 'wants to use your NetEase account through this MCP server.',
    scopes: 'Scopes',
    tabs: { qr: 'QR code', sms: 'SMS code', password: 'Password' },
    footer:
      'Your NetEase session is sealed inside the MCP access token and never stored on the server. Disconnecting the client revokes access.',
    errorScreen: {
      title: "Can't continue sign-in",
      descriptionBefore: 'The authorization request for',
      descriptionAfter: 'was rejected.',
      hint: 'Close this tab and start again from your MCP client. If it keeps failing, the client is sending a request this server does not accept.',
      fallback: 'The authorization request was rejected.',
    },
    qr: {
      imageAlt: 'NetEase sign-in QR code',
      generating: 'Generating QR code…',
      generatingShort: 'Generating…',
      unavailable: 'QR unavailable',
      title: 'Scan with the NetEase Cloud Music app',
      steps: [
        'Open the NetEase Cloud Music mobile app',
        'Tap Scan in the search bar',
        'Confirm the sign-in on your phone',
      ],
      waiting: 'Waiting for scan…',
      scanned: 'Scanned — confirm on your phone',
      expired: 'This QR code expired. Request a new one.',
      signedIn: 'Signed in — finishing…',
      createFailed: 'Could not create a QR code.',
      blocked: 'QR sign-in was blocked.',
      failed: 'QR sign-in failed.',
      retrying: 'Connection hiccup, retrying…',
      refresh: 'Get a new QR code',
      tryAgain: 'Try again',
    },
    sms: {
      phoneLabel: 'Phone number',
      phonePlaceholder: '13800000000',
      countryLabel: 'Country code',
      codeLabel: 'Verification code',
      codePlaceholder: '6 digits',
      send: 'Send code',
      submit: 'Sign in',
      sending: 'Sending…',
      sent: 'Verification code sent.',
      sendFailed: 'Could not send the code.',
      missing: 'Enter your phone number and the code.',
      signingIn: 'Signing in…',
      failed: 'Sign-in failed.',
    },
    password: {
      accountLabel: 'Phone number or email',
      accountPlaceholder: '13800000000 or you@example.com',
      countryLabel: 'Country code',
      passwordLabel: 'Password',
      submit: 'Sign in',
      missing: 'Enter your account and password.',
      signingIn: 'Signing in…',
      failed: 'Sign-in failed.',
    },
    client: {
      invalidJson: 'The server returned a response that is not valid JSON. Try again.',
      httpFailed: 'The server failed with HTTP {status}{detail}',
      rejected: 'The server rejected the request (HTTP {status}).',
      redirectFailed: 'Sign-in finished, but the redirect back to your client failed.',
      sessionExpired:
        'This sign-in link has expired or the cookie was lost. Close this tab and reconnect from your MCP client.',
    },
  },
  oauth: {
    unsupportedResponseType: 'Only response_type=code is supported.',
    clientIdRequired: 'This link is missing a client_id.',
    unknownClient: 'This client is not registered with this server.',
    redirectUriRequired: 'This link is missing a redirect_uri.',
    redirectUriNotRegistered: 'This redirect URI is not registered for this client.',
    pkceRequired: 'PKCE is required, but this link has no code_challenge.',
    pkceS256Only: 'Only code_challenge_method=S256 is supported.',
    invalidTarget: 'This server only issues tokens for {resource}.',
    bodyMustBeJson: 'Body must be JSON',
    redirectUrisRequired: 'redirect_uris must contain at least one URI',
    malformedRedirectUri: 'Malformed redirect_uri: {uri}',
    publicClientsOnly: 'Only public clients (token_endpoint_auth_method=none) are supported',
    codeRequired: 'code is required',
    codeVerifierRequired: 'code_verifier is required',
    codeInvalid: 'The authorization code is invalid or expired',
    codeClientMismatch: 'client_id does not match the authorization request',
    pkceFailed: 'PKCE verification failed',
    codeNoSession: 'The authorization code carries no NetEase session',
    refreshTokenRequired: 'refresh_token is required',
    refreshInvalid: 'The refresh token is invalid or expired',
    refreshClientMismatch: 'client_id does not match the refresh token',
    unsupportedGrantType: 'Supported grant types: authorization_code, refresh_token',
    tokenPostOnly: 'The token endpoint only accepts POST',
  },
  api: {
    bodyMustBeJson: 'Body must be JSON',
    phoneRequired: 'Phone number is required',
    phoneAndCodeRequired: 'Phone number and verification code are required',
    accountAndPasswordRequired: 'Account and password are required',
    keyRequired: 'key is required',
    sessionExpired: 'Login session expired. Close this tab and retry from your MCP client.',
    noSessionCookie: 'No NetEase session cookie was provided',
    crossOrigin: 'Cross-origin requests are not allowed',
    qrStatusFailed: 'Could not check the QR status: {detail}',
    qrStatusFailedShort: 'Could not check the QR status',
  },
}

export type Messages = typeof en

/** Keys of the protocol-level `error_description` dictionary. */
export type OAuthMessageKey = keyof Messages['oauth']

const zhCN: Messages = {
  meta: {
    title: '网易云音乐 MCP',
    description:
      '面向网易云音乐 API 的无状态 Model Context Protocol 服务器，内置 OAuth 2.1 授权服务器。',
  },
  home: {
    tagline: '面向网易云音乐 API 的无状态 MCP 服务器，内置 OAuth 2.1 授权服务器。',
    pills: {
      tools: '{count} 个工具',
      stateless: '无状态 · 不落地任何数据',
      oauth: 'OAuth 2.1 · PKCE',
    },
    endpoint: {
      title: 'MCP 端点',
      label: '流式 HTTP',
      copy: '把这个地址作为 HTTP 服务器填进你的 MCP 客户端。未认证请求返回 401，客户端会自动完成 OAuth。',
    },
    features: {
      title: '你可以做什么',
      items: [
        '搜索歌曲、专辑、歌手、歌单、歌词与电台',
        '播放与下载链接、歌词、专辑与歌手详情',
        '每日推荐、排行榜、新歌新碟与首页轮播',
        '你的音乐库：喜欢、歌单、云盘、听歌统计',
        '评论、关注、订阅与账号状态',
      ],
    },
    auth: {
      title: '授权方式',
      text: '登录通过内置的 OAuth 2.1 服务器在你的浏览器中完成：扫码、短信或密码。网易云会话被封进访问令牌，而不是存进数据库。',
      linksTitle: '端点',
      signIn: '登录页',
      serverMetadata: '授权服务器元数据',
      resourceMetadata: '受保护资源元数据',
      health: '健康检查',
      scopes: '权限范围：ncm:read 始终授予，ncm:write 用于会改变账号状态的调用。',
    },
    footer: '网易云音乐 API 的非官方客户端。请使用自己的账号，并遵守网易云音乐的服务条款。',
  },
  login: {
    pageTitle: '登录网易云音乐',
    heading: '登录网易云音乐',
    unknownClient: '一个 MCP 客户端',
    subtitleBefore: '想通过这台 MCP 服务器使用你的网易云账号。',
    scopes: '权限范围',
    tabs: { qr: '扫码', sms: '短信', password: '密码' },
    footer: '你的网易云会话被封进 MCP 访问令牌，服务器不会保存。断开客户端即可撤销访问。',
    errorScreen: {
      title: '无法继续登录',
      descriptionBefore: '来自',
      descriptionAfter: '的授权请求已被拒绝。',
      hint: '请关闭此页并从你的 MCP 客户端重新开始。如果一直失败，说明客户端发送了本服务器不接受的请求。',
      fallback: '授权请求已被拒绝。',
    },
    qr: {
      imageAlt: '网易云登录二维码',
      generating: '正在生成二维码…',
      generatingShort: '正在生成…',
      unavailable: '二维码不可用',
      title: '使用网易云音乐 App 扫码',
      steps: ['打开网易云音乐手机 App', '在搜索栏点击扫一扫', '在手机上确认登录'],
      waiting: '等待扫码…',
      scanned: '已扫码 — 请在手机上确认',
      expired: '二维码已过期，请重新获取。',
      signedIn: '登录成功 — 正在完成…',
      createFailed: '无法创建二维码。',
      blocked: '扫码登录被拦截。',
      failed: '扫码登录失败。',
      retrying: '网络波动，正在重试…',
      refresh: '换一张二维码',
      tryAgain: '重试',
    },
    sms: {
      phoneLabel: '手机号',
      phonePlaceholder: '13800000000',
      countryLabel: '国家/地区码',
      codeLabel: '验证码',
      codePlaceholder: '6 位数字',
      send: '发送验证码',
      submit: '登录',
      sending: '发送中…',
      sent: '验证码已发送。',
      sendFailed: '验证码发送失败。',
      missing: '请填写手机号和验证码。',
      signingIn: '正在登录…',
      failed: '登录失败。',
    },
    password: {
      accountLabel: '手机号或邮箱',
      accountPlaceholder: '13800000000 或 you@example.com',
      countryLabel: '国家/地区码',
      passwordLabel: '密码',
      submit: '登录',
      missing: '请填写账号和密码。',
      signingIn: '正在登录…',
      failed: '登录失败。',
    },
    client: {
      invalidJson: '服务器返回的内容不是合法 JSON，请重试。',
      httpFailed: '服务器请求失败，HTTP {status}{detail}',
      rejected: '服务器拒绝了这次请求（HTTP {status}）。',
      redirectFailed: '登录已完成，但跳回客户端失败。',
      sessionExpired: '这个登录链接已过期或 Cookie 丢失。请关闭此页并从你的 MCP 客户端重新连接。',
    },
  },
  oauth: {
    unsupportedResponseType: '仅支持 response_type=code。',
    clientIdRequired: '这个链接缺少 client_id。',
    unknownClient: '这个客户端未在本服务器注册。',
    redirectUriRequired: '这个链接缺少 redirect_uri。',
    redirectUriNotRegistered: '该 redirect_uri 未在此客户端注册。',
    pkceRequired: '必须使用 PKCE，但这个链接缺少 code_challenge。',
    pkceS256Only: '仅支持 code_challenge_method=S256。',
    invalidTarget: '此服务器只为 {resource} 签发令牌。',
    bodyMustBeJson: '请求体必须是 JSON',
    redirectUrisRequired: 'redirect_uris 至少需要包含一个地址',
    malformedRedirectUri: 'redirect_uri 格式不正确：{uri}',
    publicClientsOnly: '仅支持公共客户端（token_endpoint_auth_method=none）',
    codeRequired: '缺少 code',
    codeVerifierRequired: '缺少 code_verifier',
    codeInvalid: '授权码无效或已过期',
    codeClientMismatch: 'client_id 与授权请求不匹配',
    pkceFailed: 'PKCE 校验失败',
    codeNoSession: '授权码中不含网易云会话',
    refreshTokenRequired: '缺少 refresh_token',
    refreshInvalid: '刷新令牌无效或已过期',
    refreshClientMismatch: 'client_id 与刷新令牌不匹配',
    unsupportedGrantType: '支持的授权类型：authorization_code、refresh_token',
    tokenPostOnly: '令牌端点只接受 POST 请求',
  },
  api: {
    bodyMustBeJson: '请求体必须是 JSON',
    phoneRequired: '请填写手机号',
    phoneAndCodeRequired: '手机号和验证码均为必填',
    accountAndPasswordRequired: '账号和密码均为必填',
    keyRequired: '缺少 key',
    sessionExpired: '登录会话已过期。请关闭此页并从你的 MCP 客户端重试。',
    noSessionCookie: '未收到网易云会话 Cookie',
    crossOrigin: '不允许跨域请求',
    qrStatusFailed: '无法查询二维码状态：{detail}',
    qrStatusFailedShort: '无法查询二维码状态',
  },
}

const DICTIONARIES: Record<Locale, Messages> = {
  en,
  'zh-CN': zhCN,
}

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale]
}

/** Minimal `{name}` interpolation; the dictionary owns every visible string. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}
