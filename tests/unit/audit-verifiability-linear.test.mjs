// BRO-2720: the bare `audit-card-verifiability.js` must report a Linear
// population, not only the retired Notion board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const audit = require('../../scripts/audit-card-verifiability.js');

test('default source sweeps both boards, Linear included', () => {
  assert.equal(audit.DEFAULT_SOURCE, 'all');
  assert.deepEqual(audit.boardsForSource(audit.DEFAULT_SOURCE).sort(), ['linear', 'notion']);
});

test('named source runs only that board', () => {
  assert.deepEqual(audit.boardsForSource('notion'), ['notion']);
  assert.deepEqual(audit.boardsForSource('linear'), ['linear']);
});

test('Linear issues evaluate to BRO-prefixed ids and land in the refused list', () => {
  const ev = audit.evaluateLinearIssue({
    identifier: 'BRO-2642', title: 'no criteria', url: 'https://linear.app/x', description: 'just prose, no command',
    state: { name: 'Todo' },
  });
  assert.equal(ev.armed, false);
  const report = audit.buildReport([ev]);
  assert.equal(report.refused[0].id, 'BRO-2642');
});

test('boardBreakdown reports per-board counts and refused percentage', () => {
  const b = audit.boardBreakdown([
    { board: 'linear', report: { total: 200, armedCount: 150, refusedCount: 50 } },
    { board: 'notion', report: { total: 0, armedCount: 0, refusedCount: 0 } },
  ]);
  assert.deepEqual(b.linear, { total: 200, armed: 150, refused: 50, refusedPct: 25 });
  assert.equal(b.notion.refusedPct, 0);
  const text = audit.formatBoardBreakdown(b, [{ board: 'notion', message: 'boom' }]);
  assert.match(text, /linear: total 200, armed 150, refused 50 \(25%\)/);
  assert.match(text, /notion: sweep FAILED/);
});
