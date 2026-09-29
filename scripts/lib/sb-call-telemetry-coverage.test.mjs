// BRO-4215: every script that calls a PAID ScrapingBee endpoint must write a
// scraper-spend ledger row (recordSbCall / recordProviderCall). The static
// ledger-coverage guard (ledger-coverage-check.js) only proves a workflow
// COMMITS the rows a script writes; it cannot see a script that never writes
// any. That second hole is how check-cookie-health.js's twice-weekly premium
// probes (25 credits each) stayed invisible. This test closes it: a new
// direct SB caller without telemetry fails CI instead of silently leaking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paid API calls only. /api/v1/usage is a free balance check.
const PAID_SB_RE = /app\.scrapingbee\.com\/api\/v1\/(?!usage)/;
const TELEMETRY_RE = /\brecord(?:Sb|Provider)Call\b/;

// Files allowed to reference a paid SB endpoint without writing telemetry.
// Each needs a reason; keep this list short.
const ALLOWED = new Map([
  ['verify-reviews.ts', 'manual workflow_dispatch only (verify-reviews.yml), render_js=false (1 credit), a handful of calls per run'],
  ['evaluate-brightdata-serp.js', 'one-off manual provider evaluation script, not run by any workflow'],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(entry.name) && !/\.test\.(mjs|js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every script calling a paid ScrapingBee endpoint records scraper-spend telemetry', () => {
  const offenders = [];
  const seenAllowed = new Set();
  for (const file of walk(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    if (!PAID_SB_RE.test(src) || TELEMETRY_RE.test(src)) continue;
    if (ALLOWED.has(rel)) { seenAllowed.add(rel); continue; }
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `These scripts call a paid ScrapingBee endpoint but never call recordSbCall/recordProviderCall, so their spend never reaches data/audit/scraper-spend-ledger.jsonl:\n  ${offenders.join('\n  ')}\n` +
    'Fix: record each call via provider-telemetry (credits via sbBilledCredits), or route it through scraper.js fetchPage().');
  const stale = [...ALLOWED.keys()].filter((k) => !seenAllowed.has(k));
  assert.deepEqual(stale, [], `Stale ALLOWED entries (file gone, or it now records telemetry) — remove them: ${stale.join(', ')}`);
});
