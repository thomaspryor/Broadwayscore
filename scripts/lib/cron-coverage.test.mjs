import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt } = require('./cron-coverage.js');

test('isScheduledWorkflow: true only when a cron schedule is present', () => {
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n    - cron: "*/10 * * * *"\n'), true);
  assert.equal(isScheduledWorkflow("on:\n  schedule:\n    - cron: '0 9 * * 1'\n"), true);
  // UNQUOTED cron must still be detected (else it evades the coverage gate).
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n    - cron: 30 5 1,15 * *\n'), true);
  // workflow_dispatch only — not scheduled
  assert.equal(isScheduledWorkflow('on:\n  workflow_dispatch:\n'), false);
  // a `schedule:` key with no cron string (defensive)
  assert.equal(isScheduledWorkflow('on:\n  schedule:\n'), false);
  // schedule: key present but the only cron line is COMMENTED OUT → not actually scheduled
  assert.equal(isScheduledWorkflow("on:\n  schedule:\n    # - cron: '0 9 * * *'\n  workflow_dispatch:\n"), false);
  // the word cron in a comment but no schedule trigger
  assert.equal(isScheduledWorkflow('# cron health note\non:\n  push:\n'), false);
  assert.equal(isScheduledWorkflow(''), false);
  assert.equal(isScheduledWorkflow(null), false);
});

test('parseExemptList: filenames only, ignores comments/blanks, trims', () => {
  const txt = `# header comment\n\nfoo.yml\n  bar.yml  \n# baz.yml (disabled comment)\nqux.yml\n`;
  const set = parseExemptList(txt);
  assert.deepEqual([...set].sort(), ['bar.yml', 'foo.yml', 'qux.yml']);
  assert.ok(!set.has('baz.yml')); // commented out
  assert.equal(parseExemptList('').size, 0);
  assert.equal(parseExemptList(null).size, 0);
});

test('findUncoveredScheduled: scheduled minus covered minus exempt, sorted', () => {
  const scheduled = ['c.yml', 'a.yml', 'b.yml', 'd.yml'];
  const covered = new Set(['a.yml']);
  const exempt = new Set(['b.yml']);
  assert.deepEqual(findUncoveredScheduled(scheduled, covered, exempt), ['c.yml', 'd.yml']);
});

test('findUncoveredScheduled: all covered/exempt → empty (the seeded steady state)', () => {
  const scheduled = ['a.yml', 'b.yml'];
  assert.deepEqual(findUncoveredScheduled(scheduled, new Set(['a.yml']), new Set(['b.yml'])), []);
});

test('findUncoveredScheduled: a brand-new scheduled workflow in neither list is flagged', () => {
  // Simulates someone adding new-cron.yml without classifying it.
  const scheduled = ['existing.yml', 'new-cron.yml'];
  const covered = new Set(['existing.yml']);
  const exempt = new Set(); // not added anywhere
  assert.deepEqual(findUncoveredScheduled(scheduled, covered, exempt), ['new-cron.yml']);
});

test('findStaleExempt: flags exempt entries that no longer exist or are double-listed', () => {
  const exempt = new Set(['gone.yml', 'live.yml', 'promoted.yml']);
  const scheduledSet = new Set(['live.yml', 'promoted.yml']); // gone.yml de-scheduled/deleted
  const covered = new Set(['promoted.yml']);                   // promoted.yml now also in CRITICAL_CRONS
  const stale = findStaleExempt(exempt, scheduledSet, covered);
  assert.deepEqual(stale.notScheduled, ['gone.yml']);
  assert.deepEqual(stale.alsoCovered, ['promoted.yml']);
});
