#!/usr/bin/env node
/**
 * BRO-7350: sync pilot-ledger forecasts into Supabase score_call_shows (service role only).
 * Usage: node scripts/sync-score-call-forecasts.mjs --dir=<core-data>/review-forecast-pilot [--dry]
 * Output is COUNTS ONLY. Aborts without writing when the ledger is empty.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSyncRows, countReviewsByShow } = require('./lib/score-call-forecasts.js');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry');
const DIR = arg('dir');
if (!DIR) { console.error('--dir required'); process.exit(2); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LEDGER = path.join(DIR, 'ledger');
const rows = [];
if (fs.existsSync(LEDGER)) {
  for (const f of fs.readdirSync(LEDGER).filter((x) => x.endsWith('.jsonl')).sort()) {
    fs.readFileSync(path.join(LEDGER, f), 'utf8').split('\n').forEach((l, i) => {
      if (!l) return;
      // The Actions log is public: never echo a line or a parser message (it quotes the input).
      try { rows.push(JSON.parse(l)); } catch { console.error(`unreadable ledger line ${f}:${i + 1}`); }
    });
  }
}
if (!rows.length) { console.error('ledger empty: nothing synced'); process.exit(0); }
const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const today = new Date().toISOString().slice(0, 10);
let reviewCounts;
try { reviewCounts = countReviewsByShow(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'))); }
catch (e) { console.error(`cannot count reviews (${e.message.slice(0, 80)}): nothing synced`); process.exit(1); }
const sync = buildSyncRows({ shows, ledgerRows: rows, today, reviewCounts });
console.error(`ledger rows ${rows.length}, open shows to sync ${sync.length}${DRY ? ' (dry, nothing written)' : ''}`);
if (DRY) process.exit(0);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('missing Supabase env'); process.exit(2); }
const tally = {};
for (const body of sync) {
  const res = await fetch(`${url}/rest/v1/rpc/sync_score_call_show`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = res.ok ? await res.json() : `http_${res.status}`;
  tally[out] = (tally[out] || 0) + 1;
}
console.error(`synced: ${JSON.stringify(tally)}`);
if (tally.http_401 || tally.http_403 || Object.keys(tally).some((k) => k.startsWith('http_'))) process.exit(1);
