/**
 * Minimal service-role PostgREST client for Node scripts (cron/CI). Mirrors
 * src/lib/supabase-rest.ts's shape but that module is client-only (pulls in
 * @/lib/supabase, which needs a browser auth session) — scripts need the
 * service role key instead, which bypasses RLS entirely.
 */
function baseUrl() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL not set');
  return url;
}

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return key;
}

function headers(prefer) {
  const key = serviceKey();
  const h = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h['Prefer'] = prefer;
  return h;
}

/** SELECT rows via PostgREST query params, e.g. "select=*&resolved_at=is.null". */
async function selectRows(table, params) {
  const res = await fetch(`${baseUrl()}/rest/v1/${table}?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`selectRows ${table}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

/** UPDATE rows matching `filters` (query-string form) with `patch`. */
async function updateRows(table, filters, patch) {
  const res = await fetch(`${baseUrl()}/rest/v1/${table}?${filters}`, {
    method: 'PATCH',
    headers: headers('return=minimal'),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateRows ${table}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

/** DELETE rows matching `filters` (query-string form). */
async function deleteRows(table, filters) {
  const res = await fetch(`${baseUrl()}/rest/v1/${table}?${filters}`, {
    method: 'DELETE',
    headers: headers('return=minimal'),
  });
  if (!res.ok) throw new Error(`deleteRows ${table}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

module.exports = { selectRows, updateRows, deleteRows };
