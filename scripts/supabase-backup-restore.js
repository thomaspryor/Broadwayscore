#!/usr/bin/env node
// BRO-5884: restore a decrypted backup directory into a Supabase project.
// (Named supabase-backup-restore, not supabase-restore: restore-supabase.yml
// only un-pauses the free-tier project.)
//
// Dry run by default: prints what would be written. Writes need --apply AND a
// target whose URL is passed explicitly with --target-url (never defaulted from env).
//
// Usage: node scripts/supabase-backup-restore.js <dir> --target-url https://<ref>.supabase.co [--apply] [--include-auth] [--tables a,b]
// Env (only with --apply): RESTORE_SERVICE_ROLE_KEY (service role key of the target)
// Auth users are recreated with the same id/email/metadata and NO password: they sign in via
// magic link / reset. Full-fidelity auth (hashes, MFA) comes from Supabase provider backups.
// Restore order: auth users, profiles, then the rest alphabetically. If a foreign key rejects
// a batch, restore the parent table first with --tables.
'use strict';
const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');
const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('Usage: node scripts/supabase-backup-restore.js <dir> --target-url URL [--apply] [--include-auth] [--tables a,b] [--allow-prod]\nApply needs SUPABASE_PROJECT_REF (prod ref) so a prod target is refused. Dry run unless --apply (needs RESTORE_SERVICE_ROLE_KEY).');
  process.exit(0);
}
const dir = args.find((a) => !a.startsWith('--') && a !== valueOf('--target-url') && a !== valueOf('--tables'));
function valueOf(f) { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }
const apply = args.includes('--apply');
const target = (valueOf('--target-url') || '').replace(/\/$/, '');
const only = valueOf('--tables') ? valueOf('--tables').split(',') : null;
if (!dir || !target) { console.error('usage: supabase-backup-restore.js <dir> --target-url URL [--apply] [--include-auth] [--tables a,b]'); process.exit(2); }
const key = process.env.RESTORE_SERVICE_ROLE_KEY;
const { projectRefFromUrl } = require('./lib/supabase-backup-core');
const prodRef = process.env.SUPABASE_PROJECT_REF;
if (apply && !args.includes('--allow-prod')) {
  const targetRef = projectRefFromUrl(target);
  if (!prodRef || !targetRef || targetRef === prodRef) {
    console.error('refusing --apply: target is (or cannot be proven different from) the live production project. Set SUPABASE_PROJECT_REF and target a scratch project, or pass --allow-prod deliberately.');
    process.exit(2);
  }
}
if (apply && !key) { console.error('--apply needs RESTORE_SERVICE_ROLE_KEY'); process.exit(2); }
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP_MANIFEST.json'), 'utf8'));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} -> ${target} (backup from ${manifest.created})`);
  if (args.includes('--include-auth')) {
    const users = readLines(path.join(dir, 'auth_users.ndjson'));
    console.log(`auth users: ${users.length}`);
    if (apply) {
      let ok = 0;
      for (const u of users) {
        const res = await fetch(`${target}/auth/v1/admin/users`, { method: 'POST', headers, signal: AbortSignal.timeout(60000), body: JSON.stringify({
          id: u.id, email: u.email, phone: u.phone || undefined, email_confirm: !!u.email_confirmed_at,
          user_metadata: u.user_metadata, app_metadata: u.app_metadata }) });
        if (res.ok) ok++;
        else if (res.status === 422 && /already|exists|registered/i.test(await res.text())) continue;
        else throw new Error(`auth user create HTTP ${res.status}`);
      }
      console.log(`auth users created: ${ok} (rest already existed)`);
    }
  }
  const names = Object.keys(manifest.tables).filter((t) => !only || only.includes(t))
    .sort((a, b) => (a === 'profiles' ? -1 : b === 'profiles' ? 1 : a.localeCompare(b)));
  for (const t of names) {
    const rows = readLines(path.join(dir, 'tables', `${t}.ndjson`));
    console.log(`table ${t}: ${rows.length} rows`);
    if (!apply) continue;
    const pk = manifest.tables[t].pk.join(',');
    for (let i = 0; i < rows.length; i += 500) {
      const res = await fetch(`${target}/rest/v1/${t}?on_conflict=${pk}`, { method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)), signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        // GENERATED ALWAYS identity ids (import_fetch_log, theatr_screenshot_log) reject explicit values: re-insert without the key (log tables, nothing references them).
        const body = await res.text();
        if (!/non-DEFAULT value|generated always/i.test(body)) throw new Error(`${t}: HTTP ${res.status} (check FK order, see header)`);
        const stripped = rows.slice(i, i + 500).map((r) => { const c = { ...r }; for (const k of manifest.tables[t].pk) delete c[k]; return c; });
        const r2 = await fetch(`${target}/rest/v1/${t}`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(stripped), signal: AbortSignal.timeout(60000) });
        if (!r2.ok) throw new Error(`${t}: HTTP ${r2.status} on identity retry`);
        console.log(`table ${t}: identity ids regenerated for batch at ${i}`);
      }
    }
  }
  console.log(apply ? 'restore complete' : 'dry run only; re-run with --apply to write');
}
main().catch((e) => { console.error('restore failed:', e.message); process.exit(1); });
