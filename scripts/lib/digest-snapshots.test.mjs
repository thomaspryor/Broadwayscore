import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, readAllSnapshots, describeProblems, SNAPSHOTS } from './digest-snapshots.js';
import { classifySubject } from './scheduled-email-count-rules.js';
import digestSender from '../send-morning-digest.js';

const { buildSubject, buildHtml } = digestSender;

const NOW = new Date('2026-07-28T11:30:00Z').getTime();

function tmpAudit() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-snapshots-test-'));
}

function write(dir, file, obj) {
  fs.writeFileSync(path.join(dir, file), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

test('readSnapshot: fresh / stale / missing / invalid', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 2 * 3600e3).toISOString();
  const staleAt = new Date(NOW - 48 * 3600e3).toISOString();

  write(dir, 'fresh.json', { generatedAt: freshAt, hello: 1 });
  write(dir, 'stale.json', { generatedAt: staleAt });
  write(dir, 'garbage.json', '{not json');
  write(dir, 'no-date.json', { hello: 1 });

  const fresh = readSnapshot(path.join(dir, 'fresh.json'), 36, NOW);
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.snapshot.hello, 1);

  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).status, 'stale');
  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).generatedAt, staleAt);
  assert.equal(readSnapshot(path.join(dir, 'absent.json'), 36, NOW).status, 'missing');
  assert.equal(readSnapshot(path.join(dir, 'garbage.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'no-date.json'), 36, NOW).status, 'invalid');
});

test('readAllSnapshots: fresh sections render, everything else lands in problems', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 1 * 3600e3).toISOString();
  write(dir, 'health-digest-snapshot.json', { generatedAt: freshAt, errors: [], warns: [] });
  write(dir, 'daily-digest-snapshot.json', { generatedAt: new Date(NOW - 50 * 3600e3).toISOString() });
  // opening + reddit snapshots absent on purpose

  const { sections, problems } = readAllSnapshots({ auditDir: dir, now: NOW });
  assert.ok(sections.health);
  assert.equal(sections.dailyDigest, null);
  assert.equal(sections.openingDigest, null);
  assert.equal(sections.redditDigest, null);
  assert.equal(problems.length, 3);
  assert.deepEqual(problems.map((p) => p.status).sort(), ['missing', 'missing', 'stale']);
});

test('describeProblems names every non-fresh source; null when all fresh', () => {
  assert.equal(describeProblems([]), null);
  const note = describeProblems([
    { key: 'health', label: 'site health', status: 'stale', generatedAt: '2026-07-26T03:12:00.000Z' },
    { key: 'redditDigest', label: 'Reddit engagement', status: 'missing', generatedAt: null },
  ]);
  assert.match(note, /site health \(last 2026-07-26 03:12 UTC\)/);
  assert.match(note, /Reddit engagement \(no snapshot\)/);
});

test('registry covers exactly the four folded digests', () => {
  assert.deepEqual(SNAPSHOTS.map((s) => s.key).sort(), ['dailyDigest', 'health', 'openingDigest', 'redditDigest']);
});

// The contract the plan review flagged as a P0: the monitor's classifier and
// the sender's subject builder must never drift apart, or the one-email-per-
// day guard silently stops guarding.
test('buildSubject output classifies as the morning-digest scheduled sender', () => {
  const quiet = buildSubject({ health: null, now: new Date('2026-07-28T11:30:00Z') });
  assert.equal(classifySubject(quiet)?.key, 'morning-digest');
  const noisy = buildSubject({
    health: { subject: 'BSC URGENT (day 3): 2 unresolved errors', errors: ['a', 'b'], warns: ['c'] },
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.equal(classifySubject(noisy)?.key, 'morning-digest');
  assert.match(noisy, /⛔ site health: 2 errors, 1 warning/);
  // Never a bare count that can degrade to "0 items" (owner feedback).
  assert.doesNotMatch(quiet, /\d+ items?/);
});

test('buildHtml never renders loop language and says "all quiet" when empty', () => {
  const empty = buildHtml({ sections: {}, problemsNote: null, changesHtml: null, now: new Date('2026-07-28T11:30:00Z') });
  assert.match(empty, /Nothing new this morning/);
  for (const banned of ['Auto tag', 'needs your triage', 'awaiting your tap', 'stalling the loop', 'autonomous loop', 'Approve', 'clear the Auto']) {
    assert.ok(!empty.includes(banned), `digest HTML must never contain "${banned}"`);
  }
});

test('buildHtml surfaces the no-fresh-data banner and renders fresh sections', () => {
  const html = buildHtml({
    sections: { health: { generatedAt: '2026-07-28T09:00:00Z', errors: [], warns: [], checks: [] } },
    problemsNote: 'no fresh data from: Reddit engagement (no snapshot)',
    changesHtml: null,
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(html, /no fresh data from: Reddit engagement/);
  assert.doesNotMatch(html, /Nothing new this morning/);
});
