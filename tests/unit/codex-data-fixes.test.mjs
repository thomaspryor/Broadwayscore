// BRO-6175: the Codex lane does private-data fixes through the reviewed pending-fixes route.
// Requires the real functions (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// BRO-6303: codexCardFit defaults read the committed trust ladder; pin them to the pre-ladder baseline.
process.env.CODEX_TRUST_LADDER_DISABLED = '1';
const r = require('../../scripts/lib/codex-runner.js');
const DF = require('../../scripts/lib/codex-data-fixes.js');
const fit = (title, description = 'Fix it.', canDispatch = true) => r.codexCardFit({ title, description, verify: 'node --test tests/unit/x.test.mjs', canDispatch });
const withEnv = (v, fn) => { const o = process.env.CODEX_DATA_FIXES_DISABLED; if (v == null) delete process.env.CODEX_DATA_FIXES_DISABLED; else process.env.CODEX_DATA_FIXES_DISABLED = v; try { return fn(); } finally { if (o == null) delete process.env.CODEX_DATA_FIXES_DISABLED; else process.env.CODEX_DATA_FIXES_DISABLED = o; } };

test('private-repo-write: pending-fixes / execute-approved-fix / approved-fix plan cards are eligible', () => {
  withEnv(null, () => {
    assert.equal(fit('Fix the Hamilton venue field', 'Write data/pending-fixes/bro-1.json and let execute-approved-fix apply it.').skip, null);
    assert.equal(fit('Repair role label', 'Data repair through an approved-fix plan.').skip, null);
  });
});

test('private-repo-write: a direct private-repo edit with no plan route stays skipped', () => {
  withEnv(null, () => {
    assert.equal(fit('x', 'write to broadway-review-texts').skip, 'private-repo-write');
    assert.equal(fit('x', 'edit files in broadway-scorecard-data directly').skip, 'private-repo-write');
    // Naming the route as well makes it a plan card.
    assert.equal(fit('x', 'Fix a field in broadway-scorecard-data via data/pending-fixes/bro-2.json').skip, null);
  });
});

test('auto-filed-alert: BSC Daily cards are eligible only when the card names the plan route', () => {
  withEnv(null, () => {
    assert.equal(fit('BSC Daily: Data: stuck pipeline items').skip, 'auto-filed-alert');
    assert.equal(fit('P1: BSC Rebuild: 49 reviews dropped').skip, 'auto-filed-alert');
    assert.equal(fit('BSC Daily: Data: wrong opening date', 'Fix with a data-edit plan in data/pending-fixes/.').skip, null);
  });
});

test('skips the route cannot do are unchanged: corpus-wide, workflow-edit, mac-only, land-ref', () => {
  withEnv(null, () => {
    assert.equal(fit('Fix 1003 shipped reviews', 'via data/pending-fixes, 1003 shipped reviews in 464 shows').skip, 'corpus-wide-data');
    assert.equal(fit('Edit flow', 'Then edit .github/workflows/land.yml and add a pending-fixes plan.').skip, 'workflow-edit');
    assert.equal(fit('Fix launchd job', 'pending-fixes plan').skip, 'mac-only');
    assert.equal(fit('Cut Actions minutes', 'land/** push, plus a pending-fixes plan').skip, 'land-ref');
  });
});

test('CODEX_DATA_FIXES_DISABLED restores the old skips', () => {
  withEnv('1', () => {
    assert.equal(DF.dataFixesEnabled(), false);
    assert.equal(fit('Repair role label', 'Data repair through an approved-fix plan.').skip, 'private-repo-write');
    assert.equal(fit('BSC Daily: Data: wrong opening date', 'Fix with a data-edit plan in data/pending-fixes/.').skip, 'private-repo-write');
    assert.equal(fit('BSC Daily: Data: stuck').skip, 'auto-filed-alert');
  });
  withEnv(null, () => assert.equal(DF.dataFixesEnabled(), true));
});

test('cardPlanFiles: the card own plan and its split parts only', () => {
  const names = ['data/pending-fixes/bro-61.json', 'bro-61-b.json', 'bro-610.json', 'bro-6.json', 'bro-61-b-c.json', 'notes.md'];
  assert.deepEqual(DF.cardPlanFiles(names, 'BRO-61'), ['bro-61-b.json', 'bro-61.json']);
  assert.deepEqual(DF.cardPlanFiles(names, 'x'), []);
});

const plan = (types, extra = {}) => ({ issueNumber: 'bro-9', planId: 'p1', status: 'pending', plan: { actions: types.map((type) => ({ type })) }, ...extra });

test('codexPlanAllowed: field edits only, capped', () => {
  assert.equal(DF.codexPlanAllowed(plan(['data-edit', 'review-field-edit'])), null);
  assert.match(DF.codexPlanAllowed(plan(['data-edit', 'run-script'])), /run-script/);
  assert.match(DF.codexPlanAllowed(plan(['retire-show'])), /retire-show/);
  assert.match(DF.codexPlanAllowed(plan(Array(26).fill('data-edit'))), /26 actions/);
  assert.match(DF.codexPlanAllowed(plan([])), /no actions/);
  assert.match(DF.codexPlanAllowed(null), /no actions/);
});

test('planNotApplied: only status applied from CI counts', () => {
  assert.equal(DF.planNotApplied({ status: 'applied', executedIn: 'ci' }), null);
  assert.match(DF.planNotApplied({ status: 'applied', executedIn: 'local' }), /local/);
  assert.match(DF.planNotApplied({ status: 'applied' }), /applied/);
  assert.equal(DF.planNotApplied({ status: 'applied' }, { legacyOk: true }), null);
  assert.match(DF.planNotApplied({ status: 'applied', executedIn: 'local' }, { legacyOk: true }), /local/);
  assert.match(DF.planNotApplied({ status: 'partial', executedIn: 'ci', results: [{ status: 'refused' }] }), /partial.*1 action/);
  assert.match(DF.planNotApplied({ status: 'validation-failed' }), /validation-failed/);
  assert.match(DF.planNotApplied({ status: 'pending' }), /pending/);
});

// A fake of the runner's git/dispatch: `main` holds plan files; a dispatch run flips one to the given outcome.
function fake(files, outcome, { lastWriter = 'github-actions[bot]\tfix(data): Execute approved fix for #bro-9', landing = '' } = {}) {
  const main = { ...files };
  const calls = [];
  const io = {
    log: () => {},
    git: (a) => {
      if (a[0] === 'fetch') return '';
      if (a[0] === 'ls-tree') return Object.keys(main).map((f) => `data/pending-fixes/${f}`).join('\n');
      if (a[0] === 'log') return a.includes('--author=Codex runner') ? landing : lastWriter;
      if (a[0] === 'show') return JSON.stringify(main[a[1].split('/').pop()]);
      throw new Error(`unexpected git ${a.join(' ')}`);
    },
    dispatch: async (a) => {
      calls.push(a);
      if (a[0] === 'execute-approved-fix.yml') {
        const id = a.find((x) => x.startsWith('issue_number=')).split('=')[1];
        const f = `${id}.json`;
        main[f] = { ...main[f], ...outcome.plan };
        return { code: outcome.code, out: outcome.out || '' };
      }
      return { code: 0, out: '' };
    },
  };
  return { io, calls };
}

test('applyCardFixPlans: no plan -> none, nothing dispatched', async () => {
  const { io, calls } = fake({ 'bro-1.json': plan(['data-edit']) }, { code: 0, plan: {} });
  assert.deepEqual(await DF.applyCardFixPlans('BRO-77', io), { kind: 'none' });
  assert.equal(calls.length, 0);
});

test('applyCardFixPlans: pending plan is dispatched in apply mode, checked on main, then rebuilt', async () => {
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  const res = await DF.applyCardFixPlans('BRO-9', io);
  assert.equal(res.kind, 'applied');
  assert.deepEqual(calls[0].slice(0, 7), ['execute-approved-fix.yml', '-f', 'issue_number=bro-9', '-f', 'plan_id=p1', '-f', 'mode=apply']);
  assert.ok(calls[0].includes('--wait'));
  assert.equal(calls[1][0], 'rebuild-fast.yml');
});

// BRO-6260: the cloud lane waits only for what is left before its hard stop.
test('applyCardFixPlans: the apply wait is clamped to applyWaitMin; no time left defers without dispatching', async () => {
  const t = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  await DF.applyCardFixPlans('BRO-9', t.io, { applyWaitMin: 12.7 });
  assert.ok(t.calls[0].includes('--timeout=12'));
  const d = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  await DF.applyCardFixPlans('BRO-9', d.io);
  assert.ok(d.calls[0].includes(`--timeout=${DF.APPLY_WAIT_MIN}`));
  const late = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: {} });
  const res = await DF.applyCardFixPlans('BRO-9', late.io, { applyWaitMin: 0 });
  assert.equal(res.kind, 'deferred');
  assert.equal(late.calls.length, 0);
});

test('applyCardFixPlans: a green run over a partial plan is a failure (already-applied is green in CI)', async () => {
  const { io } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'partial', executedIn: 'ci' } });
  const res = await DF.applyCardFixPlans('BRO-9', io);
  assert.equal(res.kind, 'failed');
  assert.match(res.why, /partial/);
});

test('applyCardFixPlans: a failed run fails; a disallowed plan is never dispatched; an applied plan is idempotent', async () => {
  let t = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 1, plan: {}, out: 'boom' });
  const failed = await DF.applyCardFixPlans('BRO-9', t.io);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.why, /exit 1/);
  t = fake({ 'bro-9.json': plan(['add-show']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  const bad = await DF.applyCardFixPlans('BRO-9', t.io);
  assert.equal(bad.kind, 'failed');
  assert.equal(t.calls.length, 0);
  t = fake({ 'bro-9.json': plan(['data-edit'], { status: 'applied', executedIn: 'ci' }) }, { code: 1, plan: {} });
  const again = await DF.applyCardFixPlans('BRO-9', t.io);
  assert.equal(again.kind, 'applied');
  assert.ok(!t.calls.some((c) => c[0] === 'execute-approved-fix.yml'));
});

test('applyCardFixPlans: split plans are all applied before the card settles', async () => {
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit']), 'bro-9-b.json': plan(['data-edit'], { issueNumber: 'bro-9-b', planId: 'p2' }) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  const res = await DF.applyCardFixPlans('BRO-9', io, { rebuild: false });
  assert.equal(res.kind, 'applied');
  assert.equal(calls.filter((c) => c[0] === 'execute-approved-fix.yml').length, 2);
});

test('applyCardFixPlans: a plan Codex marked applied itself is refused (executor must have written it)', async () => {
  const t = fake({ 'bro-9.json': plan(['data-edit'], { status: 'applied', executedIn: 'ci' }) }, { code: 0, plan: {} }, { lastWriter: 'codex-bot\tfeat: BRO-9 fix' });
  const res = await DF.applyCardFixPlans('BRO-9', t.io);
  assert.equal(res.kind, 'failed');
  assert.match(res.why, /executor/);
});

test('applyCardFixPlans: issue_number always comes from the file name, never the plan body', async () => {
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit'], { issueNumber: 'bro-1' }) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  await DF.applyCardFixPlans('BRO-9', io, { rebuild: false });
  assert.ok(calls[0].includes('issue_number=bro-9'));
});

test('applyCardFixPlans: with the route switched off a pending plan fails and nothing is dispatched', async () => {
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: {} });
  const res = await DF.applyCardFixPlans('BRO-9', io, { dispatch: false });
  assert.equal(res.kind, 'failed');
  assert.equal(calls.length, 0);
});

// The runner wiring cannot run without Codex and Linear, so pin the three seams: the apply sits inside
// settleLanded (every landing path), ahead of the partial and Done moves, and the prompt rule is gated.
import { readFileSync } from 'node:fs';
test('daily-runner wiring: apply inside settleLanded before Done; prompt rule behind the kill switch; dispatch permission', () => {
  const src = readFileSync(new URL('../../scripts/codex/daily-runner.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function settleLanded'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.ok(fn.indexOf('applyLandedPlans(id,') > 0 && fn.indexOf('applyLandedPlans(id,') < fn.indexOf('if (partial)') && fn.indexOf('if (partial)') < fn.indexOf("'Done'"));
  assert.match(fn, /already done; only the other items remain|is already done; only the other items remain/);
  // BRO-6194: a deferred apply leaves the card alone (no Todo bounce, which would hide it from the GHA lane for 14 days).
  const deferred = fn.slice(fn.indexOf("ap.kind === 'deferred'"), fn.indexOf("ap.kind === 'failed'"));
  assert.ok(deferred.includes('return false') && !deferred.includes('moveCard') && !deferred.includes('bounced'));
  // reconcileLanded only retries a card whose newest runner note starts with this heading.
  assert.match(src, /const DEFER_HEADING = '## Codex runner: landing did not finish/);
  assert.match(src, /startsWith\('## Codex runner: landing did not finish'\)/);
  // The lane's base slot (gha: 3) reconciles deferred applies; slot 0 alone never would on the GHA lane.
  assert.match(src, /DF\.reconcileSkips\(\{ deferred, onlyDeferred, canDispatch: DF\.canReconcileDeferred\(\) \}\)/);
  // BRO-6260: a cloud runner with CODEX_CAN_DISPATCH=1 still leaves deferred applies to the GHA lane.
  assert.equal(DF.canReconcileDeferred({ CODEX_CAN_DISPATCH: '1' }), false);
  assert.equal(DF.canReconcileDeferred({ GITHUB_ACTIONS: 'true' }), true);
  assert.match(src, /SLOT === R\.LANES\[OPTS\.lane\]\.base\) await reconcileLanded\(stats, \{ onlyDeferred: true \}\)/);
  assert.match(fn, /canDispatch: DF\.canDispatchWorkflows\(\), applyWaitMin: R\.landWaitMinutes\(/);
  assert.match(src, /DF\.dataFixesEnabled\(\) && DF\.canDispatchWorkflows\(\) \? DATA_FIX_RULE : ''/);
  assert.match(readFileSync(new URL('../../scripts/codex/runner-prompt.md', import.meta.url), 'utf8'), /\{\{DATA_FIX_RULE\}\}/);
  assert.match(readFileSync(new URL('../../.github/workflows/codex-runner.yml', import.meta.url), 'utf8'), /^permissions:\n  contents: read\n(?:  #.*\n)*  actions: write$/m);
});

// BRO-6194 item 1: only a runner that can dispatch workflows picks a route card.
test('canDispatchWorkflows: GitHub Actions or an explicit opt-in, nothing else', () => {
  assert.equal(DF.canDispatchWorkflows({}), false);
  assert.equal(DF.canDispatchWorkflows({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(DF.canDispatchWorkflows({ CODEX_CAN_DISPATCH: '1' }), true);
  assert.equal(DF.canDispatchWorkflows({ CODEX_CAN_DISPATCH: '0', GITHUB_ACTIONS: '' }), false);
});

test('codexCardFit: a route card is skipped for a runner that cannot dispatch, and only that one', () => {
  withEnv(null, () => {
    for (const [t, d] of [['Fix the Hamilton venue field', 'Write data/pending-fixes/bro-1.json.'], ['BSC Daily: Data: wrong opening date', 'Fix with a data-edit plan in data/pending-fixes/.'], ['x', 'Fix a field in broadway-scorecard-data via data/pending-fixes/bro-2.json']]) {
      assert.equal(fit(t, d, false).skip, 'data-route-gha-only', t);
      assert.equal(fit(t, d, true).skip, null, t);
    }
    assert.equal(fit('Fix a README typo', 'No data route here.', false).skip, null);
    assert.equal(fit('Fix the Hamilton venue field', 'Write data/pending-fixes/bro-1.json.\nCODEX-OK', false).skip, 'data-route-gha-only');
  });
  // Kill switch: no route at all, so the capability check does not add a second reason.
  withEnv('1', () => assert.equal(fit('Repair role label', 'Data repair through an approved-fix plan.', false).skip, 'private-repo-write'));
});

test('codexCardFit: default capability comes from the environment', () => {
  const keep = { a: process.env.GITHUB_ACTIONS, b: process.env.CODEX_CAN_DISPATCH };
  try {
    withEnv(null, () => {
      delete process.env.GITHUB_ACTIONS; delete process.env.CODEX_CAN_DISPATCH;
      const card = { title: 'Fix field', description: 'data/pending-fixes/bro-3.json', verify: 'node --test tests/unit/x.test.mjs' };
      assert.equal(r.codexCardFit(card).skip, 'data-route-gha-only');
      process.env.GITHUB_ACTIONS = 'true';
      assert.equal(r.codexCardFit(card).skip, null);
    });
  } finally { for (const [k, v] of [['GITHUB_ACTIONS', keep.a], ['CODEX_CAN_DISPATCH', keep.b]]) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
});

test('applyCardFixPlans: a pending plan on a runner that cannot dispatch is deferred, not failed or dispatched', async () => {
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  const res = await DF.applyCardFixPlans('BRO-9', io, { canDispatch: false });
  assert.equal(res.kind, 'deferred');
  assert.match(res.why, /cannot dispatch/);
  assert.equal(calls.length, 0);
  // The kill switch still wins: that is a failure, as before.
  assert.equal((await DF.applyCardFixPlans('BRO-9', io, { dispatch: false, canDispatch: false })).kind, 'failed');
});

// Item 2: a finished plan from an earlier attempt must not block the card.
test('applyCardFixPlans: a partial plan the latest landing did not touch is skipped, one it touched still fails', async () => {
  const stale = { ...plan(['data-edit']), status: 'partial', executedIn: 'ci' };
  const files = { 'bro-5.json': stale, 'bro-5-b.json': plan(['data-edit']) };
  const ok = { code: 0, plan: { status: 'applied', executedIn: 'ci' } };
  const a = fake(files, ok, { landing: 'data/pending-fixes/bro-5-b.json\n' });
  const res = await DF.applyCardFixPlans('BRO-5', a.io);
  assert.equal(res.kind, 'applied');
  assert.deepEqual(res.files, ['bro-5-b.json']);
  assert.ok(res.lines.some((l) => /bro-5\.json: skipped.*earlier attempt/.test(l)));
  assert.equal(a.calls.filter((c) => c[0] === 'execute-approved-fix.yml').length, 1);
  const b = fake(files, ok, { landing: 'data/pending-fixes/bro-5.json\ndata/pending-fixes/bro-5-b.json\n' });
  const bad = await DF.applyCardFixPlans('BRO-5', b.io);
  assert.equal(bad.kind, 'failed');
  assert.match(bad.why, /bro-5\.json on main is not applied.*partial/);
  // Landing unreadable: every plan is judged, as before.
  const c = fake(files, ok);
  assert.equal((await DF.applyCardFixPlans('BRO-5', c.io)).kind, 'failed');
});

test('applyCardFixPlans: only stale plans left -> none', async () => {
  const stale = { ...plan(['data-edit']), status: 'rejected', executedIn: 'ci' };
  const { io } = fake({ 'bro-6.json': stale, 'bro-6-b.json': stale }, { code: 0, plan: {} }, { landing: 'data/pending-fixes/other.json\n' });
  assert.equal((await DF.applyCardFixPlans('BRO-6', io)).kind, 'none');
});

// Item 4: the wait covers the executor's own timeout; a verdict comes from main, not from the wait.
test('apply wait outlasts the executor workflow timeout', async () => {
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/execute-approved-fix.yml', import.meta.url), 'utf8');
  assert.equal(Number(/timeout-minutes:\s*(\d+)/.exec(wf)[1]), DF.EXECUTOR_TIMEOUT_MIN);
  assert.ok(DF.APPLY_WAIT_MIN > DF.EXECUTOR_TIMEOUT_MIN);
  const { io, calls } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 0, plan: { status: 'applied', executedIn: 'ci' } });
  await DF.applyCardFixPlans('BRO-9', io);
  assert.ok(calls[0].includes(`--timeout=${DF.APPLY_WAIT_MIN}`));
});

test('applyCardFixPlans: a timed-out wait on a plan the executor did apply counts as applied', async () => {
  const { io } = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 2, plan: { status: 'applied', executedIn: 'ci' }, out: 'Still running after 55 min' });
  const res = await DF.applyCardFixPlans('BRO-9', io);
  assert.equal(res.kind, 'applied');
  assert.ok(res.lines.some((l) => /reported exit 2, but main shows/.test(l)));
});

test('applyCardFixPlans: exit 2 with the plan still pending is deferred; exit 1 is a failure', async () => {
  const two = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 2, plan: {}, out: 'Still running after 55 min' });
  const d = await DF.applyCardFixPlans('BRO-9', two.io);
  assert.equal(d.kind, 'deferred');
  assert.match(d.why, /unknown/);
  const one = fake({ 'bro-9.json': plan(['data-edit']) }, { code: 1, plan: {}, out: 'Conclusion: failure' });
  assert.equal((await DF.applyCardFixPlans('BRO-9', one.io)).kind, 'failed');
});

// Item 3: the workflow records "applied" only after every private push landed.
test('execute-approved-fix.yml: core data is pushed before the status commit, which is gated on all three pushes', async () => {
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/execute-approved-fix.yml', import.meta.url), 'utf8');
  const at = (needle) => { const i = wf.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const core = at('id: push_core'), gate = at('id: push_gate'), commit = at('- name: Commit and push changes');
  assert.ok(at('id: push_review_texts') < gate && at('id: push_aggregator') < gate && core < gate && gate < commit);
  const commitIf = /- name: Commit and push changes\n\s+if: ([^\n]+)/.exec(wf)[1];
  assert.match(commitIf, /steps\.push_gate\.outputs\.ok != 'false'/);
  for (const k of ['PUSH_REVIEW_TEXTS', 'PUSH_AGGREGATOR', 'PUSH_CORE']) assert.match(wf, new RegExp(`${k}: \\$\\{\\{ steps\\.push_\\w+\\.outcome \\}\\}`));
  assert.match(wf, /\.skip-push-core-data/);
  assert.match(wf, /Fail when private pushes did not land/);
  assert.match(wf, /FIX_RESULT: \$\{\{ steps\.push_gate\.outputs\.ok == 'false' && 'push-failed'/);
});

test('reconcileSkips: slot 0 takes everything it can; the GHA base slot takes only deferred applies', () => {
  const k = (deferred, onlyDeferred, canDispatch) => DF.reconcileSkips({ deferred, onlyDeferred, canDispatch });
  // Slot 0 (full reconcile): never skips a plain card; skips a deferred one only when it cannot dispatch.
  assert.equal(k(false, false, false), false);
  assert.equal(k(false, false, true), false);
  assert.equal(k(true, false, false), true);
  assert.equal(k(true, false, true), false);
  // GHA base slot (deferred-only): skips plain cards; takes a deferred one when it can dispatch.
  assert.equal(k(false, true, true), true);
  assert.equal(k(true, true, true), false);
  assert.equal(k(true, true, false), true);
});
