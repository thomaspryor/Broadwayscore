#!/usr/bin/env node
/**
 * Restore (un-pause) the Supabase project via the Management API.
 *
 * Free-tier projects auto-pause after ~7 days idle: the compute + DNS are torn
 * down, so the project host NXDOMAINs and NOBODY can sign in or read/write until
 * it's restored. This resumes it (data is preserved across a pause) and waits
 * for it to come back ACTIVE_HEALTHY.
 *
 * Requires: SUPABASE_ACCESS_TOKEN (management token), SUPABASE_PROJECT_REF
 *   (falls back to parsing the ref out of NEXT_PUBLIC_SUPABASE_URL).
 * Run:  node scripts/restore-supabase-project.mjs
 * Exit: 0 restored/already-active, 1 on failure.
 */

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
let REF = process.env.SUPABASE_PROJECT_REF;
if (!REF && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  REF = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
}
if (!TOKEN || !REF) {
  console.error('❌ Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF');
  process.exit(1);
}

const API = 'https://api.supabase.com/v1';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function status() {
  const r = await fetch(`${API}/projects`, { headers: H });
  const list = await r.json();
  return (Array.isArray(list) ? list : []).find(p => p.id === REF)?.status ?? 'UNKNOWN';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const before = await status();
  console.log(`Project ${REF} status: ${before}`);
  if (before === 'ACTIVE_HEALTHY') {
    console.log('✅ Already active — nothing to do.');
    return;
  }

  console.log('Requesting restore…');
  const res = await fetch(`${API}/projects/${REF}/restore`, { method: 'POST', headers: H, body: '{}' });
  if (!res.ok && res.status !== 409) { // 409 = already restoring
    console.error(`❌ Restore request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`Restore accepted (HTTP ${res.status}). Waiting for ACTIVE_HEALTHY (up to ~8 min)…`);

  const deadline = Date.now() + 8 * 60 * 1000;
  // NOTE: pass timestamps in via loop math only — no Date.now() drift concerns here.
  while (Date.now() < deadline) {
    await sleep(20000);
    const s = await status().catch(() => 'UNKNOWN');
    console.log(`  … ${s}`);
    if (s === 'ACTIVE_HEALTHY') {
      console.log('✅ Project is ACTIVE_HEALTHY — sign-in should work again.');
      return;
    }
  }
  console.error('❌ Timed out waiting for ACTIVE_HEALTHY. Check the Supabase dashboard.');
  process.exit(1);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
