/**
 * BRO-2816: checklist_gate / drift_gate in opening-night-broadcast.yml follow
 * orphan_gate's pattern — an informed block writes blocked=true and exits 0
 * (so later steps are never silently skipped), and the broadcast step checks
 * all three blocked outputs. Exit 1 survives only for unconfirmed delivery.
 * Pattern: require() the real helper (CLAUDE.md §15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { runGateAlert, isOwnerInformed } = require('../../scripts/lib/broadcast-gate-alert.js');

const quietLog = { error() {}, log() {} };
function tmpOutput() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'out');
  fs.writeFileSync(f, '');
  return f;
}

describe('runGateAlert exit code and blocked output', () => {
  for (const action of ['silent', 'digest']) {
    test(`informed via '${action}' → exit 0, blocked=true`, async () => {
      const out = tmpOutput();
      const calls = [];
      const code = await runGateAlert('checklist', 'a-show,b-show', {
        routeAlertFn: async (a) => { calls.push(a); return { action }; }, outputFile: out, log: quietLog,
      });
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.readFileSync(out, 'utf8'), 'blocked=true\n');
      assert.strictEqual(calls[0].conditionKey, 'broadcast-gate:checklist:a-show,b-show');
      assert.strictEqual(calls[0].disposition, 'human');
    });
  }

  test("delivered 'human' page → exit 0, blocked=true (drift)", async () => {
    const out = tmpOutput();
    const code = await runGateAlert('drift', 'x', {
      routeAlertFn: async () => ({ action: 'human', delivered: true }), outputFile: out, log: quietLog,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'blocked=true\n');
  });

  test("undelivered 'human' page → exit 1 so the fallback notifier fires", async () => {
    const out = tmpOutput();
    const code = await runGateAlert('drift', 'x', {
      routeAlertFn: async () => ({ action: 'human', delivered: false }), outputFile: out, log: quietLog,
    });
    assert.strictEqual(code, 1);
    assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /blocked=true/);
  });

  test('routeAlert throwing → exit 1, never blocked=true', async () => {
    const out = tmpOutput();
    const code = await runGateAlert('checklist', 'x', {
      routeAlertFn: async () => { throw new Error('resend down'); }, outputFile: out, log: quietLog,
    });
    assert.strictEqual(code, 1);
    assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /blocked=true/);
  });

  test('unknown gate name → exit 1', async () => {
    const code = await runGateAlert('orphan', 'x', { routeAlertFn: async () => ({ action: 'silent' }), log: quietLog });
    assert.strictEqual(code, 1);
  });

  test('isOwnerInformed treats missing/auto results as not informed', () => {
    assert.strictEqual(isOwnerInformed(null), false);
    assert.strictEqual(isOwnerInformed({ action: 'auto' }), false);
  });
});

describe('opening-night-broadcast.yml gate wiring', () => {
  const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/opening-night-broadcast.yml', import.meta.url), 'utf8'));
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
  const byId = (id) => steps.find((s) => s.id === id);
  const byName = (re) => steps.find((s) => re.test(s.name || ''));

  test('checklist_gate and drift_gate call the shared helper and never process.exit(1) inline', () => {
    for (const [id, gate] of [['checklist_gate', 'checklist'], ['drift_gate', 'drift']]) {
      const run = byId(id).run;
      assert.doesNotMatch(run, /process\.exit\(1\)/, `${id} still hard-fails inline`);
      assert.match(run, new RegExp(`node scripts/lib/broadcast-gate-alert\\.js ${gate}\\b`));
      assert.match(run, /blocked=false/, `${id} pass branch must write blocked=false`);
    }
  });

  test('broadcast step is gated on all three gates', () => {
    const cond = byId('broadcast').if;
    for (const id of ['checklist_gate', 'drift_gate', 'orphan_gate']) {
      assert.match(cond, new RegExp(`steps\\.${id}\\.outputs\\.blocked != 'true'`), `broadcast if: misses ${id}`);
    }
  });

  test('gather-more-reviews stays skipped on a checklist/drift block (no paid ~2h loop)', () => {
    const cond = byName(/^Gather more reviews/).if;
    assert.match(cond, /steps\.checklist_gate\.outputs\.blocked != 'true'/);
    assert.match(cond, /steps\.drift_gate\.outputs\.blocked != 'true'/);
  });

  test('a checklist block skips the drift alert, and any block skips the paid orphan rescore', () => {
    assert.match(byId('drift_gate').if, /steps\.checklist_gate\.outputs\.blocked != 'true'/);
    const orphan = byId('orphan_gate').if;
    assert.match(orphan, /steps\.checklist_gate\.outputs\.blocked != 'true'/);
    assert.match(orphan, /steps\.drift_gate\.outputs\.blocked != 'true'/);
  });

  test('failure notifiers are not masked by a gate block', () => {
    for (const s of [byId('notify')]) {
      assert.doesNotMatch(String(s.if), /outputs\.blocked/, `${s.name}: a blocked gate must not hide later failures`);
    }
  });
});
