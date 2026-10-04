// BRO-3619: cardVerifiabilityBacklogResults must surface the vacuousChecks
// bucket (BRO-3378) for BOTH providers and read the Linear report at all —
// before this, 31 armed-but-vacuous Linear cards had no digest row.
// Refused-bucket + drain-metric coverage lives in
// health-check-repeat-failures.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardVerifiabilityBacklogResults } = require('../../scripts/health-check.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const NOW = Date.parse('2026-10-04T12:00:00Z');
const FRESH = '2026-10-04T05:40:00Z';

const vacuousCard = (id, polarity = 'never-fails') => ({
  id, name: `Card ${id}`, cmd: 'test -f scripts/already-there.js', kind: 'test-f-satisfied', polarity,
});

test('vacuousChecks: empty buckets in both reports yield no rows', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 10, refused: [], vacuousChecks: [] }, null,
    { generatedAt: FRESH, total: 10, refused: [], vacuousChecks: [] }, NOW,
  );
  assert.deepEqual(rows, []);
});

test('vacuousChecks: older reports with no vacuousChecks key stay silent', () => {
  assert.deepEqual(cardVerifiabilityBacklogResults({ total: 3, refused: [] }, null, { generatedAt: FRESH, total: 3, refused: [] }, NOW), []);
});

test('vacuousChecks: non-empty Notion bucket warns with polarity split', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 300, refused: [], vacuousChecks: [vacuousCard('n1'), vacuousCard('n2'), vacuousCard('n3', 'never-passes')] },
    null, null, NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: armed-but-vacuous card checks (Notion)');
  assert.equal(rows[0].status, 'warn');
  assert.match(rows[0].message, /^3 armed Notion card/);
  assert.match(rows[0].message, /2 can never fail, 1 can never pass/);
  assert.match(rows[0].message, /n1 Card n1 — test -f scripts\/already-there\.js/);
});

test('vacuousChecks: non-empty Linear bucket warns and points at --rearm --dry-run', () => {
  const rows = cardVerifiabilityBacklogResults(
    null, null,
    { generatedAt: FRESH, total: 1214, refused: [], vacuousChecks: Array.from({ length: 31 }, (_, i) => vacuousCard(`BRO-${i + 1}`)) },
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: armed-but-vacuous card checks (Linear)');
  assert.match(rows[0].message, /^31 armed Linear issue/);
  assert.match(rows[0].hint, /enrich-card-acceptance\.js --source linear --rearm --dry-run/);
});

test('Linear report is read: its refused bucket gets its own row', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 5, refused: [{ name: 'Notion card', priority: 'P2', kind: 'no-section' }] },
    null,
    { generatedAt: FRESH, total: 300, refused: [{ id: 'BRO-9', name: 'Linear card', priority: 'High', kind: 'prose-only' }] },
    NOW,
  );
  const names = rows.map(r => r.name);
  assert.deepEqual(names, ['Data: undispatchable backlog cards', 'Data: undispatchable backlog cards (Linear)']);
  const lin = rows[1];
  assert.match(lin.message, /1 of 300 open Linear issue/);
  assert.match(lin.message, /\[High\] BRO-9 Linear card/);
  assert.match(lin.hint, /--source linear/);
});

test('both providers vacuous at once: two separate rows', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 5, refused: [], vacuousChecks: [vacuousCard('n1')] }, null,
    { generatedAt: FRESH, total: 5, refused: [], vacuousChecks: [vacuousCard('BRO-1')] }, NOW,
  );
  assert.deepEqual(rows.map(r => r.name), [
    'Data: armed-but-vacuous card checks (Notion)',
    'Data: armed-but-vacuous card checks (Linear)',
  ]);
});

test('stale Linear report (>72h) warns so a broken refresh cannot freeze the counts', () => {
  const rows = cardVerifiabilityBacklogResults(null, null,
    { generatedAt: '2026-09-15T16:33:26Z', total: 1, refused: [], vacuousChecks: [] }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Data: Linear card-verifiability report stale');
  assert.match(rows[0].message, /\d+h old/);
  const fresh = cardVerifiabilityBacklogResults(null, null,
    { generatedAt: '2026-10-02T12:00:00Z', total: 1, refused: [], vacuousChecks: [] }, NOW);
  assert.deepEqual(fresh, []);
});

test('every card-verifiability row is classified internal (work queue, not visitor-facing)', () => {
  const rows = cardVerifiabilityBacklogResults(
    { total: 5, refused: [{ name: 'a' }], vacuousChecks: [vacuousCard('n1')] },
    { humanGatedSkips: [{ id: '1', codes: ['X'] }] },
    { generatedAt: '2020-01-01T00:00:00Z', total: 5, refused: [{ id: 'BRO-1', name: 'b' }], vacuousChecks: [vacuousCard('BRO-2')] },
    NOW,
  );
  assert.equal(rows.length, 6);
  for (const r of rows) assert.equal(classifyHealthCheck(r.name), 'internal', r.name);
});
