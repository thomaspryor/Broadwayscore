// BRO-4408: opening-night-poller.yml must drain _pending/ no-byline strands
// for the in-window shows before the poll loop, with the BD breaker exemption.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = fs.readFileSync(path.join(here, '../../.github/workflows/opening-night-poller.yml'), 'utf8');

// Split the steps of the job by "      - name:" markers (6-space indent).
const steps = wf.split(/\n(?=      - name: )/).slice(1).map(s => ({
  name: s.match(/^      - name: (.*)/)[1],
  body: s,
}));
const idx = (pred) => steps.findIndex(pred);

const drainIdx = idx(s => s.name.startsWith('Drain pending no-byline reviews (in-window'));
const pollIdx = idx(s => /^\s+id: poll$/m.test(s.body));
const commitIdx = idx(s => s.name === 'Commit new review files');
const collectIdx = idx(s => s.name === 'Collect full text inline');

test('a replay-pending-bylines step exists', () => {
  assert.ok(drainIdx >= 0);
  assert.match(steps[drainIdx].body, /run: node scripts\/replay-pending-bylines\.js/);
});

test('replay receives the in-window show list (find step output), not --all-*', () => {
  const b = steps[drainIdx].body;
  assert.match(b, /IN_WINDOW_SHOWS: \$\{\{ steps\.find\.outputs\.shows \}\}/);
  assert.match(b, /--shows="\$IN_WINDOW_SHOWS"/);
  assert.doesNotMatch(b, /run: .*\$\{\{/, 'no expression interpolation inside the shell command');
  assert.doesNotMatch(b, /--all-(open|pending|opera)/);
  assert.match(b, /--time-budget-min=\d+/);
});

test('replay runs before the poll loop, so any_new sees its promotions, and before commit + collect', () => {
  assert.ok(pollIdx >= 0 && commitIdx >= 0 && collectIdx >= 0);
  assert.ok(drainIdx < pollIdx, 'drain must precede poll (poll git-status sets any_new)');
  assert.ok(drainIdx < commitIdx && drainIdx < collectIdx);
});

test('replay leaves promotions uncommitted (no git commit/push in the step)', () => {
  assert.doesNotMatch(steps[drainIdx].body, /git (commit|push)/);
});

test('replay is exempt from the BD breaker and cannot fail the job', () => {
  const b = steps[drainIdx].body;
  assert.match(b, /BD_OPENING_NIGHT: '1'/);
  assert.match(b, /BRIGHTDATA_TOKEN:/);
  assert.match(b, /continue-on-error: true/);
  assert.match(b, /if: steps\.find\.outputs\.has_shows == 'true'/);
});

test('poll step derives any_new from review-texts git status (the seeding the drain relies on)', () => {
  assert.match(steps[pollIdx].body, /cd data\/review-texts && git status --porcelain/);
});
