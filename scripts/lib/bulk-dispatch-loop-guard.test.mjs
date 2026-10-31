// BRO-6536: advisory hook that warns when a session loops bare dispatches of a
// capped bulk workflow. Unit tests of the classifier plus the real hook script
// driven over stdin (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classify, report } = require('./bulk-dispatch-loop-guard.js');
const { CAPS, WORKFLOW_DISPLAY_NAMES } = require('./workflow-queue-cap.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, '.claude', 'hooks', 'bulk-dispatch-loop-guard.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-6536-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function hook(command, extraEnv = {}) {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.jsonl`);
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'sess-1' }),
    env: { PATH: process.env.PATH, HOME: tmp, BULK_DISPATCH_GUARD_LEDGER: ledger, ...extraEnv },
    encoding: 'utf8',
  });
  const rows = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout, rows, ledger };
}

const LOOP = 'for s in a b c; do gh workflow run ingest-urls.yml -f show_id=$s; done';

// ── acceptance criteria (hook end to end) ───────────────────────────────────
test('loop of bare dispatches warns, exits 0 and writes a ledger row', () => {
  const r = hook(LOOP);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /capped-workflow-dispatch\.js --workflow=ingest-urls\.yml -f k=v --wait-min=5 \|\| break/);
  assert.ok(out.systemMessage);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'advisory: never decides permission');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].workflows, ['ingest-urls.yml']);
  assert.equal(r.rows[0].session, 'sess-1');
});
test('loop through capped-workflow-dispatch.js is silent', () => {
  const r = hook('for s in a b c; do node scripts/capped-workflow-dispatch.js --workflow=ingest-urls.yml -f show_id=$s --wait-min=5 || break; done');
  assert.equal(r.out, '');
  assert.equal(r.rows.length, 0);
});
test('single non-loop dispatch is silent', () => {
  assert.equal(hook('gh workflow run ingest-urls.yml -f show_id=x').out, '');
});
test('land.yml loop is silent', () => {
  assert.equal(hook('for i in 1 2; do gh workflow run land.yml --ref land/x; done').out, '');
});
test('kill switch (env or file) silences it', () => {
  const r = hook(LOOP, { BULK_DISPATCH_GUARD_OFF: '1' });
  assert.equal(r.out, '');
  assert.equal(r.rows.length, 0);
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'BULK_DISPATCH_GUARD_OFF'), '');
  assert.equal(hook(LOOP, { HOME: home }).out, '');
});
test('non-Bash tools and unrelated commands are silent', () => {
  assert.equal(hook('ls -la').out, '');
  const r = spawnSyncStdinFile('bash', [HOOK], { input: JSON.stringify({ tool_name: 'Edit', tool_input: { command: LOOP } }), env: { PATH: process.env.PATH, HOME: tmp }, encoding: 'utf8' });
  assert.equal(r.stdout, '');
});

// ── classifier ─────────────────────────────────────────────────────────────
const warns = (c) => classify(c).warn;
test('loop shapes that warn', () => {
  for (const c of [
    'for s in a b; do gh workflow run "LLM Ensemble Score Reviews" -f show_id=$s; done',
    'while read s; do gh workflow run gather-reviews.yml -f shows=$s; done < list.txt',
    'cat ids | xargs -I {} gh workflow run ingest-urls.yml -f show_id={}',
    'cat ids | xargs -n1 -P4 timeout 30 gh workflow run llm-ensemble-score.yml -f show_id',
    'seq 3 | parallel -j 2 gh workflow run ingest-urls.yml -f show_id={}',
    'for s in a b; do gh api -X POST repos/thomaspryor/Broadwayscore/actions/workflows/ingest-urls.yml/dispatches -f ref=main; done',
    'for s in a b; do node scripts/cloud-dispatch.js ingest-urls.yml -f show_id=$s --wait; done',
    'for wf in ingest-urls.yml gather-reviews.yml; do gh workflow run "$wf"; done',
    'for s in a b; do\n  gh workflow run ingest-urls.yml -f show_id=$s\n  sleep 2\ndone',
    `bash -c '${LOOP}'`,
    `bash -lc '${LOOP}'`,
    'gh workflow run ingest-urls.yml -f show_id=a & gh workflow run ingest-urls.yml -f show_id=b &',
    'for s in a b; do (gh workflow run ingest-urls.yml -f show_id=$s); done',
    'for s in a b; do sudo /usr/local/bin/gh workflow  run ingest-urls.yml -f show_id=$s; done',
    'for s in a b; do env -u GH_TOKEN gh workflow run ingest-urls.yml -f show_id=$s; done',
    'for s in a b; do node scripts/cloud-dispatch.js ingest-urls -f show_id=$s; done',
    'WF=gather-reviews.yml; for s in a b; do gh workflow run "$WF" -f shows=$s; done',
    'for s in a b; do gh workflow run ingest-urls.yml -f "urls=x;y" -f show_id=$s; done',
  ]) assert.ok(warns(c), c);
});
test('two chained bare dispatches warn without a loop', () => {
  assert.ok(warns('gh workflow run ingest-urls.yml -f show_id=a && gh workflow run ingest-urls.yml -f show_id=b'));
});
test('silent shapes', () => {
  for (const c of [
    'for f in a.js b.js; do grep -n "gh workflow run ingest-urls.yml" $f; done',
    'grep "gh workflow run ingest-urls.yml" a.js; grep "gh workflow run ingest-urls.yml" b.js',
    `git commit -m "fix: stop running ${LOOP}"`,
    `cat > notes.md <<'EOF'\n${LOOP}\nEOF`,
    'for s in a b; do gh workflow run test.yml; done',
    'for s in a b; do gh run list --workflow=ingest-urls.yml; done',
    'for s in a b; do gh api repos/x/y/actions/workflows/ingest-urls.yml/runs; done',
    'node scripts/capped-workflow-dispatch.js --workflow=ingest-urls.yml -f show_id=a --dry-run',
    // A loop that does not dispatch, then one dispatch, is a single dispatch.
    'for s in a b; do echo "$s"; done; gh workflow run ingest-urls.yml',
    'echo waiting for it; gh workflow run ingest-urls.yml -f urls=to do',
    // Only the dispatch operand names the workflow.
    'for s in a b; do gh workflow run test.yml -f test_type=ingest-urls.yml; done',
    'for wf in deploy.yml; do gh workflow run "$wf"; done; cat ingest-urls.yml',
    'for s in a b; do gh workflow run "ingest review urls backfill"; done',
    'for s in a b; do gh workflow run ingest-urls.yml.bak; done',
    'gh workflow run ingest-urls.yml -f show_id=a 2>&1 | tail -3',
    // A loop quoted as an argument is data (a hook payload, an echo), not a command.
    `echo "${LOOP}"`,
    `printf '%s' '{"tool_input":{"command":"for s in a b; do gh workflow run \\"Gather Review Data\\" -f shows=$s; done"}}' | bash .claude/hooks/x.sh`,
  ]) assert.ok(!warns(c), c);
});
test('a capped CLI call does not excuse a bare loop elsewhere in the command', () => {
  assert.ok(warns(`node scripts/capped-workflow-dispatch.js --workflow=ingest-urls.yml --dry-run; ${LOOP}`));
});
test('every capped workflow and display name is matched', () => {
  for (const wf of Object.keys(CAPS)) assert.deepEqual(classify(`for s in a; do gh workflow run ${wf}; done`).workflows, [wf]);
  for (const [name, wf] of Object.entries(WORKFLOW_DISPLAY_NAMES)) assert.deepEqual(classify(`for s in a; do gh workflow run "${name}"; done`).workflows, [wf]);
});
test('display names match each workflow file name: line (no drift)', () => {
  for (const [name, wf] of Object.entries(WORKFLOW_DISPLAY_NAMES)) {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8');
    assert.equal(yml.match(/^name:\s*["']?(.+?)["']?\s*$/m)[1], name, wf);
  }
  assert.deepEqual(new Set(Object.values(WORKFLOW_DISPLAY_NAMES)), new Set(Object.keys(CAPS)), 'one display name per capped workflow');
});
test('--report counts ledger hits', () => {
  const r = hook(LOOP);
  hook(LOOP); // separate ledger; report reads the first one only
  const rep = report({ BULK_DISPATCH_GUARD_LEDGER: r.ledger });
  assert.equal(rep.hits, 1);
  assert.equal(rep.sessions, 1);
  assert.deepEqual(rep.byWorkflow, { 'ingest-urls.yml': 1 });
});
