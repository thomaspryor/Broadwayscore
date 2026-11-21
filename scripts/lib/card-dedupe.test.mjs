// BRO-5488: the pure front-door rules, on real titles from the 2026-10-09..16 board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const d = require('./card-dedupe.js');
const open = (identifier, title, type = 'backlog') => ({ identifier, title, state: { type } });

test('true repeats match: only a count or date changed', () => {
  for (const [a, b] of [
    ['Opening-night audit 2026-10-15', 'Opening-night audit 2026-10-15'],
    ['🚨 BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', '🚨 BSC Rebuild: 41 reviews dropped [SUSPICIOUS]'],
    ['Corpus drift: maybeUpgradeUrl() swapped a review URL for a PRIOR production', 'Corpus drift: maybeUpgradeUrl() swapped a review URL for a prior production'],
  ]) assert.ok(d.findNearDuplicate(a, [open('BRO-1', b)]), `${a} ~ ${b}`);
});

test('different subjects never match, even at high word overlap', () => {
  for (const [a, b] of [
    ['BSC Daily: Review gap — "Fences" missing 1 cited review(s)', 'BSC Daily: Review gap — "Into the Woods" missing 1 cited review(s)'],
    ['Fish: 4 roundup-listed review(s) still not captured', 'Triumph: 1 roundup-listed review(s) still not captured'],
    ['main test.yml red: Unit Tests / Run unit tests (no-data-dependency) — "no image file carries a hash rejected by eye"', 'main test.yml red: Unit Tests / Run unit tests (no-data-dependency) — "every emitted critic alias resolves"'],
    ['National tour pages show wrong information: 1 page problem(s) (stops-overlap)', 'National tour pages show wrong information: 1 page problem(s) (stops-before-open)'],
    ['Fix flaky test', 'Fix flaky tests'],
    ['Opening-night watch 2026-10-09', 'Opening-night watch 2026-10-08'],
  ]) assert.equal(d.findNearDuplicate(a, [open('BRO-1', b)]), null, `${a} !~ ${b}`);
});

test('diacritics fold (task #648 class) and rollup cards are never a near-dup target', () => {
  assert.ok(d.findNearDuplicate('Café Society page shows wrong closing date', [open('BRO-1', 'Cafe Society page shows wrong closing date')]));
  assert.equal(d.findNearDuplicate('Rollup (workflow:X): roundup listed review captured', [open('BRO-1', 'Rollup (workflow:X): roundup listed review captured')]), null);
});

test('serves filter: a started card is never returned', () => {
  const m = d.findNearDuplicate('Opening-night audit 2026-10-15', [open('BRO-1', 'Opening-night audit 2026-10-15', 'started')], (c) => c.state.type !== 'started');
  assert.equal(m, null);
});

test('titleKind groups a flood across subjects', () => {
  assert.equal(d.titleKind('BSC Daily: Review gap — "The Wiz" missing 6 cited review(s)'), d.titleKind('Review gap — "Tru" missing 3 cited review(s)'));
  assert.equal(d.titleKind('Fish: 4 roundup-listed review(s) still not captured'), d.titleKind('The Ask: 5 roundup-listed review(s) still not captured'));
  assert.notEqual(d.titleKind('Data: closed national tour lists new dates'), d.titleKind('Data: OB shows no closing signal can detect'));
});

test('inferCardSource: title and body rules beat the caller, footer beats everything', () => {
  assert.equal(d.inferCardSource({ title: '[E2E Canary] alert chain check 2026-10-16T07:12:06.984Z', source: 'alert-router' }), 'e2e-canary');
  assert.equal(d.inferCardSource({ title: 'BSC Daily: Data: tour dates need a look', source: 'workflow:Daily' }), 'digest-autofix');
  assert.equal(d.inferCardSource({ title: 'x', description: 'Auto-filed by owner-alert-router (condition: k)' }), 'alert-router');
  assert.equal(d.inferCardSource({ title: 'main test.yml red: E2E Tests / Run E2E tests' }), 'ci-red');
  assert.equal(d.inferCardSource({ title: 'anything', source: 'session' }), 'session');
  assert.equal(d.inferCardSource({ title: 'anything' }), 'unknown');
  assert.equal(d.inferCardSource({ title: 'BSC Daily: x', description: `body\n\n${d.sourceFooter('workflow:Y', 'k')}` }), 'workflow:Y');
  assert.deepEqual(d.parseSourceFooter(`a\n\n${d.sourceFooter('session', 'opening night audit')}`), { source: 'session', kind: 'opening night audit' });
});

test('countSameKind: only the 24h window, same source and kind, rollups excluded', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const card = (title, h, src = 'workflow:A') => ({ title, createdAt: new Date(now - h * 3600e3).toISOString(), description: d.sourceFooter(src, d.titleKind(title)) });
  const recent = [
    card('Fish: 1 roundup-listed review(s) still not captured', 1),
    card('Soon: 1 roundup-listed review(s) still not captured', 23),
    card('Old: 1 roundup-listed review(s) still not captured', 25),
    card('Other: 1 roundup-listed review(s) still not captured', 2, 'session'),
    card('Rollup (workflow:A): roundup listed review captured', 1),
  ];
  assert.equal(d.countSameKind({ source: 'workflow:A', kind: d.titleKind('X: 2 roundup-listed review(s) still not captured'), recent, nowMs: now }), 2);
});

test('rollupEnforced: workflow filers without a per-card contract only', () => {
  assert.equal(d.rollupEnforced({ source: 'workflow:Audit', description: 'plain' }), true);
  assert.equal(d.rollupEnforced({ source: 'workflow:Audit', description: 'Auto-filed by digest-autofix' }), false);
  assert.equal(d.rollupEnforced({ source: 'session', description: 'plain' }), false);
  assert.equal(d.rollupEnforced({ source: 'alert-router', description: 'plain' }), false);
});

test('BRO-5488 review: numbers that name a subject never merge; counts do', () => {
  const d = require('./card-dedupe.js');
  const same = (a, b) => d.countFreeTitle(a) === d.countFreeTitle(b);
  assert.ok(same('BSC Daily: Star-band detector: 21 review(s) outside band', 'BSC Daily: Star-band detector: 22 review(s) outside band'));
  assert.ok(same('Overdue P0/P1 queue: 1 P0 waiting', 'Overdue P0/P1 queue: 3 P0 waiting'));
  assert.ok(same('Review gap — "Tru" missing 1 cited review(s)', 'Review gap — "Tru" missing 2 cited review(s)'));
  assert.ok(same('BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]'));
  assert.ok(same('Rebuild dropped 41 reviews on the show pages', 'Rebuild dropped 49 reviews on the show pages'));
  assert.ok(same('Fix 3 broken links on venue pages', 'Fix 5 broken links on venue pages'));
  for (const [a, b] of [
    ['Fix login crash v2 on show page', 'Fix login crash v3 on show page'],
    ['PR #1842 failing lint checks', 'PR #1843 failing lint checks'],
    ['Tony Awards 2025 predictions page', 'Tony Awards 2026 predictions page'],
    ['P0 incident on the show page', 'P1 incident on the show page'],
    ['Opening-night watch 2026-10-09', 'Opening-night watch 2026-10-10'],
    ['Deploy at 14:00 failed on Vercel', 'Deploy at 15:00 failed on Vercel'],
    ['Phase 2 rollout of score pages', 'Phase 3 rollout of score pages'],
    ['Phase 2 tasks pending on the show page', 'Phase 3 tasks pending on the show page'],
    ['HTTP 403 errors from Playbill scraper fetch', 'HTTP 429 errors from Playbill scraper fetch'],
    ['Error: 500 from scraper fetchPage path', 'Error: 404 from scraper fetchPage path'],
    ['Node 20 builds fail on CI runner', 'Node 22 builds fail on CI runner'],
    ['Port 3000 tests hang in the dev server', 'Port 3456 tests hang in the dev server'],
    ['Fix 404 on show pages', 'Fix 500 on show pages'],
    ['Bright Data web_unlocker1 zone exhausted', 'Bright Data web_unlocker2 zone exhausted'],
    ['Upgrade to Next.js 14 for the app router', 'Upgrade to Next.js 15 for the app router'],
    ['P0: scraper outage on reviews', 'P1: scraper outage on reviews'],
  ]) {
    assert.ok(!same(a, b), `count-only: ${a} vs ${b}`);
    assert.equal(d.findNearDuplicate(a, [{ identifier: 'BRO-1', title: b }]), null, `near-dup: ${a} vs ${b}`);
  }
});

test('numberFreeTitle: collapses live counts, keeps numbers that name something (BRO-6081)', () => {
  const { numberFreeTitle: n } = require('./card-dedupe.js');
  assert.equal(n('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (2194/1750 reqs)'), n('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (2126/1750 reqs)'));
  assert.equal(n('BSC Daily: 1 review(s) for x stuck'), n('BSC Daily: 2 review(s) for x stuck'));
  assert.notEqual(n('breaker TRIPPED: web_unlocker2 (1/2 reqs)'), n('breaker TRIPPED: web_unlocker3 (1/2 reqs)'));
  assert.notEqual(n('1 review(s) for hay-fever-west-end-2026'), n('1 review(s) for hay-fever-west-end-2027'));
  assert.notEqual(n('CANARY: touch data/audit/canary-2026-10-24.marker'), n('CANARY: touch data/audit/canary-2026-10-21.marker'));
  assert.notEqual(n('BSC Daily: Review gaps (batch 2)'), n('BSC Daily: Review gaps (batch 3)'));
  assert.notEqual(n('Fix card #794 now'), n('Fix card #795 now'));
  assert.notEqual(n('P0: thing'), n('P1: thing'));
  assert.notEqual(n('since 2026-10-19 x'), n('since 2026-10-20 x'));
});

// BRO-6130 step 5: the 14-day digest-autofix duplicates (BRO-5757/5827/6059 breaker cards) differed only by a live
// count in the title. Pin the key that find --ignore-numbers matches on, and that the one fileCard caller opts in.
test('numberFreeTitle: the same health row on different days shares one dedupe key', async () => {
  const dedupe = (await import('node:module')).createRequire(import.meta.url)('./card-dedupe.js');
  assert.equal(
    dedupe.numberFreeTitle('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (2126/1750 reqs)'),
    dedupe.numberFreeTitle('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (2194/1750 reqs)'),
  );
  assert.notEqual(
    dedupe.numberFreeTitle('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (2126/1750 reqs)'),
    dedupe.numberFreeTitle('BSC Daily: Corpus drift: review files with wrongProduction provenance (12 files)'),
  );
});

test('digest-autofix files every row with ignoreNumbers so a changing count cannot mint a daily duplicate', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./digest-autofix.js', import.meta.url), 'utf8');
  const callSites = [...src.matchAll(/= fileCardFn\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(callSites.length >= 1, 'expected at least one fileCard( call site');
  for (const c of callSites) assert.match(c, /ignoreNumbers: true/);
});
