/**
 * Minimal client for Mezzanine's (theaterdiary.com) Parse Server REST API.
 * Shared by import-mezzanine-historical.js, resolve-unmatched-imports.js, and
 * refresh-mezzanine-catalog.js — one place to update if the auth scheme or
 * host changes.
 */
const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse Server error codes that mean the session is not usable. Parse reports
// these in a JSON body ({code, error}) with HTTP 400, not 401/403, so a status
// check alone reads an expired token as an empty result set (BRO-5098).
const PARSE_AUTH_CODES = new Set([
  206, // SESSION_MISSING
  209, // INVALID_SESSION_TOKEN
]);

/**
 * Turn one Parse REST response into data or a descriptive error. Never treats
 * an error body as "no results": the caller sees status, Parse code and message.
 * @returns {{json: object}|{error: Error}} error carries .authFailed / .rateLimited
 */
function classifyParseResponse(statusCode, bodyText) {
  const fail = (msg, flags = {}) => ({ error: Object.assign(new Error(msg), { statusCode }, flags) });
  if (statusCode === 401 || statusCode === 403) {
    return fail(`Auth failed (${statusCode}). Token may have expired.`, { authFailed: true });
  }
  if (statusCode === 429) return fail('Rate limited (429). Wait and retry.', { rateLimited: true });
  let json;
  try { json = JSON.parse(bodyText); } catch (e) {
    return fail(`HTTP ${statusCode}, non-JSON body: ${String(bodyText).substring(0, 200)}`);
  }
  if (json && typeof json.code === 'number' && json.error !== undefined) {
    const msg = `Parse error ${json.code} (HTTP ${statusCode}): ${json.error}`;
    return fail(msg, { parseCode: json.code, authFailed: PARSE_AUTH_CODES.has(json.code) });
  }
  if (statusCode < 200 || statusCode >= 300) {
    return fail(`HTTP ${statusCode}: ${String(bodyText).substring(0, 200)}`);
  }
  return { json };
}

/**
 * Query a Parse Server class. Throws with `.authFailed = true` on 401/403 so
 * callers can distinguish "token expired" (page the owner) from a transient
 * network/server error (retry).
 */
function queryParse(className, body, { appId, sessionToken } = {}) {
  const APP_ID = appId || process.env.MEZZANINE_APP_ID;
  const SESSION_TOKEN = sessionToken || process.env.MEZZANINE_SESSION_TOKEN;
  if (!APP_ID || !SESSION_TOKEN) {
    return Promise.reject(new Error('MEZZANINE_APP_ID and MEZZANINE_SESSION_TOKEN must be set'));
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: '/parse/classes/' + className,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Session-Token': SESSION_TOKEN,
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let resBody = '';
      res.on('data', c => resBody += c);
      res.on('end', () => {
        const out = classifyParseResponse(res.statusCode, resBody);
        if (out.error) reject(out.error); else resolve(out.json);
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * GET a Parse object by class + id (Parse's REST GET, not the query endpoint
 * queryParse wraps — separated because it has no request body).
 */
function getObject(className, objectId, { appId, sessionToken } = {}) {
  const APP_ID = appId || process.env.MEZZANINE_APP_ID;
  const SESSION_TOKEN = sessionToken || process.env.MEZZANINE_SESSION_TOKEN;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: `/parse/classes/${className}/${objectId}`,
      method: 'GET',
      headers: {
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Session-Token': SESSION_TOKEN,
      },
    }, res => {
      let resBody = '';
      res.on('data', c => resBody += c);
      res.on('end', () => {
        const out = classifyParseResponse(res.statusCode, resBody);
        // Parse answers a missing object with 404 + {code: 101}; keep that a null.
        if (out.error && (res.statusCode === 404 || out.error.parseCode === 101)) { resolve(null); return; }
        if (out.error) reject(out.error); else resolve(out.json);
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));
    req.on('error', reject);
    req.end();
  });
}

/** Query Productions pointing at a given Show objectId, with show+theater included. */
function findProductionsForShow(showObjectId, opts) {
  return queryParse('Production', {
    where: { show: { __type: 'Pointer', className: 'Show', objectId: showObjectId } },
    include: 'show,theater',
    _method: 'GET',
  }, opts).then(res => res.results || []);
}

/** Search Shows by normalized (searchableName) title substring. */
function findShowsByTitle(normalizedTitle, opts) {
  return queryParse('Show', {
    where: { searchableName: { $regex: normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } },
    limit: 10,
    _method: 'GET',
  }, opts).then(res => res.results || []);
}

module.exports = { classifyParseResponse, PARSE_AUTH_CODES, queryParse, getObject, findProductionsForShow, findShowsByTitle, sleep };
