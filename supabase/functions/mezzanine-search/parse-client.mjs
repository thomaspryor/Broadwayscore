/**
 * Fetch-based client for Mezzanine's (theaterdiary.com) Parse Server REST
 * API, for the Deno edge-function runtime. Deno can't require() the Node
 * https-based client at scripts/lib/mezzanine-parse-client.js, so this is a
 * fetch() port of the same two calls (findShowsByTitle, findProductionsForShow)
 * — keep the request shapes in sync if theaterdiary.com's API changes.
 */

const PARSE_BASE = 'https://api.theaterdiary.com/parse/classes';

async function queryParse(className, body, appId, sessionToken) {
  const res = await fetch(`${PARSE_BASE}/${className}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Parse-Application-Id': appId,
      'X-Parse-Session-Token': sessionToken,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Mezzanine auth failed (${res.status})`);
    err.authFailed = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Mezzanine Parse API HTTP ${res.status}`);
  const json = await res.json();
  return json.results || [];
}

/** Search Shows by normalized (searchableName) title substring. */
export function findShowsByTitle(normalizedTitle, appId, sessionToken) {
  return queryParse('Show', {
    where: { searchableName: { $regex: normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } },
    limit: 10,
    _method: 'GET',
  }, appId, sessionToken);
}

/** Query Productions pointing at a given Show objectId, with show+theater included. */
export function findProductionsForShow(showObjectId, appId, sessionToken) {
  return queryParse('Production', {
    where: { show: { __type: 'Pointer', className: 'Show', objectId: showObjectId } },
    include: 'show,theater',
    _method: 'GET',
  }, appId, sessionToken);
}

/** GET a single Production by objectId (used by the exact-mezzShowId path
 *  when the client already knows which Show to look up). */
export async function getShow(showObjectId, appId, sessionToken) {
  const res = await fetch(`${PARSE_BASE}/Show/${showObjectId}`, {
    headers: { 'X-Parse-Application-Id': appId, 'X-Parse-Session-Token': sessionToken },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Mezzanine auth failed (${res.status})`);
    err.authFailed = true;
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mezzanine Parse API HTTP ${res.status}`);
  return res.json();
}
