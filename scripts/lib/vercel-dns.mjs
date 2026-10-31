/**
 * vercel-dns.mjs — DNS records for broadwayscorecard.com, which Vercel serves
 * (nameservers ns1/ns2.vercel-dns.com; cloud-memory/reference_vercel_billing_api.md).
 *
 * Pure planning (planDns, recordsToDelete) is separate from the API calls so
 * tests need no network. Records are keyed on name + type + value, never on
 * id: Vercel reports a different id for the same record after an update.
 *
 * Env: VERCEL_TOKEN (DNS write scope), VERCEL_TEAM_ID (defaults to the team
 * that owns the domain).
 */

const API = 'https://api.vercel.com';
export const DEFAULT_TEAM_ID = 'team_zvgatcxkXdPbfhtHQMOnjpXo';
export const MAX_PAGES = 10;

/** Trailing dots and case never make two DNS values different. */
export function normalizeValue(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

export function normalizeName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function sameRecord(a, b) {
  return normalizeName(a.name) === normalizeName(b.name)
    && String(a.type).toUpperCase() === String(b.type).toUpperCase()
    && normalizeValue(a.value) === normalizeValue(b.value);
}

/**
 * Which of the wanted records to create, which exist already, and which
 * clash with something else on the same name.
 *
 * - A wanted record that exists (same name, type and value) is skipped.
 * - A CNAME shares its name with nothing: any other record on that name
 *   (an A record, a different CNAME, a TXT) is a conflict, because DNS
 *   forbids it and Vercel would refuse or, worse, serve the wrong answer.
 * - A TXT may sit beside other TXTs on the same name (ACME challenges do),
 *   so a different TXT value is not a conflict; a non-TXT record there is.
 * - Wildcards ("*") are never conflicts: a specific name wins over them.
 */
export function planDns(existing, wanted) {
  const create = [];
  const skip = [];
  const conflicts = [];
  const live = (existing || []).filter((r) => normalizeName(r.name) !== '*');
  for (const w of wanted) {
    const type = String(w.type).toUpperCase();
    const onName = live.filter((r) => normalizeName(r.name) === normalizeName(w.name));
    if (onName.some((r) => sameRecord(r, w))) { skip.push(w); continue; }
    const clash = onName.filter((r) => {
      const t = String(r.type).toUpperCase();
      if (type === 'CNAME') return true;
      if (t === 'CNAME') return true;
      return type === 'TXT' ? t !== 'TXT' : true;
    });
    if (clash.length) {
      conflicts.push({ wanted: w, existing: clash.map((r) => ({ id: r.id, name: r.name, type: r.type, value: r.value })) });
      continue;
    }
    create.push(w);
  }
  return { create, skip, conflicts };
}

/** The existing records that match the given ones exactly (for cleanup). */
export function recordsToDelete(existing, mine) {
  return (existing || []).filter((r) => mine.some((m) => sameRecord(r, m)));
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: auth(token),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const msg = json && json.error && json.error.message ? json.error.message : text.slice(0, 300);
    throw new Error(`Vercel ${method} ${path.split('?')[0]} answered HTTP ${res.status}: ${msg}`);
  }
  return json;
}

/** Every record of the zone, following the pagination cursor. */
export async function listRecords(domain, { token, teamId = DEFAULT_TEAM_ID } = {}) {
  const out = [];
  let until = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = `teamId=${encodeURIComponent(teamId)}&limit=100${until ? `&until=${until}` : ''}`;
    const json = await call('GET', `/v4/domains/${domain}/records?${q}`, { token });
    out.push(...(json.records || []));
    const next = json.pagination && json.pagination.next;
    if (!next) return out;
    until = next;
  }
  throw new Error(`more than ${MAX_PAGES * 100} DNS records on ${domain}; refusing to plan against a partial list`);
}

/** Creates one record; returns Vercel's id. `name` is relative to the zone. */
export async function createRecord(domain, record, { token, teamId = DEFAULT_TEAM_ID } = {}) {
  const json = await call('POST', `/v2/domains/${domain}/records?teamId=${encodeURIComponent(teamId)}`, {
    token,
    body: { name: record.name, type: String(record.type).toUpperCase(), value: record.value, ttl: record.ttl || 60, comment: record.comment || '' },
  });
  return json && (json.uid || json.id) || null;
}

export async function deleteRecord(domain, id, { token, teamId = DEFAULT_TEAM_ID } = {}) {
  await call('DELETE', `/v2/domains/${domain}/records/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`, { token });
}
