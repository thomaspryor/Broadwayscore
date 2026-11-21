// BRO-5261 (BRO-3067 retro-review): reddit-api.js and five scrapers issued
// billed Bright Data requests without consulting the daily breaker / per-run
// budget (brightdata-caps.js consultBrightData), so a tripped breaker or a
// spent BD_REQ_BUDGET did not stop them. Sibling of
// bd-call-telemetry-coverage.test.mjs: a new direct BD caller without the
// consult fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paid endpoints only: page fetch (/request) and SERP (/serp/req).
const PAID_BD_RE = /api\.brightdata\.com\/(?:request|serp\/req)\b/;
const CONSULT_RE = /\bconsultBrightData\s*\(/;

const ALLOWED = new Map([
  ['evaluate-brightdata-serp.js', 'one-off manual provider evaluation script, not run by any workflow'],
  ['scrapingdog-bakeoff.js', 'manual provider bake-off tool, not run by any workflow'],
  ['check-cookie-health.js', 'credential health probe: one request per run, must still run while the breaker is tripped'],
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

test('every script calling a paid Bright Data endpoint consults the breaker and budget', () => {
  const offenders = [];
  const seenAllowed = new Set();
  for (const file of walk(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (!PAID_BD_RE.test(code) || CONSULT_RE.test(code)) continue;
    if (ALLOWED.has(rel)) { seenAllowed.add(rel); continue; }
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `These scripts call a paid Bright Data endpoint without consultBrightData(), so a tripped breaker or spent per-run budget does not stop them:\n  ${offenders.join('\n  ')}\n` +
    'Fix: call brightdata-caps consultBrightData({ zone }) before the request and skip BD when !allowed (see scraper.js fetchWithBrightData), or route through fetchPage().');
  const stale = [...ALLOWED.keys()].filter((k) => !seenAllowed.has(k));
  assert.deepEqual(stale, [], `Stale ALLOWED entries — remove them: ${stale.join(', ')}`);
});
