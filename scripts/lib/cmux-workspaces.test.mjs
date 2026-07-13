import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseWorkspaces, isDoneTitle, hasRunningClaude } = require('./cmux-workspaces.js');

// Captured from `cmux list-workspaces` 2026-07-12 (cmux 0.64.6)
const LIST_SAMPLE = `  workspace:2  ⠂ Box office card improvements
  workspace:36  Autonomous loop — Sprint 2
* workspace:31  Build: Autonomous nightly loop (v4) — 5 sprints  [selected]
  workspace:39  wrap-up skill: DEFERRED items should dispatch via
  workspace:27  ✳ CC improvements
  workspace:15  ✅ Backup check
`;

test('parseWorkspaces extracts ref, title, selected from real output', () => {
  const ws = parseWorkspaces(LIST_SAMPLE);
  assert.equal(ws.length, 6);
  assert.deepEqual(ws[0], { ref: 'workspace:2', title: '⠂ Box office card improvements', selected: false });
  assert.equal(ws[2].ref, 'workspace:31');
  assert.equal(ws[2].selected, true);
  assert.equal(ws[2].title, 'Build: Autonomous nightly loop (v4) — 5 sprints');
  assert.equal(ws[5].title, '✅ Backup check');
});

test('parseWorkspaces ignores non-workspace lines', () => {
  assert.deepEqual(parseWorkspaces('no workspaces\n\n'), []);
});

test('isDoneTitle: leading ✅ (with or without activity glyph) is done', () => {
  assert.equal(isDoneTitle('✅ Backup check'), true);
  assert.equal(isDoneTitle('⠂ ✅ finished thing'), true);   // spinner prefix from cmux
  assert.equal(isDoneTitle('✳ ✅ done'), true);
});

test('isDoneTitle: un-marked and mid-title ✅ are NOT done', () => {
  assert.equal(isDoneTitle('Build: Autonomous nightly loop'), false);
  assert.equal(isDoneTitle('⠂ Box office card improvements'), false);
  assert.equal(isDoneTitle('Fix the ✅ checkmark rendering bug'), false);
});

// Captured from `cmux top --workspace workspace:39 --processes --format tsv`
const TOP_RUNNING = `5.9\t532185088\t11\tworkspace\tworkspace:39\twindow:1\twrap-up skill
5.8\t527663104\t7\ttag\tworkspace:366F394E:tag:claude_code\tworkspace:39\tRunning
5.8\t432324608\t1\tprocess\t22146\tworkspace:366F394E:tag:claude_code\t2.1.207`;

const TOP_IDLE = `0.1\t5321850\t2\tworkspace\tworkspace:12\twindow:1\tRedesign show pages
0.0\t2605056\t1\tprocess\t47468\tworkspace:12\tzsh`;

test('hasRunningClaude: detects the claude_code Running tag row', () => {
  assert.equal(hasRunningClaude(TOP_RUNNING), true);
  assert.equal(hasRunningClaude(TOP_IDLE), false);
  assert.equal(hasRunningClaude(''), false);
});
