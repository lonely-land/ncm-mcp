import type { NcmCallResult } from '@/lib/ncm/client'

/**
 * The account-id resolution policy, kept free of transport and caching so it can be
 * exercised without a network or a session store.
 *
 * Resolution order: the uid sealed into the access token, then whatever the upstream
 * session reports for the cookie jar, then an honest failure. Re-login is never advice:
 * the token's uid is captured once at login, so a token minted without one stays uid-less
 * and logging in again re-runs the same lossy capture.
 */

export type OwnUidResult =
  | { ok: true; uid: number; source: 'token' | 'upstream' }
  | { ok: false; message: string }

export const UID_DIAGNOSTIC =
  'To check the session, call ncm_raw with endpoint "user_account" (or the ncm_account_profile ' +
  'tool, which calls the same endpoint without needing ncm:write): it resolves the account from ' +
  'the MUSIC_U cookie and should return account.id / profile.userId.'

export async function resolveUid(input: {
  tokenUid: unknown
  lookupAccount: () => Promise<NcmCallResult>
}): Promise<OwnUidResult> {
  const fromToken = accountId(input.tokenUid)
  if (fromToken !== undefined) return { ok: true, uid: fromToken, source: 'token' }

  const result = await input.lookupAccount()
  if (!result.ok) {
    return {
      ok: false,
      message:
        'Could not resolve this session\u2019s account id: the access token carries no uid and ' +
        `the upstream user_account call failed (${failureDetail(result)}). ${UID_DIAGNOSTIC}`,
    }
  }

  const body = result.body ?? {}
  const fromUpstream = accountId(body?.profile?.userId) ?? accountId(body?.account?.id)
  if (fromUpstream !== undefined) return { ok: true, uid: fromUpstream, source: 'upstream' }

  return {
    ok: false,
    message:
      'No account id for this session: the access token carries no uid and the upstream session ' +
      'did not expose one — the user_account call returned no profile.userId or account.id for ' +
      `this cookie jar. ${UID_DIAGNOSTIC} If that call is empty too, the NetEase session behind ` +
      'this connection is no longer valid.',
  }
}

/** NetEase returns ids as either numbers or numeric strings; treat anything else as absent. */
function accountId(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

function failureDetail(result: NcmCallResult): string {
  const message = result.body?.message ?? result.body?.msg
  return message ? `${result.status}: ${String(message)}` : String(result.status)
}
