// BRO-7796 class guard: the landed-change audit may dispatch workflows on its own, so every allowlisted workflow must
// stay read-only (no spend, no email, no data write), and the YAML copy of the list must equal the code's list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DISPATCH_ALLOWLIST, DISPATCH_CAP } from '../../scripts/lib/landed-change-proof.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const wfText = (n) => fs.readFileSync(path.join(ROOT, '.github/workflows', n), 'utf8');
// Secrets a read-only check may see. Anything else could spend or send.
const OK_SECRETS = new Set(['GITHUB_TOKEN', 'DISCORD_WEBHOOK_ALERTS']);

test('every allowlisted workflow is dispatchable, contents: read, no writer step, no spend or email secret', () => {
  assert.ok(DISPATCH_ALLOWLIST.size > 0);
  for (const wf of DISPATCH_ALLOWLIST) {
    const t = wfText(wf).replace(/^\s*#.*$/gm, '');
    assert.match(t, /workflow_dispatch/, `${wf} must be dispatchable`);
    assert.match(t, /permissions:\s*\n\s+contents: read/, `${wf} must be contents: read`);
    assert.doesNotMatch(t, /contents: write|issues: write|pull-requests: write|actions: write/, `${wf} must not write`);
    assert.doesNotMatch(t, /push-with-retry|git push|git commit|push-core-data|push-review-texts|gh workflow run|gh issue|gh pr /, `${wf} must have no writer step`);
    assert.doesNotMatch(t, /severity:\s*'?critical|email:\s*'?true/, `${wf} must not page or email`);
    for (const s of t.matchAll(/secrets\.(\w+)/g)) assert.ok(OK_SECRETS.has(s[1]), `${wf} uses secret ${s[1]}, which could spend or send: take it off the allowlist`);
    for (const a of t.matchAll(/uses:\s*(\.\/\.github\/actions\/[\w-]+)/g)) assert.ok(['./.github/actions/notify-failure', './.github/actions/setup-node'].includes(a[1]), `${wf} uses unvetted action ${a[1]}`);
  }
});

test('landed-change-proof.yml dispatch job: same list as the code, job-scoped actions: write, capped', () => {
  const y = wfText('landed-change-proof.yml').replace(/^\s*#.*$/gm, '');
  const m = /allow="([^"]+)"/.exec(y);
  assert.ok(m, 'dispatch job must carry its own allow list');
  assert.deepEqual(new Set(m[1].trim().split(/\s+/)), DISPATCH_ALLOWLIST);
  assert.match(y, /\[ "\$n" -ge (\d+) \]/);
  assert.equal(Number(/\[ "\$n" -ge (\d+) \]/.exec(y)[1]), DISPATCH_CAP);
  // actions: write only inside the dispatch job, never at workflow level or in the audit job.
  const top = y.slice(0, y.indexOf('\njobs:'));
  assert.doesNotMatch(top, /actions: write/);
  const audit = y.slice(y.indexOf('\n  audit:'), y.indexOf('\n  dispatch:'));
  assert.doesNotMatch(audit, /actions: write/);
  assert.match(y.slice(y.indexOf('\n  dispatch:')), /permissions:\s*\n\s+actions: write/);
  // No checkout in this job, so gh needs the repo named explicitly or every dispatch fails (BRO-7796 review).
  assert.match(y.slice(y.indexOf('\n  dispatch:')), /GH_REPO:\s*\$\{\{ github\.repository \}\}|--repo/);
});
