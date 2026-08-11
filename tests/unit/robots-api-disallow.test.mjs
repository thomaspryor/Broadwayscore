// robots.txt must keep /api/ out of every crawler's reach.
//
// 2026-08-11: GSC emailed "New reason preventing your pages from being indexed —
// Blocked due to other 4xx issue". URL Inspection pinned it to
// https://broadwayscorecard.com/api/submit-review (pageFetchState BLOCKED_4XX,
// referred from the indexed /submit-review page, which renders the endpoint path
// into its HTML). The route is POST-only, so Googlebot's GET got a 405.
// robots.ts had no /api/ disallow, so every API route — webhooks, admin actions,
// POST-only form handlers — was crawlable and could repeat the same report.
//
// This test loads the REAL robots() function (TS type syntax stripped, the
// sitemap-shards alias stubbed) and asserts the invariant on its actual output,
// so a new rule added without the /api/ disallow fails CI.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src/app/robots.ts');

async function loadRobots() {
  const ts = fs.readFileSync(SRC, 'utf8');
  const js = ts
    // `import { MetadataRoute } from 'next'` is type-only and has no runtime shape.
    .replace(/^import\s+\{[^}]*\}\s+from\s+'next';\s*$/m, '')
    // Stub the '@/...' alias — the test only needs the shard count, not the labels.
    .replace(
      /^import\s+\{\s*SITEMAP_SHARDS\s*\}\s+from\s+'@\/config\/sitemap-shards';\s*$/m,
      'const SITEMAP_SHARDS = new Array(9).fill({ name: "shard" });'
    )
    .replace(/:\s*MetadataRoute\.Robots\b/g, '');
  const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  return mod.default;
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

test('every crawlable user-agent rule disallows /api/', async () => {
  const robots = await loadRobots();
  const { rules } = robots();
  assert.ok(Array.isArray(rules) && rules.length > 0, 'production robots() must return a rules array');

  const offenders = rules
    // Bots blocked site-wide (`Disallow: /`) already cover /api/.
    .filter((r) => !toArray(r.disallow).includes('/'))
    .filter((r) => !toArray(r.disallow).includes('/api/'))
    .map((r) => r.userAgent);

  assert.deepStrictEqual(
    offenders,
    [],
    `These user-agent rules can crawl /api/ — a POST-only route returns 405 and GSC reports ` +
      `"Blocked due to other 4xx issue". Add '/api/' to disallow: ${offenders.join(', ')}`
  );
});

test('/api/badge/ stays crawlable wherever /api/ is disallowed', async () => {
  const robots = await loadRobots();
  const { rules } = robots();

  // The badge route serves real SVGs embedded on third-party sites; the blanket
  // /api/ disallow must not take those down with it. A longer Allow beats a
  // shorter Disallow in Google's most-specific-match rule.
  const missing = rules
    .filter((r) => toArray(r.disallow).includes('/api/'))
    .filter((r) => !toArray(r.allow).includes('/api/badge/'))
    .map((r) => r.userAgent);

  assert.deepStrictEqual(missing, [], `Missing 'Allow: /api/badge/' alongside the /api/ disallow: ${missing.join(', ')}`);
});

test('non-production robots() still blocks the whole site', async () => {
  // Preview/staging deploys must never be indexed; the /api/ work above sits in
  // the production branch only, so guard that the early return is intact.
  const robots = await loadRobots();
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /if \(!isProduction\)[\s\S]{0,160}disallow: '\/'/, 'preview deploys must keep the site-wide disallow');
  assert.ok(typeof robots === 'function');
});
