import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planSocketModeRepair, backupsToPrune, isNoPasswordError } = require('./cmux-socket-mode-repair.js');

// The exact file cmux left behind on 2026-10-04 (BRO-5567).
const DRIFTED = JSON.stringify({
  $schema: 'https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json',
  automation: { socketControlMode: 'cmuxOnly' },
  schemaVersion: 1,
}, null, 2);

test('cmuxOnly drift is rewritten to password mode, filling the password and keeping other keys', () => {
  const r = planSocketModeRepair({ configText: DRIFTED, password: 'pw1' });
  assert.equal(r.action, 'rewrite');
  assert.equal(r.fromMode, 'cmuxOnly');
  const out = JSON.parse(r.newText);
  assert.deepEqual(out.automation, { socketControlMode: 'password', socketPassword: 'pw1' });
  assert.equal(out.schemaVersion, 1);
  assert.match(out.$schema, /cmux\.schema\.json$/);
});

test('password mode WITHOUT socketPassword in the file is not drift (cmux may keep it elsewhere)', () => {
  const text = JSON.stringify({ automation: { socketControlMode: 'password' } });
  assert.equal(planSocketModeRepair({ configText: text, password: 'pw1' }).action, 'none');
});

test('an existing different socketPassword is never overwritten during a mode repair', () => {
  const text = JSON.stringify({ automation: { socketControlMode: 'allowAll', socketPassword: 'theirs' } });
  const r = planSocketModeRepair({ configText: text, password: 'mine' });
  assert.equal(JSON.parse(r.newText).automation.socketPassword, 'theirs');
});

test('a JSONC (commented) file is reported unparseable and never rewritten', () => {
  const text = '{\n  // "socketControlMode": "cmuxOnly",\n  "automation": {"socketControlMode": "cmuxOnly"}\n}';
  assert.deepEqual(planSocketModeRepair({ configText: text, password: 'pw' }), { action: 'none', reason: 'unparseable' });
});

test('no password available means no repair (nothing to authenticate with)', () => {
  assert.equal(planSocketModeRepair({ configText: DRIFTED, password: '' }).reason, 'no-password');
});

test('a file with no automation block at all is drift (cmux defaults to cmuxOnly)', () => {
  const r = planSocketModeRepair({ configText: '{"schemaVersion":1}', password: 'pw' });
  assert.equal(r.action, 'rewrite');
  assert.equal(r.fromMode, '(unset)');
});

test('backupsToPrune keeps the newest N repair backups and ignores other files', () => {
  const names = ['cmux.json', 'cmux.json.bak-20260907-201629', 'cmux.json.bak-repair-100', 'cmux.json.bak-repair-300', 'cmux.json.bak-repair-200'];
  assert.deepEqual(backupsToPrune(names, 2), ['cmux.json.bak-repair-100']);
  assert.deepEqual(backupsToPrune(names, 5), []);
});

// BRO-5640: the exact state cmux left on 2026-10-18 plus the exact CLI error.
test('password mode, no file password, socket says none configured -> password is refilled', () => {
  const text = JSON.stringify({ automation: { socketControlMode: 'password' }, schemaVersion: 1 });
  const r = planSocketModeRepair({ configText: text, password: 'pw1', socketReportsNoPassword: true });
  assert.equal(r.action, 'rewrite');
  assert.equal(r.reason, 'password-missing');
  assert.deepEqual(JSON.parse(r.newText).automation, { socketControlMode: 'password', socketPassword: 'pw1' });
});

test('socket-reported missing password never overwrites an existing file password', () => {
  const text = JSON.stringify({ automation: { socketControlMode: 'password', socketPassword: 'theirs' } });
  assert.equal(planSocketModeRepair({ configText: text, password: 'pw1', socketReportsNoPassword: true }).action, 'none');
});

test('isNoPasswordError matches the real cmux CLI text and nothing else', () => {
  assert.equal(isNoPasswordError('Error: ERROR: Password mode is enabled but no socket password is configured in Settings.'), true);
  assert.equal(isNoPasswordError('Error: auth_required: Authentication required.'), false);
  assert.equal(isNoPasswordError(undefined), false);
});
