// BRO-8083: replay the REAL cloud Stop hook (CLAUDE_CODE_REMOTE=true bash .claude/hooks/verify-edits.sh) with no
// ~/.claude/hooks present (fake HOME) on fixture transcripts, per the BRO-8079 cloud requirements:
//  (a) Done on a data-count card with a unit-test-only VERIFY  -> the shared linear-brain Done gate refuses (not a stop hook)
//  (b) a turn ending SAFE TO ARCHIVE with a stranded create_session child -> hook blocks [VE:STRANDEDKID]
//  (c) a session over its NO-* bypass budget -> hook blocks [VE:BYPASSBUDGET]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CLAUDE_CODE_REMOTE', 'OPENAI_API_KEY'].includes(k)));
const KID = 'session_01Qf9FhcvFq7B4CnFGDoNvnn';
const use = (name, input, result = 'ok') => ({ name, input, result });

function transcript(dir, calls, texts = []) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please do the work' }] } })];
  for (const t of texts) lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }));
  for (const c of calls) {
    const id = `tu-${randomUUID()}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: c.name, input: c.input }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c.result }] } }));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function runHook(tp, last) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-home-')); // no ~/.claude/hooks
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'linear-brain.js'), 'process.exit(0);\n');
  try {
    const r = spawnSyncStdinFile('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: tp, session_id: `chr-${randomUUID()}`, stop_hook_active: false, last_assistant_message: last }),
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
      env: { ...HOST_ENV, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: root, VE_REPO_ROOT: REPO_ROOT, HOME: home, SKEPTIC_REVIEW_STOP_DISABLE: '1', SHIP_CHECK_COVERAGE_DISABLE: '1' },
    });
    return { status: r.status, stderr: r.stderr || '' };
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
}

const CREATE = use('mcp__claude-code-remote__create_session', { title: 'BRO-9: fix it', prompt: 'work it' }, `{"ccr":{"id":"${KID}"}}`);
const getKid = (b) => use('mcp__claude-code-remote__get_session', { session_id: KID }, `{"ccr":{"id":"${KID}","status_bucket":"SESSION_STATUS_BUCKET_${b}"}}`);
const SAFE = 'Everything landed.\n\nSAFE TO ARCHIVE';

test('(a) Done on a data-count card with a unit-test-only VERIFY is refused by the shared Done gate', () => {
  const { dataEffectCloseCheck } = require('../lib/linear-done-gate.js');
  const issue = { identifier: 'BRO-7930', title: 'Drain the 6,838 waiting _pending reviews: queue unmoved', description: '## Acceptance criteria\nVERIFY: node --test scripts/lib/x.test.mjs', comments: { nodes: [] } };
  const r = dataEffectCloseCheck({ identifier: issue.identifier, title: issue.title, description: issue.description, commentText: 'Done. unit tests pass.', existingComments: [], env: {} });
    assert.ok(r.some((x) => x.blocking), `expected a refusal, got ${JSON.stringify(r).slice(0, 300)}`);
});

test('(b) SAFE TO ARCHIVE with a stranded create_session child -> BLOCKED (never checked, FAILED, BLOCKED, IDLE)', () => {
  for (const calls of [[CREATE], [CREATE, getKid('FAILED')], [CREATE, getKid('BLOCKED')], [CREATE, getKid('IDLE')]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-b-'));
    const r = runHook(transcript(dir, calls), SAFE);
    assert.equal(r.status, 2, `expected block, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /VE:STRANDEDKID/);
  }
});

test('(b) no false positive: child WORKING/COMPLETED/archived, or no child, is not blocked by STRANDEDKID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-b2-'));
  const arch = use('mcp__claude-code-remote__archive_session', { session_id: KID }, '{}');
  for (const calls of [[CREATE, getKid('WORKING')], [CREATE, getKid('COMPLETED')], [CREATE, getKid('FAILED'), arch], []]) {
    const r = runHook(transcript(dir, calls), SAFE);
    assert.doesNotMatch(r.stderr, /VE:STRANDEDKID/, r.stderr.slice(0, 300));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(c) over the NO-* bypass budget -> BLOCKED; within budget and fenced/short lines do not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-c-'));
  const over = ['NO-VERIFY: docs only change here', 'NO-CARD: this is a tiny typo fix', 'NO-SHIP-CHECK: comment-only edit so far',
    'NO-WRAP-UP: nothing to wrap up here', 'NO-WHAT-ELSE: nothing adjacent found', 'NO-OWNER-STEPS: no owner steps at all'];
  let r = runHook(transcript(dir, [], over.slice(0, 5)), `${over[5]}\n\n${SAFE}`);
  assert.equal(r.status, 2, r.stderr.slice(0, 300));
  assert.match(r.stderr, /VE:BYPASSBUDGET/);
  r = runHook(transcript(dir, [], over.slice(0, 2)), `${over[2]}\n\n${SAFE}`);
  assert.doesNotMatch(r.stderr, /VE:BYPASSBUDGET/, 'three bypasses is within budget');
  r = runHook(transcript(dir, [], ['```\n' + over.join('\n') + '\n```', 'NO-VERIFY: short']), SAFE);
  assert.doesNotMatch(r.stderr, /VE:BYPASSBUDGET/, 'fenced and too-short lines are not counted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('(b) status is read from the get_session field, not any mention in the text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-b3-'));
  const tricky = use('mcp__claude-code-remote__get_session', { session_id: KID }, `{"ccr":{"id":"${KID}","title":"SESSION_STATUS_BUCKET_FAILED retry","status_bucket":"SESSION_STATUS_BUCKET_COMPLETED"}}`);
  const r = runHook(transcript(dir, [CREATE, tricky]), SAFE);
  assert.doesNotMatch(r.stderr, /VE:STRANDEDKID/, r.stderr.slice(0, 300));
  const initFail = use('mcp__claude-code-remote__get_session', { session_id: KID }, `{"ccr":{"id":"${KID}","status_bucket":"SESSION_STATUS_BUCKET_WORKING","external_metadata":{"last_init_error":"setup failed"}}}`);
  const r2 = runHook(transcript(fs.mkdtempSync(path.join(os.tmpdir(), 'chr-b4-')), [CREATE, initFail]), SAFE);
  assert.equal(r2.status, 2, r2.stderr.slice(0, 300));
  assert.match(r2.stderr, /VE:STRANDEDKID/);
});

test('(b)+(c) both server spellings are seen, and repeating one bypass reworded is not over budget', () => {
  const under = use('mcp__Claude_Code_Remote__create_session', { title: 'BRO-9: fix it' }, `{"ccr":{"id":"${KID}"}}`);
  const r = runHook(transcript(fs.mkdtempSync(path.join(os.tmpdir(), 'chr-s-')), [under]), SAFE);
  assert.equal(r.status, 2, r.stderr.slice(0, 300));
  assert.match(r.stderr, /VE:STRANDEDKID/);
  const texts = ['NO-VERIFY: docs only change one', 'NO-VERIFY: docs only change two', 'NO-VERIFY: docs only change three', 'NO-VERIFY: docs only change four'];
  const r2 = runHook(transcript(fs.mkdtempSync(path.join(os.tmpdir(), 'chr-s2-')), [], texts), SAFE);
  assert.doesNotMatch(r2.stderr, /VE:BYPASSBUDGET/);
});
