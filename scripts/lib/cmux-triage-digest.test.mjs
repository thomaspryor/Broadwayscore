/**
 * cmux-triage-digest.test.mjs — BRO-3050 piece 1.
 *
 * Requires the real functions (CLAUDE.md rule 15). The core rule under test:
 * a degraded or cmux-less run NEVER renders a verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { interpretTriageRun, renderCmuxTriageLine, collectCmuxTriage, parseTriageJson } = require('./cmux-triage-digest.js');

const payload = (over = {}) => JSON.stringify({
  deadCount: 3, liveCount: 9, foreignAgentAlive: [], livenessUnverifiable: [], degraded: false, degradedReasons: [],
  safeToClose: [{ ref: 'workspace:1' }], needsResuming: [{ ref: 'workspace:2' }], needsOwnerCall: [{ ref: 'workspace:3' }, { ref: 'workspace:4' }],
  ...over,
}, null, 2);

test('a clean run renders needsResuming / needsOwnerCall counts', () => {
  const s = interpretTriageRun({ status: 0, stdout: payload(), stderr: '' });
  assert.equal(s.state, 'ok');
  assert.equal(s.needsResuming, 1);
  assert.equal(s.needsOwnerCall, 2);
  const line = renderCmuxTriageLine(s);
  assert.equal(line.level, 'watch');
  assert.match(line.text, /1 tab needs resuming, 2 need an owner call, 1 safe to close/);
});

test('the foreignAgentAlive list is rendered as live sessions, not corpses', () => {
  const s = interpretTriageRun({ status: 0, stdout: payload({
    needsResuming: [], needsOwnerCall: [],
    foreignAgentAlive: [{ ref: 'workspace:100', title: '🧭 👑 OWNER — land card #1889', agent: 'codex' }],
  }) });
  const line = renderCmuxTriageLine(s);
  assert.equal(line.level, 'watch');
  assert.match(line.text, /workspace:100 .*live codex session/);
  assert.match(line.text, /not corpses/);
});

test('an all-zero clean run is an ok line', () => {
  const s = interpretTriageRun({ status: 0, stdout: payload({ safeToClose: [], needsResuming: [], needsOwnerCall: [] }) });
  const line = renderCmuxTriageLine(s);
  assert.equal(line.level, 'ok');
  assert.match(line.text, /0 tabs need resuming, 0 need an owner call\./);
});

test('exit 2 is degraded and renders NO verdict, even though the payload has counts', () => {
  const s = interpretTriageRun({ status: 2, stdout: payload({ degraded: true, degradedReasons: ['dispatch ledger unreadable (EACCES)'] }) });
  assert.equal(s.state, 'degraded');
  assert.equal(s.needsResuming, undefined, 'no counts may leak out of a degraded run');
  const line = renderCmuxTriageLine(s);
  assert.equal(line.level, 'unknown');
  assert.match(line.text, /DEGRADED/);
  assert.match(line.text, /dispatch ledger unreadable/);
  assert.match(line.text, /No verdict/);
  assert.doesNotMatch(line.text, /need resuming|needs resuming/);
});

test('degraded:true with exit 0 is still degraded (payload flag wins)', () => {
  const s = interpretTriageRun({ status: 0, stdout: payload({ degraded: true, degradedReasons: [] }), stderr: '[cmux-triage] WARN --no-linear: verdicts below rest on...' });
  assert.equal(s.state, 'degraded');
  assert.match(s.reason, /--no-linear/);
});

test('cmux absent (cloud / CI) is said explicitly, never "0 dead tabs"', () => {
  const s = interpretTriageRun({ status: 1, stdout: '', stderr: '[cmux-triage] cmux CLI not found — is cmux.app installed?\n' });
  assert.equal(s.state, 'unavailable');
  const line = renderCmuxTriageLine(s);
  assert.equal(line.level, 'unknown');
  assert.match(line.text, /cmux is not available/);
  assert.doesNotMatch(line.text, /\b0\b/);
});

test('a crash, timeout, spawn error or garbage output is "could not run", never a verdict', () => {
  for (const run of [
    { status: 1, stdout: '', stderr: '[cmux-triage] TypeError: boom' },
    { status: null, error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
    { status: null, signal: 'SIGTERM' },
    { status: 0, stdout: 'not json' },
    { status: 0, stdout: '{"deadCount":1}' },
  ]) {
    const s = interpretTriageRun(run);
    assert.equal(s.state, 'failed', JSON.stringify(run));
    assert.match(renderCmuxTriageLine(s).text, /could not run/);
  }
  assert.match(renderCmuxTriageLine(null).text, /could not run/);
});

test('parseTriageJson tolerates a banner printed before the JSON object', () => {
  const out = `[cmux-triage] 1 tab(s) look DEAD...\n  workspace:100 "x" — live codex session\n\n${payload()}`;
  assert.equal(parseTriageJson(out).deadCount, 3);
  assert.equal(parseTriageJson(''), null);
});

test('collectCmuxTriage shells `node cmux-triage.js --json` and never throws', () => {
  let seen = null;
  const s = collectCmuxTriage({ spawnSync: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: payload(), stderr: '' }; } });
  assert.equal(seen.cmd, process.execPath);
  assert.match(seen.args[0], /cmux-triage\.js$/);
  assert.deepEqual(seen.args.slice(1), ['--json']);
  assert.ok(seen.opts.timeout > 0, 'must be time-bounded so it cannot block the send');
  assert.equal(s.state, 'ok');

  const thrown = collectCmuxTriage({ spawnSync: () => { throw new Error('EAGAIN'); } });
  assert.equal(thrown.state, 'failed');
});

test('collectCmuxTriage against the REAL CLI on a machine without cmux reports unavailable', async (t) => {
  const { cmuxAvailable } = require('./cmux-workspaces.js');
  if (cmuxAvailable()) { t.skip('cmux is installed here; the absent-cmux path is covered by the stubbed tests'); return; }
  const s = collectCmuxTriage();
  assert.equal(s.state, 'unavailable');
});

test('the real buildHtml renders the triage line, and a degraded one without counts', () => {
  const { buildHtml } = require('../send-morning-digest.js');
  const ok = buildHtml({ sections: { cmuxTriage: interpretTriageRun({ status: 0, stdout: payload() }) } });
  assert.match(ok, /Dead cmux tab triage: 1 tab needs resuming, 2 need an owner call/);
  const deg = buildHtml({ sections: { cmuxTriage: interpretTriageRun({ status: 2, stdout: payload({ degraded: true }) }) } });
  assert.match(deg, /Dead cmux tab triage: DEGRADED/);
  assert.doesNotMatch(deg, /need resuming|needs resuming/);
  assert.doesNotMatch(buildHtml({ sections: {} }), /Dead cmux tab triage/);
});

test('main() collects the triage (wire check)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(new URL('../send-morning-digest.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /sections\.cmuxTriage = collectCmuxTriage\(/);
  assert.match(src, /renderCmuxTriageLine\(sections\.cmuxTriage\)/);
});
