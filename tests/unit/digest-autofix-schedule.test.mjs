// BRO-6764: once the Mac digest job is retired, auto-fix + canary must still run once per ET day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRunAutofix } = require('../../scripts/lib/digest-autofix-schedule.js');
const sender = require('../../scripts/send-morning-digest.js');

const at = (iso) => new Date(iso);
const H = '2026-11-02';

test('off before the handoff date (the Mac run still does auto-fix)', () => {
  assert.equal(shouldRunAutofix({ handoff: H, last: null, now: at('2026-11-01T12:00:00Z') }).run, false);
});

test('runs once per ET day, from 05:00 ET, from the handoff date', () => {
  assert.equal(shouldRunAutofix({ handoff: H, last: null, now: at('2026-11-02T09:00:00Z') }).run, false, '04:00 EST is too early');
  const r = shouldRunAutofix({ handoff: H, last: null, now: at('2026-11-02T10:30:00Z') });
  assert.equal(r.run, true);
  assert.equal(r.dayET, '2026-11-02');
  assert.equal(shouldRunAutofix({ handoff: H, last: { dayET: '2026-11-02' }, now: at('2026-11-02T15:00:00Z') }).run, false);
  assert.equal(shouldRunAutofix({ handoff: H, last: { dayET: '2026-11-02' }, now: at('2026-11-03T10:30:00Z') }).run, true);
});

test('sender: already-sent has its own exit code, distinct from failures', () => {
  assert.equal(sender.ALREADY_SENT_EXIT, 3);
});
