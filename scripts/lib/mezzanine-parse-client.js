/**
 * Minimal client for Mezzanine's (theaterdiary.com) Parse Server REST API.
 * Shared by import-mezzanine-historical.js, resolve-unmatched-imports.js, and
 * refresh-mezzanine-catalog.js — one place to update if the auth scheme or
 * host changes.
 */
const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error(`Auth failed (${res.statusCode}). Token may have expired.`);
          err.authFailed = true;
          reject(err);
          return;
        }
        if (res.statusCode === 429) {
          const err = new Error('Rate limited (429). Wait and retry.');
          err.rateLimited = true;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(resBody)); }
        catch (e) { reject(new Error('Parse error: ' + resBody.substring(0, 200))); }
      });
    });
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
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error(`Auth failed (${res.statusCode}). Token may have expired.`);
          err.authFailed = true;
          reject(err);
          return;
        }
        if (res.statusCode === 404) { resolve(null); return; }
        try { resolve(JSON.parse(resBody)); }
        catch (e) { reject(new Error('Parse error: ' + resBody.substring(0, 200))); }
      });
    });
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

module.exports = { queryParse, getObject, findProductionsForShow, findShowsByTitle, sleep };
