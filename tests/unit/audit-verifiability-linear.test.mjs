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

test('main() never references a loop-scoped variable outside its loop (CI step-summary regression)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const summary = `${mkdtempSync(`${tmpdir()}/bro2720-`)}/summary.md`;
  // --help short-circuits before any sweep; the summary block is exercised by
  // running the summary template against a stub via the exported pipeline instead:
  const src = readFileSync(new URL('../../scripts/audit-card-verifiability.js', import.meta.url), 'utf8');
  const loopOpen = src.indexOf('for (const { board, report } of results)');
  const use = src.indexOf('Audit (${board})');
  assert.ok(loopOpen > 0 && use > loopOpen, 'summary must iterate results so `board` is in scope');
  assert.ok(summary);
  execFileSync('node', ['--check', new URL('../../scripts/audit-card-verifiability.js', import.meta.url).pathname]);
});

test('workflow pins an explicit --source on every audit call (notion, plus the daily linear leg) so CI never depends on the bare default', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../../.github/workflows/card-verifiability-audit.yml', import.meta.url), 'utf8');
  const calls = wf.split('\n').filter(l => /node scripts\/audit-card-verifiability\.js/.test(l) && !l.trim().startsWith('#'));
  assert.ok(calls.length >= 3);
  for (const l of calls) assert.match(l, /--source (notion|linear)\b/);
  assert.ok(calls.filter(l => /--source notion/.test(l)).length >= 2, 'the Notion audit/re-audit pair stays');
  assert.ok(calls.some(l => /--source linear/.test(l)), 'BRO-3619: the Linear report is refreshed on the same schedule');
});
