'use strict';
// Pure helpers for the Supabase -> R2 backup (BRO-5884). No network, no fs, so
// tests require() the real functions (CLAUDE.md §15).

// Base tables (relkind r/p) in public with their primary-key columns, in key order.
const TABLES_SQL = `
select c.relname as t,
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_index i
     cross join lateral unnest(i.indkey::int[]) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = c.oid and i.indisprimary) as pk
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1`;

const PAGE_SIZE = 1000; // PostgREST max-rows default on Supabase

function parseTableRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('table list is empty or malformed');
  return rows.map((r) => {
    if (!r.t || !/^[a-z_][a-z0-9_]*$/.test(r.t)) throw new Error(`unexpected table name: ${JSON.stringify(r.t)}`);
    if (!r.pk) throw new Error(`table ${r.t} has no primary key; keyset paging impossible, refusing to skip it`);
    return { name: r.t, pk: r.pk.split(',') };
  });
}

function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

// PostgREST filter for "key tuple strictly greater than lastRow's", e.g. for pk [a,b]:
// or=(a.gt."x",and(a.eq."x",b.gt."y")). Returns null for the first page.
function keysetParams(pk, lastRow) {
  if (!lastRow) return null;
  if (pk.length === 1) return { [pk[0]]: `gt.${lastRow[pk[0]]}` };
  const alts = [];
  for (let i = 0; i < pk.length; i++) {
    const eqs = pk.slice(0, i).map((c) => `${c}.eq.${q(lastRow[c])}`);
    const gt = `${pk[i]}.gt.${q(lastRow[pk[i]])}`;
    alts.push(eqs.length ? `and(${[...eqs, gt].join(',')})` : gt);
  }
  return { or: `(${alts.join(',')})` };
}

// Drift allowed between backup time and verify time (live writes / deletes).
function countTolerance(n) { return Math.max(5, Math.ceil(n * 0.02)); }

// exported/live: { name: count }. Returns list of problems (empty = ok).
function compareCounts(exported, live) {
  const problems = [];
  for (const [name, n] of Object.entries(exported)) {
    if (!(name in live)) { problems.push(`${name}: missing in live`); continue; }
    if (n === 0 && live[name] > 0) { problems.push(`${name}: backup is empty but live has ${live[name]} rows`); continue; }
    if (Math.abs(live[name] - n) > countTolerance(n)) problems.push(`${name}: backup ${n} vs live ${live[name]}`);
  }
  for (const name of Object.keys(live)) if (!(name in exported)) problems.push(`${name}: live table absent from backup`);
  return problems;
}

// Project ref from https://<ref>.supabase.co (null when the URL is not a supabase host).
function projectRefFromUrl(u) {
  try { const m = new URL(u).hostname.toLowerCase().match(/^([a-z0-9]+)\.supabase\.co$/); return m ? m[1] : null; } catch { return null; }
}

// Management API list of tables + PKs. Shared by the exporter and the verifier.
async function listTables(ref, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: TABLES_SQL }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`table list HTTP ${res.status}`);
  return parseTableRows(await res.json());
}

const COVERAGE_NOTE = 'Covers every public base table (all columns) and auth.users records (id, email, phone, metadata, timestamps, identities). Excludes password hashes, MFA factors, sessions, storage objects and edge function code: for those use the Supabase provider backups.';

module.exports = { TABLES_SQL, PAGE_SIZE, parseTableRows, keysetParams, countTolerance, compareCounts, projectRefFromUrl, listTables, COVERAGE_NOTE };
