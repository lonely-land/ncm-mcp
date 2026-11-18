import { callNcm } from '@/lib/ncm/client'
import { type CookieJar, parseSetCookie } from '@/lib/ncm/cookies'

export interface LoginOutcome {
  ok: boolean
  message: string
  jar?: CookieJar
  userId?: number
  nickname?: string
  code?: number
}

function describeFailure(body: any, fallback: string): string {
  const code = body?.code
  const message = body?.message ?? body?.msg
  if (message && typeof message === 'string') return message
  switch (code) {
    case 501:
      return 'Account does not exist'
    case 502:
      return 'Wrong password'
    case 503:
      return 'Too many attempts, try later'
    case 400:
      return 'Bad request (check the phone number and country code)'
    case 8810:
      return 'Login requires a captcha'
    default:
      return fallback
  }
}

function successOutcome(body: any, jar: CookieJar): LoginOutcome {
  return {
    ok: true,
    message: 'Signed in',
    jar,
    userId: body?.account?.id ?? body?.profile?.userId,
    nickname: body?.profile?.nickname,
    code: body?.code,
  }
}

/**
 * Poll a QR key. `801` waiting, `802` scanned-but-unconfirmed, `800` expired,
 * `803` authorised. Only `803` carries the session cookies.
 *
 * Note: the upstream `login_qr_check` module has a bug in its catch block (it
 * references an out-of-scope `result`), so an upstream error surfaces as
 * `ReferenceError: result is not defined`. Treated here as a transient failure rather
 * than letting it reach the user as a crash.
 */
export async function pollQr(key: string, fakeIp?: string): Promise<{
  status: number
  message: string
  outcome?: LoginOutcome
}> {
  const result = await callNcm('login_qr_check', { key }, { fakeIp })
  const code = Number(result.body?.code ?? 0)
  const jar = result.jar ?? parseSetCookie(undefined)

  switch (code) {
    case 800:
      return { status: 800, message: 'QR code expired, refresh to get a new one' }
    case 801:
      return { status: 801, message: 'Waiting for scan' }
    case 802:
      return { status: 802, message: 'Scanned, confirm on your phone' }
    case 803:
      if (!jar.MUSIC_U) {
        return { status: 803, message: 'Authorised but no session cookie was returned' }
      }
      return { status: 803, message: 'Signed in', outcome: successOutcome(result.body, jar) }
    default: {
      const upstream = String(result.body?.message ?? result.body?.msg ?? '')
      const riskGated = /验证|captcha|verify/i.test(upstream)
      if (/result is not defined/i.test(upstream)) {
        // Upstream threw before returning a status; the QR key is normally still valid,
        // so keep polling rather than failing the sign-in.
        return { status: 801, message: 'Waiting for scan' }
      }
      if (riskGated) {
        return {
          status: 400,
          message:
            'NetEase asked for human verification. Request a new QR code, or switch to SMS / password sign-in.',
        }
      }
      return { status: code, message: describeFailure(result.body, 'QR login failed') }
    }
  }
}

export async function loginWithPassword(
  phone: string,
  password: string,
  countryCode = '86',
  fakeIp?: string,
): Promise<LoginOutcome> {
  const isEmail = phone.includes('@')
  const result = isEmail
    ? await callNcm('login', { email: phone, password }, { fakeIp })
    : await callNcm('login_cellphone', { phone, password, countrycode: countryCode }, { fakeIp })

  const jar = result.jar ?? {}
  if (!result.ok || !jar.MUSIC_U) {
    return { ok: false, message: describeFailure(result.body, 'Login failed'), code: result.body?.code }
  }
  return successOutcome(result.body, jar)
}

export async function loginWithCaptcha(
  phone: string,
  captcha: string,
  countryCode = '86',
  fakeIp?: string,
): Promise<LoginOutcome> {
  const result = await callNcm(
    'login_cellphone',
    { phone, captcha, countrycode: countryCode },
    { fakeIp },
  )
  const jar = result.jar ?? {}
  if (!result.ok || !jar.MUSIC_U) {
    return { ok: false, message: describeFailure(result.body, 'Login failed'), code: result.body?.code }
  }
  return successOutcome(result.body, jar)
}

export async function sendCaptcha(phone: string, countryCode = '86', fakeIp?: string): Promise<LoginOutcome> {
  const result = await callNcm(
    'captcha_sent',
    { phone, ctcode: countryCode },
    { fakeIp },
  )
  if (!result.ok || Number(result.body?.code) !== 200) {
    return {
      ok: false,
      message: describeFailure(result.body, 'Could not send the verification code'),
      code: result.body?.code,
    }
  }
  return { ok: true, message: 'Verification code sent' }
}

export async function startQrLogin(fakeIp?: string): Promise<{
  ok: boolean
  key?: string
  qrUrl?: string
  qrImage?: string
  message?: string
}> {
  const keyResult = await callNcm('login_qr_key', { noCookie: true }, { fakeIp })
  const key = keyResult.body?.data?.unikey
  if (!key) {
    return { ok: false, message: describeFailure(keyResult.body, 'Could not create a QR code') }
  }

  const imageResult = await callNcm(
    'login_qr_create',
    { key, qrimg: true, platform: 'web' },
    { fakeIp },
  )
  const data = imageResult.body?.data
  return {
    ok: true,
    key,
    qrUrl: data?.qrurl,
    qrImage: data?.qrimg,
    message: 'Scan with the NetEase Cloud Music app',
  }
}
