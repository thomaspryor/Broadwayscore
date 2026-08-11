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
// Run via `npx tsx --test` (registered in tests/unit-test-manifest-tsx.txt), so
// this imports the real robots() and asserts on its actual output.
import { test } from 'node:test';
import assert from 'node:assert';
import robots from '../../src/app/robots';

type Rule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function productionRules(): Rule[] {
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  try {
    const { rules } = robots();
    return (Array.isArray(rules) ? rules : [rules]) as Rule[];
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
}

function agentName(rule: Rule): string {
  return toArray(rule.userAgent).join(',');
}

test('every crawlable user-agent rule disallows /api/', () => {
  const rules = productionRules();
  assert.ok(rules.length > 0, 'production robots() must return a rules array');

  const offenders = rules
    // Bots blocked site-wide (`Disallow: /`) already cover /api/.
    .filter((r) => !toArray(r.disallow).includes('/'))
    .filter((r) => !toArray(r.disallow).includes('/api/'))
    .map(agentName);

  assert.deepStrictEqual(
    offenders,
    [],
    `These user-agent rules can crawl /api/ — a POST-only route returns 405 and GSC reports ` +
      `"Blocked due to other 4xx issue". Add '/api/' to disallow: ${offenders.join(', ')}`
  );
});

test('/api/badge/ stays crawlable wherever /api/ is disallowed', () => {
  // The badge route serves real SVGs embedded on third-party sites; the blanket
  // /api/ disallow must not take those down with it. A longer Allow beats a
  // shorter Disallow under RFC 9309 longest-match.
  const missing = productionRules()
    .filter((r) => toArray(r.disallow).includes('/api/'))
    .filter((r) => !toArray(r.allow).includes('/api/badge/'))
    .map(agentName);

  assert.deepStrictEqual(missing, [], `Missing 'Allow: /api/badge/' alongside the /api/ disallow: ${missing.join(', ')}`);
});

test('Googlebot keeps its extra internal-page blocks on top of the shared surface', () => {
  // The shared CRAWLABLE_SURFACE is spread into each rule; Googlebot overrides
  // `disallow` to append its own entries. A bad spread order would silently drop
  // either the shared /api/ block or these two, so pin both halves.
  const googlebot = productionRules().find((r) => agentName(r) === 'Googlebot');
  assert.ok(googlebot, 'Googlebot rule must exist');

  const disallow = toArray(googlebot!.disallow);
  for (const path of ['/api/', '/admin/', '/status.html', '/opening-night-status.json']) {
    assert.ok(disallow.includes(path), `Googlebot must disallow ${path} — got ${disallow.join(', ')}`);
  }
});

test('preview/staging deploys block the whole site', () => {
  // Non-production must never be indexed. isProduction is read per call, so
  // flipping VERCEL_ENV exercises the real branch rather than matching source text.
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  try {
    const { rules } = robots();
    const list = (Array.isArray(rules) ? rules : [rules]) as Rule[];
    assert.strictEqual(list.length, 1, 'preview robots() must emit exactly one blanket rule');
    assert.strictEqual(agentName(list[0]), '*');
    assert.deepStrictEqual(toArray(list[0].disallow), ['/']);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});
