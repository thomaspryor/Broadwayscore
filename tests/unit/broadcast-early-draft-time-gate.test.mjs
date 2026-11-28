// BRO-7676 (owner 2026-11-17): the opening-night Resend DRAFT must be made as soon
// as reviews are ready, at any hour and on every trigger. The old time gate set
// blocked=true before 7 AM ET for everything but a manual dispatch, so on press
// night (reviews land 7-11 PM ET = 00-04 UTC) no draft appeared until morning.
// This runs the real time_gate script for every hour and pins:
//   - it never blocks;
//   - before 7 AM ET it flags early_draft=true (app push waits, no preview email);
//   - the draft step skips the owner-preview fallback when early_draft is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const wf = yaml.load(readFileSync(new URL('../../.github/workflows/opening-night-broadcast.yml', import.meta.url), 'utf8'));
const steps = Object.values(wf.jobs).flatMap(j => j.steps || []);
const timeGate = steps.find(s => s.id === 'time_gate');
const draftStep = steps.find(s => s.id === 'broadcast');

function runGateAt(etHour) {
  const dir = mkdtempSync(path.join(tmpdir(), 'time-gate-'));
  try {
    // Fake `date` that reports the given hour; the step must ask for ET itself.
    const fakeDate = path.join(dir, 'date');
    writeFileSync(fakeDate, `#!/bin/bash\n[ "$TZ" = "America/New_York" ] && { printf '%02d\\n' ${etHour}; exit 0; }\necho 99\n`);
    chmodSync(fakeDate, 0o755);
    const out = path.join(dir, 'out');
    writeFileSync(out, '');
    execFileSync('bash', ['-eo', 'pipefail', '-c', timeGate.run], {
      env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out },
      stdio: 'pipe',
    });
    return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('=')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('time_gate never blocks a draft, at any ET hour', () => {
  assert.ok(timeGate, 'time_gate step missing');
  for (let h = 0; h < 24; h++) {
    const o = runGateAt(h);
    assert.equal(o.blocked, 'false', `hour ${h} ET blocked the draft`);
    assert.equal(o.early_draft === 'true', h < 7, `hour ${h} ET early_draft=${o.early_draft}`);
  }
});

test('time_gate has no trigger-specific branch (every trigger drafts early)', () => {
  assert.doesNotMatch(timeGate.run, /EVENT_NAME|CREATE_DRAFT|blocked=true/);
});

test('draft step skips the owner preview email when early_draft is set', () => {
  assert.ok(draftStep, 'broadcast step missing');
  assert.match(String(draftStep.env.EARLY_DRAFT), /steps\.time_gate\.outputs\.early_draft/);
  const i = draftStep.run.indexOf('if [ "$EARLY_DRAFT" = "true" ]');
  const j = draftStep.run.indexOf('preview to owner instead');
  assert.ok(i > 0 && i < j, 'early-draft return must come before the preview fallback');
});
