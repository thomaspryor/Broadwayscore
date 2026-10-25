import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sweepSubmissions } = require('../../scripts/lib/submission-sweep.js');
const { AWAITING_SCORE_MAX_HOURS } = require('../../scripts/lib/submission-landing.js');

function fixture(t, { landed = true, labels = ['needs-manual-review'], ageHours = 100, title = '[Review Submission] Test review' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const show = { id: 'test-show-2026', title: 'Test Show', openingDate: '2026-01-01', status: 'open' };
  const url = 'https://example.com/test-review';
  const dir = path.join(root, 'review-texts', show.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'shows.json'), JSON.stringify({ shows: [show] }));
  fs.writeFileSync(path.join(root, 'reviews.json'), JSON.stringify({ reviews: landed ? [{ showId: show.id, url }] : [] }));
  fs.writeFileSync(path.join(dir, 'outlet--critic.json'), JSON.stringify({
    showId: show.id, url, contentTier: 'complete', assignedScore: 80, fullText: 'Review text. '.repeat(200),
  }));
  const issue = { number: 123, title, body: `### Review URL\n${url}`, labels: labels.map(name => ({ name })), createdAt: new Date(Date.now() - ageHours * 3600e3).toISOString() };
  const calls = [];
  function runGh(args) {
    calls.push(args);
    if (args[1] === 'list') {
      const label = args[args.indexOf('--label') + 1];
      return JSON.stringify(labels.includes(label) ? [issue] : []);
    }
    return '';
  }
  return { root, issue, calls, runGh, writes: () => calls.filter(a => a[1] !== 'list') };
}

test('a manual-review submission closes only after its URL reaches rebuilt reviews', t => {
  const f = fixture(t);
  sweepSubmissions(f);
  assert.deepEqual(f.writes().map(a => a[1]), ['comment', 'close', 'edit']);
  assert.deepEqual(f.writes()[2], ['issue', 'edit', '123', '--remove-label', 'needs-manual-review']);
});

test('a manual-review submission missing from rebuilt reviews stays visible without repeated escalation', t => {
  const f = fixture(t, { landed: false });
  sweepSubmissions(f);
  assert.deepEqual(f.writes(), []);
});

test('other feedback is left open even when its body links to an existing review', t => {
  const f = fixture(t, { title: 'Bug Diagnosis: incorrect score' });
  sweepSubmissions(f);
  assert.deepEqual(f.writes(), []);
});

test('an issue with both queue labels is closed once and both labels are removed', t => {
  const f = fixture(t, { labels: ['awaiting-score', 'needs-manual-review'] });
  sweepSubmissions(f);
  assert.equal(f.writes().filter(a => a[1] === 'close').length, 1);
  assert.deepEqual(f.writes()[2], ['issue', 'edit', '123', '--remove-label', 'awaiting-score', '--remove-label', 'needs-manual-review']);
});

test('dry-run makes no GitHub mutations', t => {
  const f = fixture(t);
  sweepSubmissions({ ...f, dryRun: true });
  assert.equal(f.calls.filter(a => a[1] === 'list').length, 2);
  assert.deepEqual(f.writes(), []);
});

test('awaiting-score submissions still escalate after the deadline', t => {
  const f = fixture(t, { labels: ['awaiting-score'], landed: false, ageHours: AWAITING_SCORE_MAX_HOURS + 1 });
  sweepSubmissions(f);
  assert.deepEqual(f.writes()[1], ['issue', 'edit', '123', '--remove-label', 'awaiting-score', '--add-label', 'needs-manual-review']);
});

test('fresh awaiting-score submissions keep waiting', t => {
  const f = fixture(t, { labels: ['awaiting-score'], landed: false, ageHours: 1 });
  sweepSubmissions(f);
  assert.deepEqual(f.writes(), []);
});

test('a failed close leaves the queue labels available for the next sweep', t => {
  const f = fixture(t);
  sweepSubmissions({ ...f, runGh(args) {
    const result = f.runGh(args);
    if (args[1] === 'close') throw new Error('close failed');
    return result;
  } });
  assert.equal(f.writes().some(a => a[1] === 'edit'), false);
});

test('a failed queue read makes no mutations', t => {
  const f = fixture(t);
  sweepSubmissions({ ...f, runGh() { throw new Error('list failed'); } });
  assert.deepEqual(f.writes(), []);
});
