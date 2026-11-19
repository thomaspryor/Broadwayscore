#!/usr/bin/env node
/**
 * BRO-7857: close Predict the Score for every show whose first review is going live (Supabase reviews_live).
 * Runs before each production build (vercel-deploy.yml) and before live score payloads publish (rebuild-fast.yml),
 * so the server stops taking predictions as the review reaches the site. Reads data/shows.json + data/reviews.json.
 * Usage: node scripts/close-score-calls-on-reviews.mjs [--dry]
 * Output is COUNTS ONLY (the Actions log is public). Exit 1 on any HTTP failure, 2 on missing env or input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { countReviewsByShow, nyToday, reviewsLiveTargets } = require('./lib/score-call-forecasts.js');
const DRY = process.argv.includes('--dry');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let shows; let reviewCounts;
try {
  shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  reviewCounts = countReviewsByShow(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')));
} catch (e) { console.error(`cannot read core data (${String(e.message).slice(0, 80)}): nothing closed`); process.exit(2); }
const targets = reviewsLiveTargets({ shows, reviewCounts, today: nyToday() });
console.error(`shows with a review live in the call window: ${targets.length}${DRY ? ' (dry, nothing written)' : ''}`);
if (DRY || !targets.length) process.exit(0);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('missing Supabase env'); process.exit(2); }
const tally = {};
for (const id of targets) {
  let out;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/mark_score_call_reviews_live`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_show_id: id }) });
    out = res.ok ? await res.json() : `http_${res.status}`;
  } catch { out = 'http_error'; }
  tally[out] = (tally[out] || 0) + 1;
}
console.error(`closed: ${JSON.stringify(tally)}`);
if (Object.keys(tally).some((k) => k.startsWith('http_'))) process.exit(1);
