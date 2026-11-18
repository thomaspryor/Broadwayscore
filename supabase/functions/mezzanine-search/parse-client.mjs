/**
 * Fetch-based client for Mezzanine's (theaterdiary.com) Parse Server REST
 * API, for the Deno edge-function runtime. Deno can't require() the Node
 * https-based client at scripts/lib/mezzanine-parse-client.js, so this is a
 * fetch() port of the same two calls (findShowsByTitle, findProductionsForShow)
 * — keep the request shapes in sync if theaterdiary.com's API changes.
 */

const PARSE_BASE = 'https://api.theaterdiary.com/parse/classes';

/** A failure on theaterdiary.com's side (network error, 5xx, 429, a
 *  non-JSON body). Third-party and transient: the caller answers with the
 *  handled {ok:false} channel, not a 500 (BRO-7733, Sentry 7815060800). */
function upstreamError(message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.upstreamFailed = true;
  return err;
}

async function queryParse(className, body, appId, sessionToken) {
  let res;
  try {
    res = await fetch(`${PARSE_BASE}/${className}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Parse-Application-Id': appId,
        'X-Parse-Session-Token': sessionToken,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw upstreamError(`Mezzanine Parse API unreachable: ${e instanceof Error ? e.message : String(e)}`, e);
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Mezzanine auth failed (${res.status})`);
    err.authFailed = true;
    throw err;
  }
  if (!res.ok) throw upstreamError(`Mezzanine Parse API HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw upstreamError('Mezzanine Parse API returned a non-JSON body', e);
  }
  return json.results || [];
}

/**
 * Map an error caught by the edge function to its response. Per the error
 * contract in index.ts, handled failures (upstream auth, upstream outage) are
 * HTTP 200 {ok:false}; only our own bugs stay a 500. A 500 here is reported
 * to Sentry by the browser's instrumentedFetch as "UGC functions
 * mezzanine-search failed (500)", so an upstream outage must not reach it.
 */
export function errorOutcome(e) {
  if (e && e.authFailed) return { status: 200, body: { ok: false, error: 'upstream_auth' } };
  if (e && e.upstreamFailed) return { status: 200, body: { ok: false, error: 'upstream_unavailable' } };
  return { status: 500, body: { ok: false, error: 'internal' } };
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
  let res;
  try {
    res = await fetch(`${PARSE_BASE}/Show/${showObjectId}`, {
      headers: { 'X-Parse-Application-Id': appId, 'X-Parse-Session-Token': sessionToken },
    });
  } catch (e) {
    throw upstreamError(`Mezzanine Parse API unreachable: ${e instanceof Error ? e.message : String(e)}`, e);
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Mezzanine auth failed (${res.status})`);
    err.authFailed = true;
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw upstreamError(`Mezzanine Parse API HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw upstreamError('Mezzanine Parse API returned a non-JSON body', e);
  }
}
