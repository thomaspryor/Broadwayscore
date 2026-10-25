// BRO-2067: a Vercel-side CANCELED deployment (push burst, "latest wins")
// must be detected within one poll interval, not hang to the step timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { classifyState, waitForDeployment, hasNewerLiveDeployment, exitCodeFor, EXIT } =
  require('../../scripts/lib/vercel-deploy-wait.js');

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}
const seq = (...states) => { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; };

test('classifyState maps Vercel readyStates', () => {
  assert.equal(classifyState('READY'), 'ready');
  assert.equal(classifyState('CANCELED'), 'canceled');
  assert.equal(classifyState('ERROR'), 'error');
  for (const s of ['QUEUED', 'INITIALIZING', 'BUILDING', undefined, 'weird']) assert.equal(classifyState(s), 'pending');
});

test('burst: BUILDING then CANCELED resolves on the 3rd poll, far before timeout', async () => {
  const c = fakeClock();
  const r = await waitForDeployment({ fetchState: seq('QUEUED', 'BUILDING', 'CANCELED'), ...c, timeoutMs: 480000, intervalMs: 10000 });
  assert.equal(r.outcome, 'canceled');
  assert.equal(r.polls, 3);
  assert.ok(c.now() <= 20000, 'resolved in ~20s of fake time, not 480s');
  assert.equal(exitCodeFor(r.outcome), EXIT.CANCELED);
});

test('READY resolves; ERROR resolves', async () => {
  assert.equal((await waitForDeployment({ fetchState: seq('BUILDING', 'READY'), ...fakeClock(), timeoutMs: 60000 })).outcome, 'ready');
  assert.equal((await waitForDeployment({ fetchState: seq('ERROR'), ...fakeClock(), timeoutMs: 60000 })).outcome, 'error');
});

test('never-terminal state times out instead of looping forever', async () => {
  const r = await waitForDeployment({ fetchState: seq('BUILDING'), ...fakeClock(), timeoutMs: 60000, intervalMs: 10000 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(exitCodeFor('timeout'), EXIT.TIMEOUT);
});

test('transient API throw is pending; fatal 4xx fails fast', async () => {
  let n = 0;
  const flaky = async () => { if (n++ === 0) throw new Error('503'); return 'READY'; };
  assert.equal((await waitForDeployment({ fetchState: flaky, ...fakeClock(), timeoutMs: 60000 })).outcome, 'ready');
  const c = fakeClock();
  const bad = async () => { const e = new Error('401'); e.fatal = true; e.status = 401; throw e; };
  const r = await waitForDeployment({ fetchState: bad, ...c, timeoutMs: 480000 });
  assert.equal(r.outcome, 'error');
  assert.equal(r.polls, 1);
});

test('workflow: --no-wait + poll, superseded gates every post-deploy step', () => {
  const y = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  assert.match(y, /vercel deploy --prebuilt --prod --no-wait/);
  assert.match(y, /node scripts\/vercel-wait-deployment\.js/);
  assert.match(y, /echo "superseded=true" >> "\$GITHUB_OUTPUT"/);
  const gated = y.match(/steps\.deploy\.outputs\.superseded != 'true'/g) || [];
  assert.equal(gated.length, 5, 'smoke, playwright setup+test, watermark, sitemap');
  for (const name of ['Smoke test production', 'Setup Playwright', 'Content smoke test (Playwright)',
    'Dispatch async watermark + stage-latency update', 'Notify search engines of updated sitemap']) {
    const i = y.indexOf(`- name: ${name}\n`);
    assert.ok(i > 0, name);
    assert.match(y.slice(i, i + 200), /superseded != 'true'/, `${name} gated`);
  }
});

test('superseded only when a newer non-canceled production deployment exists', () => {
  const ours = 1000;
  assert.equal(hasNewerLiveDeployment(ours, [{ createdAt: 2000, readyState: 'BUILDING' }]), true);
  assert.equal(hasNewerLiveDeployment(ours, [{ createdAt: 2000, readyState: 'READY' }]), true);
  assert.equal(hasNewerLiveDeployment(ours, [{ createdAt: 2000, readyState: 'CANCELED' }]), false, 'newer but also canceled = burst, keep retrying');
  assert.equal(hasNewerLiveDeployment(ours, [{ createdAt: 500, readyState: 'READY' }]), false, 'older does not supersede');
  assert.equal(hasNewerLiveDeployment(ours, []), false);
  assert.equal(EXIT.CANCELED_SUPERSEDED, 5);
});

test('workflow: superseded keys off wait-script exit 5, not main moving', () => {
  const y = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  assert.match(y, /"\$status" -eq 5/);
  assert.doesNotMatch(y, /git ls-remote origin refs\/heads\/main/);
});
