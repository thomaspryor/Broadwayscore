#!/usr/bin/env node
// BRO-5884: export every public base table + auth users to ndjson files.
// Usage: node scripts/supabase-backup.js <outDir>
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF
// Logs table names and row counts only, never row contents.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./lib/supabase-backup-core');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/supabase-backup.js <outDir>\nExports public tables + auth users to ndjson. Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF');
  process.exit(0);
}

const need = (k) => { if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(2); } return process.env[k]; };

async function main() {
  const out = process.argv[2];
  if (!out) { console.error('usage: supabase-backup.js <outDir>'); process.exit(2); }
  const url = need('NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const key = need('SUPABASE_SERVICE_ROLE_KEY');
  const tables = await core.listTables(need('SUPABASE_PROJECT_REF'), need('SUPABASE_ACCESS_TOKEN'));
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  fs.mkdirSync(path.join(out, 'tables'), { recursive: true });

  const manifest = { created: new Date().toISOString(), note: core.COVERAGE_NOTE, tables: {}, auth_users: 0 };
  for (const t of tables) {
    const fd = fs.openSync(path.join(out, 'tables', `${t.name}.ndjson`), 'w');
    let last = null; let n = 0;
    for (;;) {
      const p = new URLSearchParams({ select: '*', order: t.pk.map((c) => `${c}.asc`).join(','), limit: String(core.PAGE_SIZE) });
      for (const [k, v] of Object.entries(core.keysetParams(t.pk, last) || {})) p.set(k, v);
      const res = await fetch(`${url}/rest/v1/${t.name}?${p}`, { headers, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status}`);
      const rows = await res.json();
      for (const r of rows) fs.writeSync(fd, JSON.stringify(r) + '\n');
      n += rows.length;
      if (rows.length === 0) break; // keep paging until empty: server max-rows may be below PAGE_SIZE
      last = rows[rows.length - 1];
    }
    fs.closeSync(fd);
    manifest.tables[t.name] = { rows: n, pk: t.pk };
    console.log(`table ${t.name}: ${n} rows`);
  }

  // auth users: page until an empty page (do not trust totals).
  const afd = fs.openSync(path.join(out, 'auth_users.ndjson'), 'w');
  for (let page = 1; ; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`auth users: HTTP ${res.status}`);
    const { users } = await res.json();
    if (!users || users.length === 0) break;
    for (const u of users) fs.writeSync(afd, JSON.stringify(u) + '\n');
    manifest.auth_users += users.length;
    if (page > 1000) throw new Error('auth users: runaway pagination');
  }
  fs.closeSync(afd);
  console.log(`auth users: ${manifest.auth_users}`);
  if (manifest.auth_users === 0) throw new Error('auth user export returned 0 users; refusing to publish an empty backup');

  fs.writeFileSync(path.join(out, 'BACKUP_MANIFEST.json'), JSON.stringify(manifest, null, 2));
}
main().catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
