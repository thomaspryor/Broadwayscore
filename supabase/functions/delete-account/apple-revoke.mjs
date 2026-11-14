/**
 * Sign in with Apple token revocation for account deletion (App Review
 * Guideline 5.1.1(v): apps offering Sign in with Apple must revoke the user's
 * tokens through the REST API when the account is deleted). BRO-6290.
 *
 * Flow: the iOS app re-authenticates with Apple right before deleting and
 * sends the fresh authorizationCode (valid 5 minutes, single use). We trade it
 * at /auth/token for a refresh_token, then revoke that at /auth/revoke, which
 * ends the app's Apple grant for this user.
 *
 * Plain ESM with WebCrypto + fetch only, so Deno (the edge function) and Node
 * (tests/unit/apple-revoke.test.mjs) both import this same file.
 */

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_TEAM_ID = '2837Q6TK6Y';
// Must name the key in APPLE_PRIVATE_KEY (the GitHub secret supabase-functions.yml
// copies into the function secrets). Rotating that key means changing this id
// in the same commit; rotate-apple-secret.yml hardcodes it too.
export const APPLE_KEY_ID = '3TBDNTHCD2';
// The iOS bundle id: a native authorizationCode is issued to it, so the code
// exchange must use it as client_id (the web services id would be rejected).
export const APPLE_APP_CLIENT_ID = 'com.broadwayscorecard.app';

// One budget for both Apple round trips, body reads included.
const REVOKE_TIMEOUT_MS = 10000;

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** PKCS#8 PEM (the .p8 Apple hands out) to DER bytes. Tolerates the key
 *  having been stored with literal "\n" escapes instead of newlines. */
function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

/**
 * ES256 client secret JWT for Apple's token endpoints. WebCrypto's ECDSA
 * signature is already the raw r||s form JWS wants. Short-lived on purpose:
 * it is built per request and never stored.
 */
export async function makeAppleClientSecret({
  privateKeyPem,
  teamId = APPLE_TEAM_ID,
  keyId = APPLE_KEY_ID,
  clientId = APPLE_APP_CLIENT_ID,
  now = Math.floor(Date.now() / 1000),
}) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const input =
    b64urlJson({ alg: 'ES256', kid: keyId, typ: 'JWT' }) +
    '.' +
    b64urlJson({ iss: teamId, iat: now, exp: now + 300, aud: APPLE_ISSUER, sub: clientId });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

function postForm(fetchImpl, url, params, signal) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
}

/** The `sub` claim of Apple's id_token. It came straight from Apple over
 *  TLS in the token response, so it is read, not signature-checked. */
function idTokenSub(idToken) {
  try {
    const payload = JSON.parse(atob(String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

async function appleError(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // fall through to the status
  }
  return `http_${res.status}`;
}

/**
 * Exchange the authorizationCode for a refresh_token, then revoke it.
 * Never throws: returns { revoked: true } or { revoked: false, reason } so
 * the caller can log it without ever blocking the deletion on Apple.
 * reason 'token_invalid_client' means the key cannot sign for clientId
 * (needs a key enabled for the app's App ID).
 *
 * appleUserIds: the Apple subject ids of the account being deleted. The
 * revoke only goes ahead when the code belongs to one of them, so a caller
 * can never use their own deletion to revoke someone else's Apple grant.
 */
export async function revokeAppleAuthorization({
  authorizationCode,
  appleUserIds,
  privateKeyPem,
  clientId = APPLE_APP_CLIENT_ID,
  fetchImpl = fetch,
  timeoutMs = REVOKE_TIMEOUT_MS,
  now,
}) {
  if (typeof authorizationCode !== 'string' || !authorizationCode) return { revoked: false, reason: 'no_code' };
  if (!Array.isArray(appleUserIds) || appleUserIds.length === 0) return { revoked: false, reason: 'no_apple_identity' };
  if (!privateKeyPem) return { revoked: false, reason: 'not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const clientSecret = await makeAppleClientSecret({ privateKeyPem, clientId, now });

    const tokenRes = await postForm(
      fetchImpl,
      `${APPLE_ISSUER}/auth/token`,
      { client_id: clientId, client_secret: clientSecret, code: authorizationCode, grant_type: 'authorization_code' },
      ctrl.signal,
    );
    if (!tokenRes.ok) return { revoked: false, reason: `token_${await appleError(tokenRes)}` };
    const tokens = await tokenRes.json();
    if (!appleUserIds.includes(idTokenSub(tokens.id_token))) return { revoked: false, reason: 'sub_mismatch' };
    // Apple only returns refresh_token on the first exchange of a code; fall
    // back to the access_token, which revoke also accepts.
    const token = tokens.refresh_token || tokens.access_token;
    const hint = tokens.refresh_token ? 'refresh_token' : 'access_token';
    if (!token) return { revoked: false, reason: 'token_missing' };

    // The code is single use, so this token is the only chance to revoke:
    // one retry when Apple answers 5xx or the connection drops.
    const revokeParams = { client_id: clientId, client_secret: clientSecret, token, token_type_hint: hint };
    let revokeRes;
    try {
      revokeRes = await postForm(fetchImpl, `${APPLE_ISSUER}/auth/revoke`, revokeParams, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) throw e;
    }
    if (!revokeRes || revokeRes.status >= 500) {
      revokeRes = await postForm(fetchImpl, `${APPLE_ISSUER}/auth/revoke`, revokeParams, ctrl.signal);
    }
    if (!revokeRes.ok) return { revoked: false, reason: `revoke_${await appleError(revokeRes)}` };
    return { revoked: true };
  } catch (e) {
    return { revoked: false, reason: ctrl.signal.aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}
