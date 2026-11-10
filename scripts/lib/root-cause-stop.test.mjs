// BRO-7294: root-cause-stop.mjs, the rule-21 check at the SAFE TO ARCHIVE claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopHookDecision, cardTitles, hasRootCauseAnswer, answerTexts, blockBudget, main } from './root-cause-stop.mjs';
import { landedPushIndices } from './review-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };
const use = (id, name, input) => ({ kind: 'assistant_tool_use', id, name, input });
const ok = (id, content = 'ok', isError = false) => ({ kind: 'tool_result', tool_use_id: id, content, isError });
const say = (text) => ({ kind: 'assistant_text', text });
const LAND = [use('p1', 'Bash', { command: 'git push origin HEAD:refs/heads/land/bro-1-fix 2>&1 | tail -3' }), ok('p1')];
const FIX_CARD = [use('c1', 'Bash', { command: 'node scripts/linear-brain.js create "Fix wrong venue on 6 shows" --self --notes "x"' }), ok('c1')];
const FEATURE_CARD = [use('c2', 'Bash', { command: 'node scripts/linear-brain.js create "Add a tour map page" --self' }), ok('c2')];
const SAFE = 'Fixed the six rows.\n\nSAFE TO ARCHIVE — all landed and verified.';
const d = (events, lastMessage = SAFE, env = CLOUD) => stopHookDecision({ events, lastMessage, env }).decision;

test('blocks a landed fix that claims SAFE TO ARCHIVE with no rule-21 answer (the incident)', () => {
  assert.equal(d([...FIX_CARD, ...LAND]), 'block');
  assert.equal(d([...LAND]), 'block', 'unknown card title is still checked');
});

test('passes with CLASS-GUARD, PREVENTION or NO-ROOT-CAUSE in chat', () => {
  assert.equal(d([...FIX_CARD, ...LAND], 'Done.\nCLASS-GUARD: scripts/lib/venue-guard.test.mjs\n\nSAFE TO ARCHIVE — x'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND, say('**PREVENTION:** scripts/lib/x.test.mjs ; cousins: grep of data/')]), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-ROOT-CAUSE: one-off typo in a hand-entered row\nSAFE TO ARCHIVE — x'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-PREVENTION: docs-only change to CLOUD.md\nSAFE TO ARCHIVE — x'), 'allow');
});

test('passes when the answer is in the Linear Outcome comment, not the chat', () => {
  const viaCli = use('l1', 'Bash', { command: "node scripts/linear-brain.js update BRO-1 --state Done --comment \"$(cat <<'EOF'\nOutcome.\nROOT-CAUSE: importer trusted URL slugs\nCLASS-GUARD: scripts/lib/import-guard.test.mjs\nEOF\n)\"" });
  assert.equal(d([...FIX_CARD, ...LAND, viaCli, ok('l1')]), 'allow');
  const inline = use('l4', 'Bash', { command: 'node scripts/linear-brain.js update BRO-1 --comment "CLASS-GUARD: scripts/lib/inline.test.mjs" --state Done' });
  assert.equal(d([...FIX_CARD, ...LAND, inline, ok('l4')]), 'allow', 'an inline single-line --comment counts');
  const report = use('l5', 'Bash', { command: "node scripts/linear-session.js report --status=done --summary='NO-ROOT-CAUSE: one manual row typo fixed'" });
  assert.equal(d([...FIX_CARD, ...LAND, report, ok('l5')]), 'allow');
  const viaMcp = use('l2', 'mcp__Linear__save_comment', { issueId: 'BRO-1', body: 'Outcome\n- CLASS-GUARD: scripts/lib/a.test.mjs' });
  assert.equal(d([...FIX_CARD, ...LAND, viaMcp, ok('l2')]), 'allow');
  const viaUuid = use('l3', 'mcp__0a1b2c3d-1111-2222-3333-444455556666__save_comment', { body: 'NO-ROOT-CAUSE: single bad row from a manual edit' });
  assert.equal(d([...FIX_CARD, ...LAND, viaUuid, ok('l3')]), 'allow');
});

test('too-short or empty answers do not count', () => {
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-ROOT-CAUSE: n/a\nSAFE TO ARCHIVE — x'), 'block');
  assert.equal(d([...FIX_CARD, ...LAND], 'CLASS-GUARD:\nSAFE TO ARCHIVE — x'), 'block');
  assert.equal(d([...FIX_CARD, ...LAND, say('ROOT-CAUSE: the importer trusted slugs')]), 'block', 'a cause with no guard is the spot-patch failure');
});

test('stays quiet when nothing landed, on feature cards, off cloud, with the kill switch, or without the claim', () => {
  assert.equal(d([...FIX_CARD]), 'allow');
  assert.equal(d([...FEATURE_CARD, ...LAND]), 'allow');
  assert.equal(d([...FEATURE_CARD, ...FIX_CARD, ...LAND]), 'block', 'any fix card in the session is checked');
  const parked = use('c3', 'Bash', { command: 'node scripts/linear-brain.js create "Search broken on mobile" --park "found in passing"' });
  assert.equal(d([...FEATURE_CARD, parked, ok('c3'), ...LAND]), 'allow', 'a bug filed for someone else does not make a feature session a fix');
  assert.equal(d([...FIX_CARD, ...LAND], SAFE, {}), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], SAFE, { ...CLOUD, ROOT_CAUSE_STOP_DISABLE: '1' }), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'Waiting on CI.\n\nKEEP OPEN — land run in progress'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'SAFE TO ARCHIVE is what I will say later.\n\nKEEP OPEN — x'), 'allow');
  assert.equal(d(null), 'allow');
});

test('only real landings count: refused, dry-run and delete pushes do not; MCP landings do', () => {
  const ev = (cmd, isError = false) => [use('x', 'Bash', { command: cmd }), ok('x', 'r', isError)];
  assert.deepEqual(landedPushIndices(ev('git push origin HEAD:land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('git -C /w push origin HEAD:refs/heads/land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('git push origin HEAD:refs/heads/land/x', true)), [], 'a hook-refused push');
  assert.deepEqual(landedPushIndices(ev('git push --dry-run origin HEAD:land/x')), []);
  assert.deepEqual(landedPushIndices(ev('git push origin --delete land/x')), []);
  assert.deepEqual(landedPushIndices(ev('git push origin claude/foo')), []);
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__create_branch', { branch: 'land/y' }), ok('m')]), [0]);
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__actions_run_trigger', { workflow_id: 'land.yml' }), ok('m')]), [0]);
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__create_branch', { branch: 'claude/y' }), ok('m')]), []);
  assert.deepEqual(landedPushIndices([use('x', 'Bash', { command: 'git push origin HEAD:refs/heads/land/x 2>&1 | tail -5' }), ok('x', ' ! [rejected]        HEAD -> land/x (fetch first)\nerror: failed to push some refs')]), [], 'a piped push git refused');
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__actions_run_trigger', { workflow_id: 'land-ref-prune.yml' }), ok('m')]), [], 'land-* helper workflows are not landings');
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__actions_run_trigger', { workflow_id: 'visual-approval-land.yml' }), ok('m')]), []);
  assert.deepEqual(landedPushIndices(ev('gh workflow run land.yml -f ref=land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('node scripts/cloud-dispatch.js land.yml --ref main')), [0]);
  assert.deepEqual(landedPushIndices([use('m', 'mcp__github__push_files', { branch: 'land/z', files: [] }), ok('m')]), [0]);
});

test('helpers: titles from CLI and connector creates; answer texts include Linear writes', () => {
  assert.deepEqual(cardTitles([...FIX_CARD, use('s', 'mcp__Linear__save_issue', { title: 'Fix X', team: 'BRO' }), use('u', 'mcp__Linear__save_issue', { id: 'BRO-2', title: 'edit' })]), ['Fix wrong venue on 6 shows', 'Fix X']);
  assert.equal(answerTexts([use('b', 'Bash', { command: 'ls' })], 'm').length, 1);
  assert.equal(hasRootCauseAnswer(['PREVENTION: scripts/lib/q.test.mjs']), true);
  assert.equal(blockBudget(new Date('2026-11-10T00:00:00Z')), 1);
  assert.equal(blockBudget(new Date('2026-12-22T00:00:00Z')), 2);
});

test('main(): blocks within its budget, then lets go', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const tp = path.join(dir, 't.jsonl');
  const row = (type, content) => JSON.stringify({ type, message: { content } }) + '\n';
  fs.writeFileSync(tp, row('assistant', [{ type: 'tool_use', name: 'Bash', id: 'p', input: { command: 'git push origin HEAD:refs/heads/land/z' } }]) + row('user', [{ type: 'tool_result', tool_use_id: 'p', content: 'ok' }]));
  const run = (now) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/root-cause-stop.mjs'), '--stop-hook'], {
    input: JSON.stringify({ transcript_path: tp, session_id: 't', last_assistant_message: SAFE }),
    encoding: 'utf8', env: { ...process.env, ...CLOUD, ROOT_CAUSE_STOP_DISABLE: '' },
  });
  const a = run();
  assert.equal(a.status, 2);
  assert.match(a.stderr, /BRO-7294/);
  assert.equal(run().status, 0, 'one reminder before the arming date, then it lets go');
  assert.equal(main(['--other']), 0);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('root-cause-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});

test('verify-edits.sh keeps the root-cause-stop call (a Mac-master sync must not silently drop it)', () => {
  const src = fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(src, /root-cause-stop\.mjs" --stop-hook/);
  assert.match(src, /ROOT_CAUSE_STOP_DISABLE/);
});
