'use strict';

/**
 * BRO-5235: owner renewal of MEZZANINE_SESSION_TOKEN without the Mac.
 *
 * Mezzanine (api.theaterdiary.com, a Parse Server) only offers Sign in with
 * Apple, so there is no password to log in with. A session token lasts about a
 * year (the last one worked 2026-02-03 to 2026-10-07, then Parse error 209).
 * The owner captures a fresh one on the iPhone with Proxyman and pastes it on
 * a signed page:
 *
 *   1. GET  /api/admin/mezzanine-token?e=<exp>&s=<sig>  (src/app/api/admin/mezzanine-token/route.ts)
 *      shows the iPhone steps and a paste box. Only a link signed with
 *      APPROVAL_HMAC_SECRET (owner-signed-link.js) gets through.
 *   2. POST the same URL: re-checks the signature and that the POST came from
 *      this page (Origin / Sec-Fetch-Site), pulls the token out of the paste,
 *      seals it with hkdf-seal and dispatches mezzanine-token.yml (mode=complete).
 *   3. scripts/mezzanine-token.js complete (in Actions, where MEZZANINE_APP_ID
 *      lives) checks the token against /parse/sessions/me, writes it to a 0600
 *      file for `gh secret set`, and the workflow re-runs update-mezzanine.yml
 *      and reports the result on the card.
 *
 * update-mezzanine.yml runs `mezzanine-token.js check-expiry` before each
 * weekly scrape: within WARN_DAYS of expiresAt, or on an expired token, the
 * card gets a fresh link as a DECISION NEEDED line (which emails the owner).
 *
 * Known exposure: the sealed token rides a workflow_dispatch input, which repo
 * readers can see. Reading it needs APPROVAL_HMAC_SECRET, whose leak would
 * already forge every owner link; the token only reads public ratings and is
 * revocable by signing out of Mezzanine.
 */

const { seal, open } = require('./hkdf-seal');
const { createSignedLink, SITE_ORIGIN } = require('./owner-signed-link');
const { classifyParseResponse } = require('./mezzanine-parse-client');

const START_PATH = '/api/admin/mezzanine-token';
const LINK_TTL_DAYS = 30;
const WARN_DAYS = 30;
const PARSE_HOST = 'api.theaterdiary.com';
const SESSION_ME_URL = `https://${PARSE_HOST}/parse/sessions/me`;
const MAX_FORM_BYTES = 32 * 1024; // a pasted "copy as cURL" can be long
const SEALED_MAX_AGE_MS = 30 * 60 * 1000;
const TOKEN_SEAL = { info: 'bsc/mezzanine-token/v1', prefix: 'm1.' };
const PROXYMAN_APP_URL = 'https://apps.apple.com/app/id1551292695';

const LINK = createSignedLink({
  domain: 'mezzanine-token-start',
  path: START_PATH,
  ttlDays: LINK_TTL_DAYS,
  origin: SITE_ORIGIN,
  extraLine: /^\(Mezzanine renewal link\b/,
});

// Parse revocable session tokens are "r:" + 32 hex chars.
const REVOCABLE = /\br:[0-9a-f]{32}\b/;
const HEADER_LINE = /x-parse-session-token["']?\s*[:=]\s*["']?(r:[0-9a-f]{32}|[A-Za-z0-9]{20,40})\b/i;
const LEGACY = /^[A-Za-z0-9]{20,40}$/;

/**
 * The session token in whatever the owner pasted: the bare value, a header
 * line, or a whole copied request. null when there is none.
 */
function extractToken(pasted) {
  const text = String(pasted || '').slice(0, MAX_FORM_BYTES).trim();
  if (!text) return null;
  const header = HEADER_LINE.exec(text);
  if (header) return header[1];
  const revocable = REVOCABLE.exec(text);
  if (revocable) return revocable[0];
  return LEGACY.test(text) ? text : null;
}

/**
 * A form POST counts only when it came from our own page. Safari and Chrome
 * send Origin on a same-origin POST when the page's Referrer-Policy allows it
 * (the form page sets same-origin); Sec-Fetch-Site covers a browser that sends
 * Origin: null.
 */
function isSameOriginPost({ origin, secFetchSite }) {
  if (origin && origin !== 'null') return origin === SITE_ORIGIN;
  return secFetchSite === 'same-origin';
}

function sealToken(token, secret, nowMs = Date.now()) {
  if (!secret) throw new Error('mezzanine-token: no sealing secret');
  if (!token) throw new Error('mezzanine-token: no token');
  return seal(JSON.stringify({ token, iat: nowMs }), secret, TOKEN_SEAL);
}

/** { token } or { error } ('unreadable' | 'expired'). */
function openToken(sealed, secret, nowMs = Date.now(), maxAgeMs = SEALED_MAX_AGE_MS) {
  const text = open(sealed, secret, TOKEN_SEAL);
  if (text === null) return { error: 'unreadable' };
  let v;
  try { v = JSON.parse(text); } catch { return { error: 'unreadable' }; }
  if (!v || typeof v.token !== 'string' || !Number.isFinite(v.iat)) return { error: 'unreadable' };
  if (nowMs - v.iat > maxAgeMs || v.iat - nowMs > 60_000) return { error: 'expired' };
  return { token: v.token };
}

function parseDate(v) {
  const iso = v && typeof v === 'object' ? v.iso : v;
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads Parse's answer to GET /parse/sessions/me.
 * @returns {{ state: 'ok', expiresAtMs: number|null, userId: string|null }
 *         | { state: 'expired', detail: string }
 *         | { state: 'unknown', detail: string }}
 * 'unknown' (network, 5xx, 404, odd body) never asks the owner for anything.
 */
function classifySession(statusCode, bodyText) {
  const r = classifyParseResponse(statusCode, bodyText);
  if (r.error) {
    return r.error.authFailed
      ? { state: 'expired', detail: r.error.message }
      : { state: 'unknown', detail: r.error.message };
  }
  const s = r.json || {};
  if (!s.sessionToken && !s.objectId) return { state: 'unknown', detail: 'no session in the reply' };
  const userId = s.user && typeof s.user.objectId === 'string' ? s.user.objectId : null;
  return { state: 'ok', expiresAtMs: parseDate(s.expiresAt), userId };
}

/** 'expired' | 'warn' | 'none' for a classified session. */
function expiryAction(session, nowMs = Date.now(), warnDays = WARN_DAYS) {
  if (session.state === 'expired') return 'expired';
  if (session.state !== 'ok' || !session.expiresAtMs) return 'none';
  if (session.expiresAtMs <= nowMs) return 'expired';
  return session.expiresAtMs - nowMs <= warnDays * 86400 * 1000 ? 'warn' : 'none';
}

/**
 * The plain-English DECISION NEEDED lines for the card. owner-decision-notify
 * emails the first line (capped at 220 chars), so the link sits inside it.
 */
function decisionBlock({ url, exp, problem }) {
  const until = new Date(exp * 1000).toISOString().slice(0, 10);
  return [
    // The reason rides line 2: a long one would push the link past the cap.
    `DECISION NEEDED: Reconnect Mezzanine ratings: when you have 10 minutes on your iPhone, tap ${url} and follow the steps there.`,
    `(Mezzanine renewal link, valid until ${until}.${problem ? ` ${problem}` : ''} The page walks you through copying one code from the Mezzanine app with the free Proxyman app, pasting it, and switching Proxyman off again. After Save, the site stores it and refreshes the ratings by itself. Nothing else is needed.)`,
  ].join('\n');
}

// Owner steps, shown on the form page. One action per step. Sources:
// Proxyman's own iOS guide (proxyman.com/posts/2021-10-17-Getting-Started-With-Proxyman-For-iOS,
// docs.proxyman.com/proxyman-ios: "Start intercept HTTPS Traffic", VPN on,
// "Generate Certificate", proxy.man/ssl, trust, "Ready to intercept", search,
// Response tab "Enable SSL Proxying", Header tab) and iOS's standard Settings
// paths (Profile Downloaded, General > About > Certificate Trust Settings,
// General > VPN & Device Management > Remove Profile).
const SETUP_STEPS = [
  'Install the free app <b>Proxyman - Capture HTTPS</b> from the App Store.',
  'Open Proxyman and tap <b>Start intercept HTTPS Traffic</b>.',
  'If your iPhone asks to add a VPN configuration, tap <b>Allow</b>.',
  'Turn on the Proxyman VPN. A small <b>VPN</b> sign appears at the top of the screen.',
  'Tap <b>Generate Certificate</b>.',
  'Open Safari, go to <b>proxy.man/ssl</b>, and tap <b>Allow</b> to download the profile.',
  'Open the Settings app and tap <b>Profile Downloaded</b> near the top.',
  'Tap <b>Install</b>, enter your passcode, and tap <b>Install</b> again.',
  'In Settings, go to <b>General</b>, then <b>About</b>, then <b>Certificate Trust Settings</b>.',
  'Switch on the Proxyman certificate and tap <b>Continue</b>.',
  'Go back to Proxyman. It should say <b>Ready to intercept</b>.',
];
const CAPTURE_STEPS = [
  'Open the Mezzanine app. If its settings have a <b>Sign out</b> option, sign out and sign back in with Apple, so it makes a new code. Then open any show.',
  'Go back to Proxyman and type <b>theaterdiary</b> in the search bar.',
  'Tap the first request, swipe to the <b>Response</b> tab, and tap <b>Enable SSL Proxying</b>.',
  'Go back to Mezzanine and open a different show.',
  'Go back to Proxyman and tap the newest <b>api.theaterdiary.com</b> request.',
  'Open its <b>Header</b> tab and find the line <b>X-Parse-Session-Token</b>.',
  'Copy the value on that line. It starts with <b>r:</b>. If you can only copy the whole request, copy all of it: this page finds the code.',
  'Come back to this page, paste it in the box below, and tap <b>Save</b>.',
];
const CLEANUP_STEPS = [
  'In Proxyman, turn the VPN off.',
  'In Settings, go to <b>General</b>, <b>About</b>, <b>Certificate Trust Settings</b>, and switch the Proxyman certificate off.',
  'In Settings, go to <b>General</b>, <b>VPN &amp; Device Management</b>, tap the Proxyman profile, and tap <b>Remove Profile</b>.',
  'You can delete the Proxyman app now. You need it again in about a year, and the site emails you a month ahead.',
];

module.exports = {
  START_PATH,
  LINK_TTL_DAYS,
  WARN_DAYS,
  PARSE_HOST,
  SESSION_ME_URL,
  MAX_FORM_BYTES,
  SEALED_MAX_AGE_MS,
  PROXYMAN_APP_URL,
  SITE_ORIGIN,
  LINK,
  buildStartLink: LINK.buildStartLink,
  verifyStartLink: LINK.verifyStartLink,
  extractToken,
  isSameOriginPost,
  sealToken,
  openToken,
  classifySession,
  expiryAction,
  decisionBlock,
  SETUP_STEPS,
  CAPTURE_STEPS,
  CLEANUP_STEPS,
};
