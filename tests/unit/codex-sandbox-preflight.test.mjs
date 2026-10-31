// BRO-5856: the Codex runner must not launch `workspace-write` where bubblewrap cannot start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const P = require('../../scripts/lib/codex-sandbox-preflight.js');
const BLOCKED = () => ({ code: 1, out: 'unshare: write failed /proc/self/uid_map: Operation not permitted' });
const OK = () => ({ code: 0, out: '' });

test('probe: namespaces work -> usable', () => {
  assert.equal(P.probeNamespaceSandbox(OK, 'linux').usable, true);
});
test('probe: uid_map refused on linux -> unusable with the reason', () => {
  const r = P.probeNamespaceSandbox(BLOCKED, 'linux');
  assert.equal(r.usable, false);
  assert.match(r.reason, /uid_map/);
});
test('probe: macOS never runs unshare', () => {
  let called = false;
  assert.equal(P.probeNamespaceSandbox(() => { called = true; return BLOCKED(); }, 'darwin').usable, true);
  assert.equal(called, false);
});
test('choose: usable -> workspace-write', () => {
  assert.equal(P.chooseSandbox({ usable: true, reason: 'x' }, {}).mode, 'workspace-write');
});
test('choose: unusable in cloud VM -> refuses by default (full access would let Codex rewrite the runner)', () => {
  const c = P.chooseSandbox(P.probeNamespaceSandbox(BLOCKED, 'linux'), { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(c.ok, false);
  assert.match(c.reason, /codex unusable here/);
});
test('choose: danger-full-access only with explicit opt-in inside a cloud VM', () => {
  const probe = P.probeNamespaceSandbox(BLOCKED, 'linux');
  assert.equal(P.chooseSandbox(probe, { CLAUDE_CODE_REMOTE: 'true', CODEX_RUNNER_ALLOW_FULL_ACCESS: '1' }).mode, 'danger-full-access');
  assert.equal(P.chooseSandbox(probe, { CODEX_RUNNER_ALLOW_FULL_ACCESS: '1' }).ok, false);
});
test('probe: missing unshare (empty output) is unusable with a hint', () => {
  const r = P.probeNamespaceSandbox(() => ({ code: -1, out: '' }), 'linux');
  assert.equal(r.usable, false);
  assert.match(r.reason, /unshare installed/);
});
test('choose: unusable on a non-cloud host -> refuses, never unsandboxed', () => {
  const c = P.chooseSandbox(P.probeNamespaceSandbox(BLOCKED, 'linux'), {});
  assert.equal(c.ok, false);
  assert.equal(c.mode, null);
  assert.match(c.reason, /codex unusable here/);
});
test('daily-runner picks its sandbox through the preflight, not a hardcoded mode', () => {
  const src = fs.readFileSync(new URL('../../scripts/codex/daily-runner.js', import.meta.url), 'utf8');
  assert.ok(!/'--sandbox', 'workspace-write'/.test(src));
  assert.match(src, /'--sandbox', codexSandboxMode\(\)/);
});
