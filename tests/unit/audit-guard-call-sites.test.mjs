import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..', '..');
const { exportedNames, isAudienceGuard, provesCallSite, evaluateGuards, auditRepo } =
  require('../../scripts/lib/guard-call-sites.js');

const LIB = { 'scripts/lib/subscriber-send-guard.js':
  "// subscriber-facing\nfunction stripSubscriberJunk(h){return h}\nfunction helper(){}\nmodule.exports = { stripSubscriberJunk, helper };" };
const ENTRY = { 'scripts/newsletter/send.mjs':
  "const { stripSubscriberJunk } = require('../lib/subscriber-send-guard.js'); stripSubscriberJunk(x);" };
const UNIT = "const { stripSubscriberJunk } = require('./subscriber-send-guard.js'); stripSubscriberJunk('a');";

test('exportedNames / isAudienceGuard', () => {
  assert.deepEqual(exportedNames(LIB['scripts/lib/subscriber-send-guard.js']), ['stripSubscriberJunk', 'helper']);
  const src = LIB['scripts/lib/subscriber-send-guard.js'];
  assert.equal(isAudienceGuard('scripts/lib/subscriber-send-guard.js', 'stripSubscriberJunk', src), true);
  assert.equal(isAudienceGuard('scripts/lib/subscriber-send-guard.js', 'helper', src), false);
  assert.equal(isAudienceGuard('scripts/lib/x.js', 'validateThing', 'subscriber words in body only'), false);
});

test('guard with a call-site wiring test passes', () => {
  const testFiles = {
    'scripts/lib/subscriber-send-guard.test.mjs': UNIT,
    'scripts/send.test.mjs': "spawnSync('node', ['scripts/newsletter/send.mjs'])",
  };
  const r = evaluateGuards({ libFiles: LIB, scriptFiles: { ...ENTRY, ...LIB }, testFiles });
  assert.equal(r.checked.length, 1);
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.checked[0].provenCallSites, ['scripts/newsletter/send.mjs']);
});

test('guard with only a unit test is flagged', () => {
  const r = evaluateGuards({ libFiles: LIB, scriptFiles: { ...ENTRY, ...LIB },
    testFiles: { 'scripts/lib/subscriber-send-guard.test.mjs': UNIT } });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].guard, 'stripSubscriberJunk');
  assert.match(r.findings[0].reason, /send\.mjs/);
});

test('a test that merely names the script without spawning/importing does not prove the call site', () => {
  assert.equal(provesCallSite("// see send.mjs", 'scripts/newsletter/send.mjs'), false);
  assert.equal(provesCallSite("import x from '../newsletter/send.mjs'", 'scripts/newsletter/send.mjs'), true);
});

test('guard with no unit test is out of scope', () => {
  const r = evaluateGuards({ libFiles: LIB, scriptFiles: ENTRY, testFiles: {} });
  assert.equal(r.checked.length, 0);
});

test('real repo: pre-send-banner guard is proven wired', () => {
  const { checked } = auditRepo(root);
  const g = checked.find(c => c.guard === 'stripPreSendBanner');
  assert.ok(g, 'stripPreSendBanner should be audited');
  assert.ok(g.provenCallSites.some(s => s.endsWith('create-broadcast-draft.mjs')));
});

test('real repo CLI: advisory exit 0 and prints summary', () => {
  const r = spawnSync('node', [path.join(root, 'scripts/audit-guard-call-sites.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /audience-facing guard\(s\) checked/);
});

test('--strict exits 1 only when findings exist (real repo currently has some or none)', () => {
  const { findings } = auditRepo(root);
  const r = spawnSync('node', [path.join(root, 'scripts/audit-guard-call-sites.js'), '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, findings.length ? 1 : 0);
});
