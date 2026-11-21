// BRO-8000 class guard: Internet Archive CDX auth refusal classification, and no
// script grows a private CDX caller that misreads it as "error"/"no capture".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AC = require('./archive-cdx.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('classifier: CDX 403 body and availability upstream_error are archive_auth_required; other failures are not', () => {
  assert.equal(AC.classifyArchiveResponse(403, '<p>This type of CDX query requires authorization.</p>'), 'archive_auth_required');
  assert.equal(AC.classifyArchiveResponse(200, '{"error":{"code":"upstream_error","message":"query failed with status_code=403"}}'), 'archive_auth_required');
  assert.equal(AC.classifyArchiveResponse(503, 'busy'), null);
  assert.equal(AC.classifyArchiveResponse(403, '<title>403 Forbidden</title> cloudflare'), null);
  assert.equal(AC.classifyArchiveResponse(200, 'https://x.com/a 2020 200'), null);
});

test('fetchArchiveIndex returns a typed result, not an error or empty text', async () => {
  const mk = (status, body) => async () => new Response(body, { status });
  const a = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(403, 'This type of CDX query requires authorization.') });
  assert.deepEqual([a.ok, a.kind], [false, 'archive_auth_required']);
  const b = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(503, 'x') });
  assert.equal(b.kind, 'http_error');
  const c = await AC.fetchArchiveIndex('https://web.archive.org/cdx/search/cdx?url=x', { fetchImpl: mk(200, 'rows') });
  assert.deepEqual([c.ok, c.text], [true, 'rows']);
  await assert.rejects(AC.fetchArchiveIndexText('u', { fetchImpl: mk(403, 'requires authorization') }), (e) => e.kind === 'archive_auth_required');
});

// Files that call the CDX/availability API. Migrated ones must use archive-cdx.js;
// the rest are a frozen baseline: a NEW file calling CDX directly fails here.
const MIGRATED = ['lib/gap-url-find.js', 'lib/fetch-archive-fallback.js'];
const BASELINE_UNMIGRATED = new Set([
  'backfill-review-dates.js', 'outlet-census.js', 'recover-wayback-reviews.js', 'recover-explicit-ratings.js', 'check-byline-evidence.js',
  'verify-showscore-stars.js', 'fetch-from-wayback.js', 'build-we-olt-season.js', 'backfill-network-tier-dates.js', 'recover-login-page-reviews.js',
  'collect-review-texts.js', 'review-forecast-v2-wayback-sweep.js', 'review-factcheck/fetch-pages.js', 'lib/trade-press-scraper.js',
  'lib/commercial-source-verify.js', 'lib/fallback-publish-date.js',
]);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'llm-scoring'].includes(e.name)) walk(p, out); } else if (/\.(js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

test('every CDX caller uses archive-cdx.js, or is in the frozen baseline', () => {
  const users = walk(root).filter((p) => /cdx\/search|wayback\/available/.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(root, p)).filter((p) => p !== 'lib/archive-cdx.js');
  for (const m of MIGRATED) assert.ok(fs.readFileSync(path.join(root, m), 'utf8').includes('archive-cdx'), `${m} must use archive-cdx.js`);
  const fresh = users.filter((p) => !MIGRATED.includes(p) && !BASELINE_UNMIGRATED.has(p));
  assert.deepEqual(fresh, [], `new direct CDX caller(s): route through scripts/lib/archive-cdx.js (${fresh.join(', ')})`);
});
