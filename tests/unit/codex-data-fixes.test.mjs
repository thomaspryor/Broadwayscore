// BRO-6175: the Codex lane does private-data fixes through the reviewed pending-fixes route.
// Requires the real functions (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('../../scripts/lib/codex-runner.js');
const DF = require('../../scripts/lib/codex-data-fixes.js');
const fit = (title, description = 'Fix it.') => r.codexCardFit({ title, description, verify: 'node --test tests/unit/x.test.mjs' });
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
function fake(files, outcome, { lastWriter = 'github-actions[bot]\tfix(data): Execute approved fix for #bro-9' } = {}) {
  const main = { ...files };
  const calls = [];
  const io = {
    log: () => {},
    git: (a) => {
      if (a[0] === 'fetch') return '';
      if (a[0] === 'ls-tree') return Object.keys(main).map((f) => `data/pending-fixes/${f}`).join('\n');
      if (a[0] === 'log') return lastWriter;
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
  assert.match(src, /DF\.dataFixesEnabled\(\) \? DATA_FIX_RULE : ''/);
  assert.match(readFileSync(new URL('../../scripts/codex/runner-prompt.md', import.meta.url), 'utf8'), /\{\{DATA_FIX_RULE\}\}/);
  assert.match(readFileSync(new URL('../../.github/workflows/codex-runner.yml', import.meta.url), 'utf8'), /^permissions:\n  contents: read\n(?:  #.*\n)*  actions: write$/m);
});
