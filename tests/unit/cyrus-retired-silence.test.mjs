// BRO-6110: the owner retired Cyrus (answered "A" on the card, 2026-10-24). The retired Mac jobs stop
// writing their status files, which the morning digest would report as "has not checked in" every day.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// The readers take their status paths from CYRUS_HOME at load time, so set it before requiring.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-home-'));
const priorCyrusHome = process.env.CYRUS_HOME;
process.env.CYRUS_HOME = home;
const stale = '2000-01-01T00:00:00.000Z';
fs.writeFileSync(path.join(home, 'webhook-drain-status.json'), JSON.stringify({ at: stale, ok: false, error: 'fetch failed' }));
fs.writeFileSync(path.join(home, 'runner-health.json'), JSON.stringify({ at: stale, ok: false }));
after(() => { fs.rmSync(home, { recursive: true, force: true }); if (priorCyrusHome === undefined) delete process.env.CYRUS_HOME; else process.env.CYRUS_HOME = priorCyrusHome; });
const digest = require(path.join(ROOT, 'scripts/send-morning-digest.js'));
const { assessCyrusRelay } = require(path.join(ROOT, 'scripts/lib/cyrus-relay-health.js'));
const { assessRunnerHealth } = require(path.join(ROOT, 'scripts/lib/cyrus-runner-health.js'));

test('both Cyrus jobs are on the retire list with their watchers named', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mac-retired.json'), 'utf8')).entries;
  for (const label of ['com.broadwayscore.cyrus-webhook-drain', 'com.broadwayscore.cyrus-runner', 'com.broadwayscore.cyrus-edge']) {
    const e = list.find((x) => x.label === label);
    assert.ok(e, `${label} is retired`);
    assert.equal(e.retiredAt, '2026-10-24');
    assert.ok(e.watchers.length > 0 && e.replacedBy.length > 0);
  }
});

test('macLabelRetired: listed labels are retired, unlisted ones are not, and an unreadable list keeps alerting', () => {
  assert.equal(digest.macLabelRetired('com.broadwayscore.cyrus-webhook-drain'), true);
  assert.equal(digest.macLabelRetired('com.broadwayscore.cyrus-runner'), true);
  assert.equal(digest.macLabelRetired('com.broadwayscore.checkout-sync'), false);
  assert.equal(digest.macLabelRetired('com.broadwayscore.cyrus-webhook-drain', path.join(home, 'missing.json')), false);
  const other = path.join(home, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ entries: [{ label: 'com.bwsc.something-else' }] }));
  assert.equal(digest.macLabelRetired('com.broadwayscore.cyrus-webhook-drain', other), false);
});

test('a stale Cyrus status file no longer raises a digest alarm once the job is retired (and would have before)', () => {
  const status = JSON.parse(fs.readFileSync(path.join(home, 'webhook-drain-status.json'), 'utf8'));
  assert.match(assessCyrusRelay(status).message, /has not checked in/, 'the alarm condition is real');
  const runnerState = JSON.parse(fs.readFileSync(path.join(home, 'runner-health.json'), 'utf8'));
  assert.match(assessRunnerHealth(runnerState).message, /has not checked in/, 'the runner alarm condition is real too');
  assert.equal(digest.localCyrusRelayMessage(), null);
  assert.equal(digest.localRunnerHealthMessage(), null);
});

test('BRO-6216: a stale delegation status file raises no digest alarm once linear-delegation-check is retired', () => {
  fs.writeFileSync(path.join(home, 'linear-delegation-status.json'), JSON.stringify({ at: stale, alarm: 'x stalled' }));
  assert.equal(digest.localLinearDelegationMessage(), null);
  assert.equal(digest.localCodexConnectionLine(), null);
});
