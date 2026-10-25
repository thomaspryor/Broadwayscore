// BRO-4936: Bright Data twin of sb-call-telemetry-coverage.test.mjs. Seven
// direct api.brightdata.com/request callers (collect-review-texts tier 3, the
// audience scrapers, lottery-rush, cookie-health) billed Web Unlocker requests
// without writing a ledger row, so attributedPct.brightdata sat at 58-79%.
// A new direct BD caller without recordBdCall/recordProviderCall fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paid endpoints only: page fetch (/request) and SERP (/serp/req). The
// /zone*, /customer/balance billing reads are free.
const PAID_BD_RE = /api\.brightdata\.com\/(?:request|serp\/req)\b/;
const TELEMETRY_RE = /\brecord(?:Bd|Provider)Call\b/;

const ALLOWED = new Map([
  ['evaluate-brightdata-serp.js', 'one-off manual provider evaluation script, not run by any workflow'],
  ['scrapingdog-bakeoff.js', 'manual provider bake-off tool, not run by any workflow'],
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

test('every script calling a paid Bright Data endpoint records scraper-spend telemetry', () => {
  const offenders = [];
  const seenAllowed = new Set();
  for (const file of walk(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    // Only real call sites: a comment-only mention must not count.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (!PAID_BD_RE.test(code) || TELEMETRY_RE.test(code)) continue;
    if (ALLOWED.has(rel)) { seenAllowed.add(rel); continue; }
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `These scripts call a paid Bright Data endpoint but never call recordBdCall/recordProviderCall, so their spend never reaches data/audit/scraper-spend-ledger.jsonl:\n  ${offenders.join('\n  ')}\n` +
    'Fix: record each call via provider-telemetry recordBdCall, or route it through scraper.js fetchPage().');
  const stale = [...ALLOWED.keys()].filter((k) => !seenAllowed.has(k));
  assert.deepEqual(stale, [], `Stale ALLOWED entries — remove them: ${stale.join(', ')}`);
});
