// BRO-6764: once the Mac digest job is retired, auto-fix + canary must still run once per ET day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRunAutofix, DIGEST_LABEL } = require('../../scripts/lib/digest-autofix-schedule.js');
const sender = require('../../scripts/send-morning-digest.js');

const cfg = { entries: [{ label: DIGEST_LABEL, retiredAt: '2026-11-01' }] };
const at = (iso) => new Date(iso);

test('off while the digest job is not retired, or before its grace date', () => {
  assert.equal(shouldRunAutofix({ config: { entries: [] }, last: null, now: at('2026-11-05T12:00:00Z') }).run, false);
  assert.equal(shouldRunAutofix({ config: cfg, last: null, now: at('2026-11-03T12:00:00Z') }).run, false, 'the Mac run still does auto-fix until booted out');
});

test('runs once per ET day, from 05:00 ET, after the grace date', () => {
  assert.equal(shouldRunAutofix({ config: cfg, last: null, now: at('2026-11-04T09:00:00Z') }).run, false, '04:00 EST is too early');
  const r = shouldRunAutofix({ config: cfg, last: null, now: at('2026-11-04T10:30:00Z') });
  assert.equal(r.run, true);
  assert.equal(r.dayET, '2026-11-04');
  assert.equal(shouldRunAutofix({ config: cfg, last: { dayET: '2026-11-04' }, now: at('2026-11-04T15:00:00Z') }).run, false);
  assert.equal(shouldRunAutofix({ config: cfg, last: { dayET: '2026-11-04' }, now: at('2026-11-05T10:30:00Z') }).run, true);
});

test('sender: already-sent has its own exit code, distinct from failures', () => {
  assert.equal(sender.ALREADY_SENT_EXIT, 3);
});
