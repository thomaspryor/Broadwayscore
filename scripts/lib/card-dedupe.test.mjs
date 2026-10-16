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
