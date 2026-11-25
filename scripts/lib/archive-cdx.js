/**
 * archive-cdx.js: the one place that knows how the Internet Archive refuses a
 * CDX / availability query without auth (BRO-8000).
 *
 * Since ~2026-11-14 web.archive.org answers CDX queries for some publishers
 * (measured 2026-11-21: nytimes.com, theguardian.com 403; telegraph.co.uk,
 * timeout.com, variety.com, vulture.com, broadwayworld.com answer 200, so it is
 * per-host, not a global auth wall) with
 * 403 "This type of CDX query requires authorization." and the availability API
 * could return {"error":{"code":"upstream_error","message":"query failed with status_code=403"}}
 * (it answered 200 on 2026-11-21).
 * Ten scripts read that as "error" or "no capture" and nothing flagged it for a
 * week. A blocked route is NOT evidence about the page: callers must treat the
 * typed result `archive_auth_required` as "route unavailable", never as
 * "not findable" / "no capture" / abandon.
 *
 * Pure classifier + a thin fetch wrapper (fetch injectable for tests).
 */
'use strict';

const ARCHIVE_AUTH_REQUIRED = 'archive_auth_required';
const AUTH_BODY_RE = /requires authorization|status_code=403/i;
const ARCHIVE_HOST_RE = /^https?:\/\/(?:web\.archive\.org|archive\.org)\/(?:cdx\/|wayback\/available)/i;

/** True for a Wayback CDX / availability URL. */
function isArchiveIndexUrl(url) { return ARCHIVE_HOST_RE.test(String(url || '')); }

/**
 * Classify an index response. Returns ARCHIVE_AUTH_REQUIRED for the IA auth
 * refusal (403 with the auth body, or a 200/other status carrying the
 * availability API's upstream 403 error), else null. Pure.
 */
function classifyArchiveResponse(status, body) {
  const t = String(body || '').slice(0, 2000);
  if (status === 403 && AUTH_BODY_RE.test(t)) return ARCHIVE_AUTH_REQUIRED;
  if (/"code"\s*:\s*"upstream_error"/.test(t) && /status_code=403/.test(t)) return ARCHIVE_AUTH_REQUIRED;
  return null;
}

/** An Error carrying the typed kind so every caller can branch on e.kind. */
function authRequiredError(url) {
  const e = new Error(`${ARCHIVE_AUTH_REQUIRED}: Internet Archive CDX needs authorization (${String(url).slice(0, 80)})`);
  e.status = 403; e.kind = ARCHIVE_AUTH_REQUIRED; e.authRequired = true;
  return e;
}

/**
 * Fetch an archive index URL. Resolves {ok:true,text} | {ok:false,kind,status,message}.
 * kind: 'archive_auth_required' (blocked route, not evidence) | 'http_error' | 'network_error'.
 */
async function fetchArchiveIndex(url, { fetchImpl = globalThis.fetch, timeoutMs = 90000, headers = {} } = {}) {
  let r; let text;
  try {
    r = await fetchImpl(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    text = await r.text();
  } catch (e) { return { ok: false, kind: 'network_error', status: null, message: String(e.message).slice(0, 120) }; }
  const kind = classifyArchiveResponse(r.status, text);
  if (kind) return { ok: false, kind, status: r.status, message: authRequiredError(url).message };
  if (!r.ok) return { ok: false, kind: 'http_error', status: r.status, message: `HTTP ${r.status}` };
  return { ok: true, text };
}

/**
 * Drop-in for callers that want text or a throw: throws authRequiredError for
 * the typed refusal, an HTTP/network Error otherwise.
 */
async function fetchArchiveIndexText(url, opts) {
  const r = await fetchArchiveIndex(url, opts);
  if (r.ok) return r.text;
  if (r.kind === ARCHIVE_AUTH_REQUIRED) throw authRequiredError(url);
  const e = new Error(r.message); e.status = r.status || undefined; throw e;
}

/**
 * fetchArchiveIndexText + JSON.parse, for the CDX (output=json) and
 * availability callers (BRO-8099). An empty body (CDX with no captures can
 * answer one) is null. Throws the typed auth error (e.kind ===
 * ARCHIVE_AUTH_REQUIRED), an HTTP/network Error, or a SyntaxError.
 */
async function fetchArchiveIndexJson(url, opts) {
  const text = await fetchArchiveIndexText(url, opts);
  return text.trim() ? JSON.parse(text) : null;
}

/** True for the typed refusal error thrown above (blocked route, not evidence). */
function isArchiveAuthError(e) { return !!e && e.kind === ARCHIVE_AUTH_REQUIRED; }

module.exports = { ARCHIVE_AUTH_REQUIRED, isArchiveIndexUrl, classifyArchiveResponse, authRequiredError, fetchArchiveIndex, fetchArchiveIndexText, fetchArchiveIndexJson, isArchiveAuthError };
