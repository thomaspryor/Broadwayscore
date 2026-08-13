// intake-breaker contract. Per CLAUDE.md §15 this require()s the real
// predicates rather than restating them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateIntake, countCreatedToday, recordCreated, dayKey, DEFAULT_DAILY_CAP, ENFORCE,
} = require('./intake-breaker.js');

const NOW = Date.UTC(2026, 7, 13, 14, 0, 0); // 2026-08-13T14:00Z
const DAY = 24 * 60 * 60 * 1000;

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intake-breaker-')), 'intake-ledger.jsonl');
}

test('evaluateIntake: allows below the cap, refuses at and above it', () => {
  assert.equal(evaluateIntake({ createdToday: 0 }).allow, true);
  assert.equal(evaluateIntake({ createdToday: DEFAULT_DAILY_CAP - 1 }).allow, true);
  assert.equal(evaluateIntake({ createdToday: DEFAULT_DAILY_CAP }).allow, false);
  assert.equal(evaluateIntake({ createdToday: DEFAULT_DAILY_CAP + 500 }).allow, false);
});

test('evaluateIntake: the cap sits ABOVE measured normal intake, so a normal day never trips', () => {
  // Measured 2026-08-12: real intake 34.3 cards/day. A breaker that fires on a
  // normal day is a queue limit in disguise and would be an owner decision.
  assert.equal(evaluateIntake({ createdToday: 35 }).allow, true);
  assert.equal(evaluateIntake({ createdToday: 50 }).allow, true);
  assert.ok(DEFAULT_DAILY_CAP > 34, 'cap must exceed measured mean daily intake');
});

test('evaluateIntake: the refusal names the override and points at the ledger', () => {
  const { allow, reason } = evaluateIntake({ createdToday: 999 });
  assert.equal(allow, false);
  assert.match(reason, /INTAKE_BREAKER_DISABLED=1/, 'an override with no documented escape gets deleted instead');
  assert.match(reason, /intake-ledger\.jsonl/, 'must say where to look');
  assert.match(reason, /999/);
});

test('evaluateIntake: the env override allows through even far above the cap', () => {
  const r = evaluateIntake({ createdToday: 5000, disabled: true });
  assert.equal(r.allow, true);
  assert.match(r.reason, /disabled by env/);
});

test('evaluateIntake: a non-numeric count is treated as 0 (fail-open), never NaN-compared', () => {
  // NaN < cap is false, so a naive implementation would REFUSE on garbage input —
  // wedging all creation exactly when telemetry is broken.
  for (const bad of [undefined, null, NaN, 'twelve', {}]) {
    assert.equal(evaluateIntake({ createdToday: bad }).allow, true, `should allow on ${String(bad)}`);
  }
});

test('countCreatedToday: counts only same-ET-day entries', () => {
  const led = tmpLedger();
  recordCreated({ identifier: 'BRO-1', title: 'today a', now: NOW, ledgerPath: led });
  recordCreated({ identifier: 'BRO-2', title: 'today b', now: NOW + 60_000, ledgerPath: led });
  recordCreated({ identifier: 'BRO-3', title: 'yesterday', now: NOW - DAY, ledgerPath: led });
  recordCreated({ identifier: 'BRO-4', title: 'tomorrow', now: NOW + DAY, ledgerPath: led });
  assert.equal(countCreatedToday(NOW, led), 2);
});

test('countCreatedToday: an absent ledger returns 0 so the breaker FAILS OPEN', () => {
  // The ledger is gitignored, so absence is normal in any fresh worktree. A
  // guard that fails closed here would stop every session filing anything.
  assert.equal(countCreatedToday(NOW, '/nonexistent/dir/intake-ledger.jsonl'), 0);
});

test('countCreatedToday: malformed lines are skipped, not fatal, and do not inflate the count', () => {
  const led = tmpLedger();
  recordCreated({ identifier: 'BRO-1', title: 'real', now: NOW, ledgerPath: led });
  fs.appendFileSync(led, 'not json at all\n');
  fs.appendFileSync(led, `{"ts":"${dayKey(NOW)} malformed timestamp"}\n`);
  fs.appendFileSync(led, '\n');
  assert.equal(countCreatedToday(NOW, led), 1);
});

test('countCreatedToday: a line merely CONTAINING the date string is not counted without a valid ts', () => {
  // A title like "fix the 2026-08-13 regression" must not inflate the count. The
  // day decision comes from the parsed `ts` only — never from the line's text.
  // (An earlier version had a substring prefilter; it was removed because the ET
  // day key does not match the stored UTC date string for evening entries.)
  const led = tmpLedger();
  recordCreated({ identifier: 'BRO-9', title: `fix the ${dayKey(NOW)} regression`, now: NOW - 5 * DAY, ledgerPath: led });
  assert.equal(countCreatedToday(NOW, led), 0);
});

test('recordCreated: never throws on an unwritable path (telemetry must not break a create)', () => {
  assert.doesNotThrow(() => recordCreated({
    identifier: 'BRO-1', title: 'x', now: NOW, ledgerPath: '/proc/definitely/not/writable/l.jsonl',
  }));
});

test('recordCreated: truncates long titles and tolerates a missing one', () => {
  const led = tmpLedger();
  recordCreated({ title: 'y'.repeat(500), now: NOW, ledgerPath: led });
  recordCreated({ now: NOW, ledgerPath: led });
  const lines = fs.readFileSync(led, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].title.length, 200);
  assert.equal(lines[0].identifier, null);
  assert.equal(lines[1].title, '');
});

// -- Codex review findings, encoded as tests ---------------------------------

test('dayKey uses ET, not UTC - an evening-ET entry belongs to the ET day, not the next UTC one', () => {
  // 2026-08-13T02:00Z is 2026-08-12 22:00 ET. The UTC version keyed this as the
  // 13th, so 60 evening filings could suppress creation after local midnight
  // while being attributed to "today".
  assert.equal(dayKey(Date.UTC(2026, 7, 13, 2, 0, 0)), '2026-08-12');
  assert.equal(dayKey(Date.UTC(2026, 7, 13, 12, 0, 0)), '2026-08-13');
});

test('dayKey is DST-correct on both sides of the change', () => {
  // EDT (UTC-4) in August: 03:00Z is still the previous day at 23:00.
  assert.equal(dayKey(Date.UTC(2026, 7, 14, 3, 0, 0)), '2026-08-13');
  // EST (UTC-5) in January: 04:00Z is still the previous day at 23:00.
  assert.equal(dayKey(Date.UTC(2026, 0, 14, 4, 0, 0)), '2026-01-13');
});

test('countCreatedToday counts an evening-ET entry whose stored UTC date is tomorrow', () => {
  // The regression the removed substring prefilter would have caused: the line's
  // text contains "2026-08-13" but it belongs to the ET 12th, so a text-match
  // prefilter against the ET key would have skipped it and undercounted.
  const led = tmpLedger();
  const eveningET = Date.UTC(2026, 7, 13, 2, 30, 0); // 22:30 ET on the 12th
  recordCreated({ identifier: 'BRO-E', title: 'evening filing', now: eveningET, ledgerPath: led });
  assert.match(fs.readFileSync(led, 'utf8'), /2026-08-13T/, 'stored ts really is the next UTC date');
  assert.equal(countCreatedToday(eveningET, led), 1, 'must still count toward the ET day it happened on');
});

test('ENFORCE is false - this ships observe-only so a refusal cannot eat an alert', () => {
  // owner-alert-router drops the alert when filing throws (it returns {ok:false}
  // and neither queues a digest row nor sends a fallback). Arming the refusal
  // before that path has a fallback would make this guard lose work, which is
  // the exact failure the whole system is being fixed for.
  assert.equal(ENFORCE, false,
    'do not arm enforcement until owner-alert-router queues or falls back on filing failure');
});
