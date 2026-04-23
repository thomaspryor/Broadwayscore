/**
 * Multi-critic SERP per-critic routing.
 *
 * A single outlet+show Google SERP query returns only Google's top-ranked URL,
 * so the non-primary critic at a multi-critic outlet (NYT, Vulture, NYSR,
 * Theatrely) is silently dropped from discovery. Fix: when an outlet is in
 * MULTI_CRITIC_SERP_OUTLETS and has >1 critic, the gather SERP loop issues one
 * query per critic and dedups URLs.
 *
 * This test locks:
 *   (a) the decision helper — only the 4 named outlets go per-critic, and only
 *       when their critics list has >1 name;
 *   (b) that the allowlist names match real outlet IDs in critic-outlets.json
 *       (if one is renamed, the feature silently stops routing);
 *   (c) that the SERP loop in gather-reviews.js still wires the per-critic
 *       branch — if someone removes the `_shouldQueryPerCritic(...)` call or
 *       the `criticName: critic` push, per-critic discovery is dead.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const {
  MULTI_CRITIC_SERP_OUTLETS,
  shouldQueryPerCritic,
} = require(join(ROOT, 'scripts/lib/multi-critic-serp.js'));

test('allowlist contains NYT, Vulture, NYSR, Theatrely', () => {
  for (const id of ['nytimes', 'vulture', 'nystagereview', 'theatrely']) {
    assert.ok(
      MULTI_CRITIC_SERP_OUTLETS.has(id),
      `expected '${id}' in MULTI_CRITIC_SERP_OUTLETS`
    );
  }
});

test('shouldQueryPerCritic: allowlisted outlet with 2+ critics → true', () => {
  assert.strictEqual(shouldQueryPerCritic('nytimes', ['A', 'B']), true);
  assert.strictEqual(shouldQueryPerCritic('vulture', ['A', 'B', 'C']), true);
  assert.strictEqual(shouldQueryPerCritic('nystagereview', ['A', 'B', 'C', 'D', 'E', 'F']), true);
  assert.strictEqual(shouldQueryPerCritic('theatrely', ['A', 'B']), true);
});

test('shouldQueryPerCritic: allowlisted outlet with 1 or 0 critics → false', () => {
  // No point issuing N queries for an outlet with 1 critic — existing single-query path handles it.
  assert.strictEqual(shouldQueryPerCritic('nytimes', ['A']), false);
  assert.strictEqual(shouldQueryPerCritic('nytimes', []), false);
  assert.strictEqual(shouldQueryPerCritic('nytimes', null), false);
  assert.strictEqual(shouldQueryPerCritic('nytimes', undefined), false);
});

test('shouldQueryPerCritic: non-allowlisted outlet with 2+ critics → false', () => {
  // Variety, New Yorker, etc. have multiple critics but we explicitly don't route
  // them per-critic — keeps SERP budget bounded to the outlets where we've
  // observed silent multi-critic misses on opening night.
  assert.strictEqual(shouldQueryPerCritic('variety', ['Naveen Kumar', 'Frank Rizzo']), false);
  assert.strictEqual(shouldQueryPerCritic('newyorker', ['Helen Shaw', 'Vinson Cunningham']), false);
  assert.strictEqual(shouldQueryPerCritic('theatermania', ['A', 'B']), false);
});

test('shouldQueryPerCritic: bad input → false (no crash)', () => {
  assert.strictEqual(shouldQueryPerCritic('', ['A', 'B']), false);
  assert.strictEqual(shouldQueryPerCritic(null, ['A', 'B']), false);
  assert.strictEqual(shouldQueryPerCritic('nytimes', 'not-an-array'), false);
});

test('every allowlist id matches a real outlet id in critic-outlets.json', () => {
  // Drift guard: if critic-outlets.json renames one of these (e.g. 'theatrely'
  // → 'theatre-ly'), the feature silently stops routing per-critic because
  // no outlet's id.toLowerCase() matches. Fail loudly instead.
  const config = JSON.parse(
    readFileSync(join(ROOT, 'scripts/config/critic-outlets.json'), 'utf8')
  );
  const allOutlets = [
    ...(config.tier1 || []),
    ...(config.tier2 || []),
    ...(config.tier3 || []),
  ];
  const knownIds = new Set(allOutlets.map(o => (o.id || '').toLowerCase()));
  for (const id of MULTI_CRITIC_SERP_OUTLETS) {
    assert.ok(
      knownIds.has(id),
      `allowlist id '${id}' not found in critic-outlets.json — rename? remove from allowlist or fix the id`
    );
  }
});

test('every allowlist outlet actually has >1 critic today', () => {
  // Belt-and-braces: if a multi-critic outlet loses critics (e.g. one is deleted
  // from the list), shouldQueryPerCritic silently returns false for it and the
  // feature stops firing. Catch that config drift here.
  const config = JSON.parse(
    readFileSync(join(ROOT, 'scripts/config/critic-outlets.json'), 'utf8')
  );
  const allOutlets = [
    ...(config.tier1 || []),
    ...(config.tier2 || []),
    ...(config.tier3 || []),
  ];
  for (const id of MULTI_CRITIC_SERP_OUTLETS) {
    const outlet = allOutlets.find(o => (o.id || '').toLowerCase() === id);
    assert.ok(outlet, `allowlist id '${id}' missing from critic-outlets.json`);
    const critics = Array.isArray(outlet.critics) ? outlet.critics : [];
    assert.ok(
      critics.length > 1,
      `outlet '${id}' has ${critics.length} critic(s) — remove from MULTI_CRITIC_SERP_OUTLETS or restore critics`
    );
  }
});

test('gather-reviews.js still wires the per-critic branch into the SERP loop', () => {
  // Wiring regression: if the per-critic loop is removed or the `criticName:
  // critic` push is lost, per-critic discovery silently becomes a no-op. These
  // greps lock the integration to prevent that.
  const src = readFileSync(join(ROOT, 'scripts/gather-reviews.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/multi-critic-serp['"]\)/.test(src),
    'gather-reviews.js no longer requires ./lib/multi-critic-serp — decision helper disconnected'
  );
  assert.ok(
    /_shouldQueryPerCritic\s*\(/.test(src),
    'gather-reviews.js no longer calls _shouldQueryPerCritic in the SERP loop'
  );
  assert.ok(
    /serp-discovery-per-critic/.test(src),
    'gather-reviews.js no longer tags per-critic hits with source=serp-discovery-per-critic — ' +
      'per-critic branch has likely been removed'
  );
  assert.ok(
    /searchForReviewViaSERP\s*\([\s\S]{0,400}criticName:\s*critic/m.test(src),
    'gather-reviews.js no longer passes criticName into searchForReviewViaSERP — ' +
      'queries will fall back to Unknown-critic form and the feature is silently disabled'
  );
});

test('searchForReviewViaSERP accepts a criticName option', () => {
  // The per-critic branch relies on passing criticName through to
  // discoverCorrectUrl via this function. If the option is removed, per-critic
  // queries silently collapse to the generic outlet query.
  const src = readFileSync(join(ROOT, 'scripts/gather-reviews.js'), 'utf8');
  assert.ok(
    /async\s+function\s+searchForReviewViaSERP\s*\([^)]*\{[^}]*criticName/m.test(src),
    'searchForReviewViaSERP signature no longer destructures criticName from options'
  );
});

test('SERP loop short-circuits when both providers are unavailable (budget waste guard)', () => {
  // Ship-check P1 (2026-04-22): before this guard, a SERP-unavailable state
  // would still iterate all 6 NYSR critics + outlet fallback + every remaining
  // outlet — up to 100+ wasted calls × DELAY_MS sleeps per show. The fix:
  // searchForReviewViaSERP returns { unavailable: true } and the outer loop
  // sets serpUnavailable=true to abort. Lock both ends structurally.
  const src = readFileSync(join(ROOT, 'scripts/gather-reviews.js'), 'utf8');
  assert.ok(
    /return\s*\{\s*unavailable:\s*true\s*\}/.test(src),
    'searchForReviewViaSERP no longer returns { unavailable: true } — callers cannot distinguish no-results from provider outage'
  );
  assert.ok(
    /let\s+serpUnavailable\s*=\s*false/.test(src),
    'SERP loop no longer tracks a serpUnavailable flag — outage will burn full SERP budget'
  );
  assert.ok(
    /if\s*\(\s*serpUnavailable\s*\)\s*break/.test(src),
    'SERP outer loop no longer breaks on serpUnavailable — outage will still walk every outlet'
  );
  assert.ok(
    /result\s*&&\s*result\.unavailable/.test(src),
    'SERP loop no longer checks result.unavailable — unavailable state is being swallowed as "no hit"'
  );
});
