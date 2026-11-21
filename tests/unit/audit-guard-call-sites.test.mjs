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

// --- review fixes (BRO-2484 follow-up) ---
const SELF = 'tests/unit/audit-guard-call-sites.test.mjs';
const E = 'scripts/newsletter/send.mjs';

test('the audit own test file never counts as unit test or call-site proof', () => {
  const r = evaluateGuards({ libFiles: LIB, scriptFiles: { ...ENTRY, ...LIB },
    testFiles: { [SELF]: UNIT + " spawnSync('node', ['scripts/newsletter/send.mjs'])" } });
  assert.equal(r.checked.length, 0);
  const r2 = evaluateGuards({ libFiles: LIB, scriptFiles: { ...ENTRY, ...LIB },
    testFiles: { 'scripts/lib/subscriber-send-guard.test.mjs': UNIT,
      [SELF]: "spawnSync('node', ['scripts/newsletter/send.mjs'])" } });
  assert.equal(r2.findings.length, 1);
});

test('RegExp.exec / method calls are not process spawns', () => {
  assert.equal(provesCallSite("/x/.exec(s); // send.mjs", E), false);
  assert.equal(provesCallSite("const f = 'scripts/newsletter/send.mjs'; re.exec(f)", E), false);
  assert.equal(provesCallSite("exec('node scripts/newsletter/send.mjs')", E), true);
});

test('the entry must be inside the spawn/import argument, not just elsewhere in the file', () => {
  assert.equal(provesCallSite("// send.mjs\nspawnSync('node', ['other.mjs'])", E), false);
  assert.equal(provesCallSite("spawnSync('node', [path.join(root, 'scripts/newsletter/send.mjs')])", E), true);
  assert.equal(provesCallSite("await import('../scripts/newsletter/send.mjs')", E), true);
});

test('basename matching is anchored on a path separator, not a substring', () => {
  assert.equal(provesCallSite("spawnSync('node', ['scripts/presend.mjs'])", E), false);
  assert.equal(provesCallSite("spawnSync('node', ['scripts/other/send.mjs.bak'])", E), false);
  assert.equal(provesCallSite("spawnSync('node', ['./send.mjs'])", E), true);
});

test('exportedNames reads past nested braces and ignores nested keys', () => {
  const src = "module.exports = {\n  a, b: function () { return {x: 1}; },\n  CONFIG: { inner: 1, other: 2 },\n  // c,\n  d,\n};";
  assert.deepEqual(exportedNames(src), ['a', 'b', 'CONFIG', 'd']);
});
