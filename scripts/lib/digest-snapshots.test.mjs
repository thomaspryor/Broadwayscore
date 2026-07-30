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
  // JSON literal null parses fine but must not crash (ship-check QA P0)
  write(dir, 'null.json', 'null');
  write(dir, 'array.json', '[1,2]');
  // Future generatedAt = producer clock bug, not fresh (ship-check codex P1)
  write(dir, 'future.json', { generatedAt: new Date(NOW + 100 * 3600e3).toISOString() });

  const fresh = readSnapshot(path.join(dir, 'fresh.json'), 36, NOW);
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.snapshot.hello, 1);

  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).status, 'stale');
  assert.equal(readSnapshot(path.join(dir, 'stale.json'), 36, NOW).generatedAt, staleAt);
  assert.equal(readSnapshot(path.join(dir, 'absent.json'), 36, NOW).status, 'missing');
  assert.equal(readSnapshot(path.join(dir, 'garbage.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'no-date.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'null.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'array.json'), 36, NOW).status, 'invalid');
  assert.equal(readSnapshot(path.join(dir, 'future.json'), 36, NOW).status, 'invalid');
});

test('readAllSnapshots: fresh sections render, everything else lands in problems', () => {
  const dir = tmpAudit();
  const freshAt = new Date(NOW - 1 * 3600e3).toISOString();
  write(dir, 'health-digest-snapshot.json', { generatedAt: freshAt, errors: [], warns: [] });
  write(dir, 'daily-digest-snapshot.json', { generatedAt: new Date(NOW - 50 * 3600e3).toISOString() });
  // reddit snapshot absent on purpose

  const { sections, problems } = readAllSnapshots({ auditDir: dir, now: NOW });
  assert.ok(sections.health);
  assert.equal(sections.dailyDigest, null);
  assert.equal(sections.redditDigest, null);
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => p.status).sort(), ['missing', 'stale']);
});

test('describeProblems names every non-fresh source; null when all fresh', () => {
  assert.equal(describeProblems([]), null);
  const note = describeProblems([
    { key: 'health', label: 'site health', status: 'stale', generatedAt: '2026-07-26T03:12:00.000Z' },
    { key: 'redditDigest', label: 'Reddit engagement', status: 'missing', generatedAt: null },
  ]);
  assert.match(note, /site health \(last update 2026-07-26 03:12 UTC\)/);
  assert.match(note, /Reddit engagement \(no data\)/);
  assert.match(note, /^didn't update overnight:/);
});

test('registry covers exactly the three folded digests (opening digest is standalone again since 2026-07-30)', () => {
  assert.deepEqual(SNAPSHOTS.map((s) => s.key).sort(), ['dailyDigest', 'health', 'redditDigest']);
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

test('buildHtml never renders loop language; empty day reads calm, not broken', () => {
  const empty = buildHtml({ sections: {}, problemsNote: null, changesHtml: null, now: new Date('2026-07-28T11:30:00Z') });
  assert.match(empty, /Nothing needs your attention this morning/);
  assert.match(empty, /All quiet — no overnight changes to report/);
  for (const banned of ['Auto tag', 'needs your triage', 'awaiting your tap', 'stalling the loop', 'autonomous loop', 'Approve', 'clear the Auto']) {
    assert.ok(!empty.includes(banned), `digest HTML must never contain "${banned}"`);
  }
});

test('buildHtml: top verdict NAMES the failing check; warnings demote to a routine line', () => {
  const html = buildHtml({
    sections: { health: { generatedAt: '2026-07-28T09:00:00Z', errors: [{ name: 'Sync: cast coverage', message: '29 empty casts' }], warns: ['w1', 'w2'], checks: [] } },
    problemsNote: "didn't update overnight: Reddit engagement (no data)",
    changesHtml: null,
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(html, /Fix needed: Sync: cast coverage/);
  assert.match(html, /2 routine warnings below/);
  assert.match(html, /didn't update overnight: Reddit engagement/);
  assert.doesNotMatch(html, /Nothing needs your attention/);
});

test('buildHtml: warnings-only day reads calm ("Nothing urgent"), stuck signals escalate the verdict', () => {
  const warnsOnly = buildHtml({
    sections: { health: { generatedAt: '2026-07-28T09:00:00Z', errors: [], warns: ['w1'], checks: [] } },
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(warnsOnly, /Nothing urgent this morning/);
  assert.match(warnsOnly, /1 routine warning below/);

  const stuck = buildHtml({
    sections: {},
    stuckCount: 2,
    now: new Date('2026-07-28T11:30:00Z'),
  });
  assert.match(stuck, /2 pipeline items flagged &quot;possibly stuck&quot; below/);
});
