'use strict';

/**
 * BRO-3712: one-tap renewal of GMAIL_REFRESH_TOKEN, the Google OAuth grant
 * that finance-ingest.yml (vendor receipts + DMARC reports) reads Gmail with.
 * When Google revokes it, the owner taps one signed link and presses Allow;
 * everything after that is automatic:
 *
 *   1. GET /api/admin/gmail-reauth?e=<exp>&s=<sig>   (src/app/api/admin/gmail-reauth/route.ts)
 *      checks the signed link, sets a short-lived state + PKCE cookie and
 *      302s to Google's consent screen (gmail.readonly only).
 *   2. GET /api/admin/gmail-reauth/callback          (…/callback/route.ts)
 *      checks state against the cookie, seals {code, verifier} with
 *      APPROVAL_HMAC_SECRET and dispatches gmail-reauth.yml (mode=complete).
 *   3. scripts/gmail-reauth.js complete (in Actions, where the client secret
 *      lives) exchanges the code, refuses any account but OWNER_ACCOUNT, and
 *      the workflow stores the refresh token with `gh secret set`, then reruns
 *      finance-ingest.yml.
 *
 * The client secret and the secret-writing PAT never reach Vercel; the route
 * only holds the (public by design) client id and a dispatch token. Pure,
 * dependency-free helpers live here so the routes (via createRequire, like
 * submit-review/route.ts) and the script share one implementation (rule 15).
 *
 * Coupling: rotating APPROVAL_HMAC_SECRET voids outstanding start links and any
 * grant sealed in the last few minutes; mint a new link (gmail-reauth.yml, mode=link).
 */

const crypto = require('crypto');
const { seal, open } = require('./hkdf-seal');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// The mailbox finance-ingest.yml reads (receipts + DMARC rua). A grant for any
// other account is refused, so the public-facing start link can never swap in
// someone else's mailbox.
const OWNER_ACCOUNT = 'thomas.pryor@gmail.com';
const SITE_ORIGIN = 'https://broadwayscorecard.com';
const START_PATH = '/api/admin/gmail-reauth';
const CALLBACK_PATH = `${START_PATH}/callback`;
const REDIRECT_URI = `${SITE_ORIGIN}${CALLBACK_PATH}`;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const COOKIE_NAME = 'gmail_reauth';
const COOKIE_MAX_AGE_S = 15 * 60;
const LINK_TTL_DAYS = 30;
// Google authorization codes live ~10 minutes; a sealed grant older than this
// cannot be exchanged anyway, so fail early with a clear message.
const GRANT_MAX_AGE_MS = 10 * 60 * 1000;
const SIG_HEX_CHARS = 32; // 128 bits; hex so Linear/markdown never escapes it
const GRANT_SEAL = { info: 'bsc/gmail-reauth/grant/v1', prefix: 'g1.' };

function linkSignature(exp, secret) {
  if (!secret) throw new Error('gmail-reauth: no signing secret');
  return crypto.createHmac('sha256', String(secret)).update(`gmail-reauth-start:${exp}`).digest('hex').slice(0, SIG_HEX_CHARS);
}

/** The owner's one-tap link, valid for `ttlDays`. */
function buildStartLink(secret, nowMs = Date.now(), ttlDays = LINK_TTL_DAYS) {
  const exp = Math.floor(nowMs / 1000) + Math.round(ttlDays * 86400);
  return { url: `${SITE_ORIGIN}${START_PATH}?e=${exp}&s=${linkSignature(exp, secret)}`, exp };
}

/** { ok: true } or { ok: false, reason: 'malformed' | 'expired' | 'bad-signature' | 'no-secret' }. */
function verifyStartLink(e, s, secret, nowMs = Date.now()) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!/^\d{9,11}$/.test(String(e || '')) || !/^[0-9a-f]+$/.test(String(s || ''))) return { ok: false, reason: 'malformed' };
  const expected = linkSignature(e, secret);
  const given = String(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (nowMs > Number(e) * 1000) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** Fresh CSRF state plus PKCE verifier/challenge (S256). */
function makeAuthRequest() {
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
}

function cookieValue({ state, verifier }) {
  return `${state}.${verifier}`;
}

function parseCookieValue(value) {
  const m = /^([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{43,128})$/.exec(String(value || ''));
  return m ? { state: m[1], verifier: m[2] } : null;
}

function statesMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function buildConsentUrl({ clientId, state, challenge }) {
  if (!clientId) throw new Error('gmail-reauth: no client id');
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // a refresh token, not just an access token
    prompt: 'consent', // Google only re-issues a refresh token on a fresh consent
    login_hint: OWNER_ACCOUNT,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${p.toString()}`;
}

/** True when Google's space-separated `scope` grant includes Gmail read access. */
function grantedScopeOk(scope) {
  return String(scope || '').split(/\s+/).includes(SCOPE);
}

function isOwnerAccount(email) {
  return String(email || '').trim().toLowerCase() === OWNER_ACCOUNT;
}

function sealGrant({ code, verifier }, secret, nowMs = Date.now()) {
  if (!secret) throw new Error('gmail-reauth: no sealing secret');
  if (!code || !verifier) throw new Error('gmail-reauth: grant needs code and verifier');
  return seal(JSON.stringify({ code, verifier, iat: nowMs }), secret, GRANT_SEAL);
}

/** { code, verifier } or { error } ('unreadable' | 'expired'). */
function openGrant(token, secret, nowMs = Date.now(), maxAgeMs = GRANT_MAX_AGE_MS) {
  const text = open(token, secret, GRANT_SEAL);
  if (text === null) return { error: 'unreadable' };
  let g;
  try { g = JSON.parse(text); } catch { return { error: 'unreadable' }; }
  if (!g || typeof g.code !== 'string' || typeof g.verifier !== 'string' || !Number.isFinite(g.iat)) {
    return { error: 'unreadable' };
  }
  if (nowMs - g.iat > maxAgeMs || g.iat - nowMs > 60_000) return { error: 'expired' };
  return { code: g.code, verifier: g.verifier };
}

/**
 * Google Cloud Console page for this OAuth client, where its "Authorized
 * redirect URIs" are edited. The project number is the client id's numeric
 * prefix. Used when Google answers redirect_uri_mismatch: there is no API to
 * add a redirect URI, so the owner adds REDIRECT_URI there once.
 */
function consoleClientUrl(clientId) {
  const m = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/.exec(String(clientId || ''));
  return m
    ? `https://console.cloud.google.com/apis/credentials/oauthclient/${clientId}?project=${m[1]}`
    : 'https://console.cloud.google.com/apis/credentials';
}

/** Asks Google, without signing in, whether it accepts our consent request. */
async function probeConsent(clientId, fetchImpl = fetch, timeoutMs = 5000) {
  const { state, challenge } = makeAuthRequest();
  const res = await fetchImpl(buildConsentUrl({ clientId, state, challenge }), {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs), // the start route has 15s; a hang must not 504 the owner
  });
  return classifyAuthProbe({ status: res.status, location: res.headers.get('location') });
}

/**
 * Reads Google's answer to an unauthenticated GET of the consent URL. Google
 * validates client_id and redirect_uri before anyone signs in: a bad request
 * 302s to /signin/oauth/error?authError=<base64 protobuf naming the error>,
 * a good one to the sign-in / account chooser page.
 * @returns {{ ok: boolean, error: string|null }}
 */
function classifyAuthProbe({ status, location }) {
  let loc;
  try { loc = new URL(String(location || '')); } catch { return { ok: false, error: `unexpected-response-${status}` }; }
  if (loc.hostname !== 'accounts.google.com') return { ok: false, error: `unexpected-redirect-${loc.hostname}` };
  if (loc.pathname.includes('/signin/oauth/error')) {
    let detail = '';
    try { detail = Buffer.from(loc.searchParams.get('authError') || '', 'base64').toString('latin1'); } catch { /* keep empty */ }
    const m = /([a-z]+(?:_[a-z]+)+)/.exec(detail);
    return { ok: false, error: m ? m[1] : 'oauth-error' };
  }
  if (status >= 300 && status < 400) return { ok: true, error: null };
  return { ok: false, error: `unexpected-response-${status}` };
}

/** Expiry (unix seconds) of the renewal link already on the card, or null. */
function existingLinkExp(description) {
  const m = new RegExp(`${(SITE_ORIGIN + START_PATH).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\?e=(\\d{9,11})&`).exec(String(description || ''));
  return m ? Number(m[1]) : null;
}

// Lines this flow owns on the Linear card. Matched by the start path so a
// re-minted link replaces the old one instead of stacking a second decision.
function isDecisionBlockLine(line) {
  return line.includes(`${SITE_ORIGIN}${START_PATH}?e=`) || /^\(Gmail renewal link\b/.test(line.trim());
}

function stripDecisionBlock(description) {
  return String(description || '').split('\n').filter((l) => !isDecisionBlockLine(l)).join('\n').replace(/^\n+/, '');
}

/**
 * The plain-English DECISION NEEDED lines (scripts/lib/owner-decision-notify.js
 * emails the first one, capped at 220 chars, so the link sits inside it).
 * `problem` is an optional one-line plain-English note shown before the ask.
 */
function decisionBlock({ url, exp, problem, setup = false }) {
  const until = new Date(exp * 1000).toISOString().slice(0, 10);
  // The link comes first: the notifier emails only the first 220 chars.
  const ask = setup
    ? `Tap ${url} to reconnect Gmail: one setup step in Google settings, then press Allow.`
    : `Tap ${url} and press Allow to reconnect Gmail.`;
  return [
    `DECISION NEEDED: ${ask}${problem ? ` (${problem})` : ''}`,
    `(Gmail renewal link, valid until ${until}. Sign in as ${OWNER_ACCOUNT} if Google asks. After Allow, the new key is saved and the receipts and email-report job reruns by itself. Nothing else is needed.)`,
  ].join('\n');
}

function withDecisionBlock(description, block) {
  const rest = stripDecisionBlock(description);
  return rest ? `${block}\n\n${rest}` : block;
}

module.exports = {
  SCOPE,
  OWNER_ACCOUNT,
  SITE_ORIGIN,
  START_PATH,
  CALLBACK_PATH,
  REDIRECT_URI,
  GOOGLE_AUTH_URL,
  COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  LINK_TTL_DAYS,
  GRANT_MAX_AGE_MS,
  buildStartLink,
  verifyStartLink,
  makeAuthRequest,
  cookieValue,
  parseCookieValue,
  statesMatch,
  buildConsentUrl,
  consoleClientUrl,
  probeConsent,
  grantedScopeOk,
  isOwnerAccount,
  sealGrant,
  openGrant,
  classifyAuthProbe,
  stripDecisionBlock,
  existingLinkExp,
  decisionBlock,
  withDecisionBlock,
};
