import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseTranscript, renderState, statePath, MAX_CHARS } = require('./compact-state.js');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'compact-state.js');

const line = (o) => JSON.stringify(o) + '\n';
const user = (content) => line({ type: 'user', message: { role: 'user', content } });
const assistant = (content) => line({ type: 'assistant', message: { role: 'assistant', content } });
const tool = (name, input) => ({ type: 'tool_use', id: 't', name, input });

function sampleTranscript() {
  return [
    user('Fix the BRO-4321 image bug on the show page'),
    user([{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }]),
    assistant([{ type: 'text', text: 'Looking.' }, tool('Bash', { command: 'grep -rn ShowImage src/ | head' })]),
    assistant([tool('Edit', { file_path: 'src/components/ShowImage.tsx', old_string: 'a', new_string: 'b' })]),
    assistant([tool('Write', { file_path: 'scripts/lib/new-helper.js', content: 'x' })]),
    assistant([tool('Edit', { file_path: 'src/components/ShowImage.tsx', old_string: 'b', new_string: 'c' })]),
    assistant([{ type: 'text', text: 'Done.\nEXECUTED: npx tsc --noEmit — 0 errors\nVERIFY: node scripts/x.js' }]),
    line({ type: 'assistant', isSidechain: true, message: { content: [tool('Edit', { file_path: 'SIDECHAIN.md' })] } }), // subagent transcripts flag every line; kept
    user('now also check the London rows'),
    user('Another Claude session sent a message:\n<agent-message from="abc">[Subagent hand-back] report text</agent-message>'),
    user('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event'),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x\n\nMost plans have serious gaps. ## Instructions ' + 'skill body '.repeat(40) } }),
    line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } }),
    assistant([{ type: 'text', text: '- **EXECUTED:** node scripts/y.js — ok' }]),
    'not json at all\n',
  ].join('');
}

test('parseTranscript keeps the owner prompts, edits, commands, evidence and cards; drops injected blocks; keeps sidechain lines (subagent transcripts)', () => {
  const f = parseTranscript(sampleTranscript());
  assert.deepEqual(f.prompts, ['Fix the BRO-4321 image bug on the show page', 'now also check the London rows']);
  assert.deepEqual(f.edits, ['src/components/ShowImage.tsx', 'scripts/lib/new-helper.js', 'src/components/ShowImage.tsx', 'SIDECHAIN.md']);
  assert.deepEqual(f.bash, ['grep -rn ShowImage src/ | head']);
  assert.deepEqual(f.evidence, ['EXECUTED: npx tsc --noEmit — 0 errors', 'VERIFY: node scripts/x.js', '- **EXECUTED:** node scripts/y.js — ok']);
  assert.deepEqual(f.cards, ['BRO-4321']);
});

test('a long genuine ask (a pasted brief) is kept and truncated, not dropped; isMeta turns are skipped even without a marker', () => {
  const brief = 'Please audit every London venue row and ' + 'detail '.repeat(500);
  const f = parseTranscript(user(brief) + line({ type: 'user', isMeta: true, message: { content: 'short injected text with no marker' } }));
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].startsWith('Please audit every London venue row'));
  const md = renderState(f, null);
  assert.match(md, /Please audit every London venue row/);
});

test('after many turns the first ask is labelled as possibly superseded', () => {
  const f = parseTranscript(['first ask', 'second', 'third', 'fourth', 'latest ask'].map(user).join(''));
  const md = renderState(f, null);
  assert.match(md, /original ask, may be superseded: first ask/);
  assert.match(md, /- latest ask/);
  assert.doesNotMatch(md, /- second/);
});

test('renderState is markdown, de-duplicates edits, and stays under MAX_CHARS even for a huge transcript', () => {
  const f = parseTranscript(sampleTranscript());
  const md = renderState(f, { branch: 'claude/x', status: ['M src/a.ts'], lastCommit: 'abc123 msg' });
  assert.match(md, /^# Compaction checkpoint/);
  assert.match(md, /BRO-4321/);
  assert.match(md, /branch: claude\/x/);
  assert.equal((md.match(/src\/components\/ShowImage\.tsx/g) || []).length, 1, 'edits are unique');
  assert.match(md, /EXECUTED: npx tsc/);
  const big = parseTranscript(Array.from({ length: 3000 }, (_, i) => assistant([tool('Edit', { file_path: `file-${i}.ts` })]) + user('x'.repeat(2000))).join(''));
  assert.ok(renderState(big, null).length <= MAX_CHARS);
});

test('CLI auto mode: PreCompact writes the checkpoint, SessionStart(compact) restores it as additionalContext, other events are no-ops', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-state-test-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, sampleTranscript());
  const sid = `test-${process.pid}-${Date.now()}`;
  const run = (input) => execFileSync('node', [CLI, 'auto'], { input: JSON.stringify(input), encoding: 'utf8' });

  assert.equal(run({ hook_event_name: 'SessionStart', source: 'startup', session_id: sid }), '', 'startup prints nothing');
  assert.equal(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid }), '', 'nothing to restore yet');
  assert.equal(run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sid, transcript_path: transcript, cwd: dir }), '');
  assert.ok(fs.existsSync(statePath(sid, transcript)), 'checkpoint file written, keyed by session + transcript');

  const out = JSON.parse(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid, transcript_path: transcript }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /BRO-4321/);
  assert.match(out.hookSpecificOutput.additionalContext, /ShowImage\.tsx/);
  assert.match(out.hookSpecificOutput.additionalContext, /It is not proof/);
  assert.ok(!fs.existsSync(statePath(sid, transcript)), 'restore consumes the checkpoint');
  assert.equal(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid, transcript_path: transcript }), '', 'a second restore finds nothing (no stale re-injection)');

  // A subagent sharing the parent's session_id gets its own file (keyed by transcript basename).
  const subDir = path.join(dir, 'subagents'); fs.mkdirSync(subDir);
  const subT = path.join(subDir, 'agent-abc123.jsonl'); fs.writeFileSync(subT, user('subagent task: sweep the logs'));
  run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sid, transcript_path: subT, cwd: dir });
  run({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sid, transcript_path: transcript, cwd: dir });
  assert.notEqual(statePath(sid, subT), statePath(sid, transcript));
  const subOut = JSON.parse(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid, transcript_path: subT }));
  assert.match(subOut.hookSpecificOutput.additionalContext, /sweep the logs/);
  assert.doesNotMatch(subOut.hookSpecificOutput.additionalContext, /BRO-4321/);
  // Restore without a transcript_path falls back to the session-level file.
  const mainOut = JSON.parse(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid }));
  assert.match(mainOut.hookSpecificOutput.additionalContext, /BRO-4321/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderState truncates on a line boundary and keeps the ask and status lines ahead of commands', () => {
  const f = parseTranscript(Array.from({ length: 400 }, (_, i) => assistant([tool('Bash', { command: `cmd-${i} ` + 'x'.repeat(150) })])).join('') + user('the ask') + assistant([{ type: 'text', text: 'EXECUTED: node x.js — ok' }]));
  f.edits = Array.from({ length: 40 }, (_, i) => `very/long/path/number/${i}/${'y'.repeat(120)}.ts`);
  const md = renderState(f, null);
  assert.ok(md.length <= MAX_CHARS);
  assert.match(md, /the ask/);
  assert.match(md, /EXECUTED: node x\.js/);
  assert.ok(md.endsWith('\n…(truncated)'));
  const lastKept = md.slice(0, -'\n…(truncated)'.length).split('\n').pop();
  assert.ok(lastKept.startsWith('- ') || lastKept.startsWith('#') || lastKept === '', `cut on a line boundary, got: ${lastKept.slice(0, 40)}`);
});

test('CLI never fails on garbage input', () => {
  const out = execFileSync('node', [CLI, 'auto'], { input: 'not json', encoding: 'utf8' });
  assert.equal(out, '');
});
