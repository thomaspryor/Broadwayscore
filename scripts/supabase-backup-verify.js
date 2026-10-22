#!/usr/bin/env node
// BRO-5884: compare a (decrypted) backup directory's row counts to live.
// Usage: node scripts/supabase-backup-verify.js <dir>   Exit 0 ok, 1 mismatch.
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./lib/supabase-backup-core');
const { countLines } = require('./lib/backup-drill');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/supabase-backup-verify.js <dir>\nCompares a decrypted backup dir row counts to live. Exit 0 ok, 1 mismatch.');
  process.exit(0);
}

async function main() {
  const dir = process.argv[2];
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dir || !url || !key) { console.error('usage + env NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP_MANIFEST.json'), 'utf8'));

  // Independently recount the ndjson so a truncated file can't hide behind the manifest.
  const exported = {}; const live = {};
  for (const name of Object.keys(manifest.tables)) {
    exported[name] = countLines(path.join(dir, 'tables', `${name}.ndjson`));
    if (exported[name] !== manifest.tables[name].rows) { console.error(`${name}: file has ${exported[name]} rows, manifest says ${manifest.tables[name].rows}`); process.exit(1); }
    const res = await fetch(`${url}/rest/v1/${name}?select=*&limit=1`, { headers: { ...headers, Prefer: 'count=exact' }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) { console.error(`${name}: live count HTTP ${res.status}`); process.exit(1); }
    live[name] = Number((res.headers.get('content-range') || '').split('/')[1]);
    if (!Number.isFinite(live[name])) { console.error(`${name}: live count header missing or unparseable`); process.exit(1); }
  }
  if (process.env.SUPABASE_ACCESS_TOKEN && process.env.SUPABASE_PROJECT_REF) {
    // A table that exists live but was missed by the exporter must fail verify.
    for (const t of await core.listTables(process.env.SUPABASE_PROJECT_REF, process.env.SUPABASE_ACCESS_TOKEN)) {
      if (t.name in exported) continue;
      const res = await fetch(`${url}/rest/v1/${t.name}?select=*&limit=1`, { headers: { ...headers, Prefer: 'count=exact' }, signal: AbortSignal.timeout(60000) });
      exported[t.name] = 0; live[t.name] = Number((res.headers.get('content-range') || '').split('/')[1]) || 0;
      if (!res.ok) { console.error(`${t.name}: live count HTTP ${res.status}`); process.exit(1); }
      console.error(`table ${t.name} is live but absent from the backup`); process.exit(1);
    }
  }
  const authLines = countLines(path.join(dir, 'auth_users.ndjson'));
  let liveAuth = 0;
  for (let page = 1; page < 1000; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers, signal: AbortSignal.timeout(60000) });
    if (!res.ok) { console.error(`auth users: HTTP ${res.status}`); process.exit(1); }
    const { users } = await res.json();
    if (!users || !users.length) break;
    liveAuth += users.length;
  }
  exported.auth_users = authLines; live.auth_users = liveAuth;
  const problems = core.compareCounts(exported, live);
  for (const [k, v] of Object.entries(exported)) console.log(`${k}: backup ${v} live ${live[k]}`);
  if (problems.length) { console.error('MISMATCH:\n' + problems.join('\n')); process.exit(1); }
  console.log(`OK: ${Object.keys(exported).length} datasets match live within tolerance`);
}
main().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
