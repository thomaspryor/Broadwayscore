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

const fs = require('node:fs');
const path = require('node:path');
const { parseExemptEntries, parsePagingCrons, loadDigestCrons, validateExemptEntries, isCronActive, worstGapHours, digestCadenceError } = require('./cron-coverage.js');
const root = path.resolve(import.meta.dirname, '../..');

test('structured exemptions require reasons and truthful digest coverage', () => {
  const valid = parseExemptEntries('a.yml | digest | 48 | Daily refresh\nb.yml | low-stakes | | Optional report');
  assert.deepEqual(validateExemptEntries(valid, [{ workflow: 'a.yml' }]), []);
  assert.match(validateExemptEntries(valid, []).join('\n'), /digest coverage claimed/);
  for (const text of [
    'a.yml', 'a.yml | digest | 48 |', 'a.yml | digest | NaN | Refresh',
    'a.yml | mystery | 48 | Refresh', 'a.yml | low-stakes | | Covered by digest',
    'a.yml | digest | 48 | Refresh | 6-4', 'a.yml | digest | 48 | Refresh | 0-13',
    'a.yml | digest | 48 | Refresh | 4-6 | ignored',
    'a.yml | digest | 48 | Refresh\na.yml | digest | 48 | Refresh',
  ]) {
    assert.ok(validateExemptEntries(parseExemptEntries(text), []).length, text);
  }
  assert.ok(parseExemptList('a.yml | digest | 48 | Refresh').has('a.yml'));
});

test('live digest preserves every paging entry and watches the paging monitor', () => {
  const paging = parsePagingCrons(fs.readFileSync(path.join(root, '.github/workflows/check-cron-health.yml'), 'utf8'));
  const digest = loadDigestCrons(root);
  assert.ok(paging.length > 40);
  for (const entry of paging) assert.deepEqual(digest.find(item => item.workflow === entry.workflow), entry);
  assert.ok(digest.some(entry => entry.workflow === 'check-cron-health.yml'));
  assert.equal(digest.find(entry => entry.workflow === 'audit-reverse-discovery.yml').maxHours, 24);
  const exemptions = parseExemptEntries(fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8'));
  assert.deepEqual(validateExemptEntries(exemptions, digest), []);
  assert.equal(new Set(digest.map(entry => entry.workflow)).size, digest.length);
});

test('seasonal monitors stay inactive outside their season', () => {
  assert.equal(isCronActive({ activeMonths: '4-6' }, 3), false);
  assert.equal(isCronActive({ activeMonths: '4-6' }, 4), true);
  assert.equal(isCronActive({ activeMonths: '4-6' }, 6), true);
  assert.equal(isCronActive({ activeMonths: '4-6' }, 7), false);
  assert.throws(() => isCronActive({ activeMonths: '6-4' }, 5));
  assert.throws(() => isCronActive({ activeMonths: '4-13' }, 5));
  assert.equal(worstGapHours(['0 14 * * 2']), 168);
  assert.equal(worstGapHours(['0 6 1 1,4,7,10 *'], 366), 2208);
  assert.equal(worstGapHours(['0 6 1 * *'], 366), 744);
  for (const workflow of ['generate-related-shows.yml', 'rotate-apple-secret.yml', 'rotate-gitlab-token.yml', 'scoring-audit.yml', 'scrape-alltime-grosses.yml']) {
    assert.ok(loadDigestCrons(root).find(entry => entry.workflow === workflow).maxHours >= 768, workflow);
  }
});

test('real health-check executes the shared digest list and detects a dead paging monitor', () => {
  const { checkCronHealth } = require('../health-check.js');
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'fixture-only';
  try {
    const expected = loadDigestCrons(root).filter(entry => isCronActive(entry, new Date().getUTCMonth() + 1));
    for (const scenario of ['success', 'stale', 'failure']) {
      const called = [];
      const results = checkCronHealth(workflow => {
        called.push(workflow);
        return JSON.stringify([{
          createdAt: new Date(Date.now() - (scenario === 'stale' ? 4000 * 3600000 : 0)).toISOString(),
          conclusion: scenario === 'failure' ? 'failure' : 'success',
        }]);
      });
      assert.deepEqual(called, expected.map(entry => entry.workflow));
      assert.equal(results.length, expected.length);
      const monitor = results.find(result => /Check Cron Health/.test(result.name));
      assert.ok(monitor);
      assert.equal(monitor.status, scenario === 'success' ? 'pass' : scenario === 'stale' ? 'error' : 'warn');
    }
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
});


test('digest cadence validation catches monthly underestimates and honors seasonal pauses', () => {
  const monthly = "on:\n  schedule:\n    - cron: '0 6 1 * *'\n";
  assert.match(digestCadenceError({ workflow: 'monthly.yml', maxHours: 696 }, monthly), /744h/);
  assert.equal(digestCadenceError({ workflow: 'monthly.yml', maxHours: 768 }, monthly), null);
  const seasonal = "on:\n  schedule:\n    - cron: '0 14 * 4-6 2'\n";
  assert.equal(digestCadenceError({ workflow: 'season.yml', maxHours: 192, activeMonths: '4-6' }, seasonal), null);
  assert.match(digestCadenceError({ workflow: 'missing.yml', maxHours: 48 }, ''), /cannot cover/);
});
