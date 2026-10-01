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
    line({ type: 'assistant', isSidechain: true, message: { content: [tool('Edit', { file_path: 'SIDECHAIN.md' })] } }),
    user('now also check the London rows'),
    user('Another Claude session sent a message:\n<agent-message from="abc">[Subagent hand-back] report text</agent-message>'),
    user('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event'),
    user('Most plans have serious gaps. ## Instructions ' + 'skill body '.repeat(400)),
    'not json at all\n',
  ].join('');
}

test('parseTranscript keeps the owner prompts, edits, commands, evidence and cards; drops system blocks and sidechains', () => {
  const f = parseTranscript(sampleTranscript());
  assert.deepEqual(f.prompts, ['Fix the BRO-4321 image bug on the show page', 'now also check the London rows']);
  assert.deepEqual(f.edits, ['src/components/ShowImage.tsx', 'scripts/lib/new-helper.js', 'src/components/ShowImage.tsx']);
  assert.deepEqual(f.bash, ['grep -rn ShowImage src/ | head']);
  assert.deepEqual(f.evidence, ['EXECUTED: npx tsc --noEmit — 0 errors', 'VERIFY: node scripts/x.js']);
  assert.deepEqual(f.cards, ['BRO-4321']);
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
  assert.ok(fs.existsSync(statePath(sid)), 'checkpoint file written');

  const out = JSON.parse(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: sid }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /BRO-4321/);
  assert.match(out.hookSpecificOutput.additionalContext, /ShowImage\.tsx/);
  fs.rmSync(statePath(sid), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI never fails on garbage input', () => {
  const out = execFileSync('node', [CLI, 'auto'], { input: 'not json', encoding: 'utf8' });
  assert.equal(out, '');
});
