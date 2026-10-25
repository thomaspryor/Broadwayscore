// BRO-6088: advisory hook flagging create_session from a plan-only session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { execFileSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const lib = require('../../scripts/lib/plan-only-create-session.js');
const { startReminder: realReminder } = require('../../scripts/coordinator-check.js');
const reg = require('../../scripts/lib/coordinator-registry.js');

const PLAN = { ok: true, identifier: 'BRO-100', url: 'u', title: 'Plan only: redesign X', description: '', comments: [] };
const NORMAL = { ok: true, identifier: 'BRO-101', url: 'u', title: 'Fix the thing', description: 'Context: a planning session told to write a plan only started code sessions.', comments: [] };
const SELF = { ok: true, identifier: 'BRO-6088', url: 'u', title: 'Flag create_session from a plan-only session (BRO-6083 follow-up)', description: 'BRO-6083 bullet 4.\n* A hook flags calls from sessions whose card contains "plan-only", "plan only", or "do not implement".', comments: [] };

const CS = 'mcp__claude-code-remote__create_session';
// real startReminder, Linear injected (never the live API)
const startReminder = (text, o) => realReminder(text, { ...o, fetchCard: async () => ({ ok: true, url: 'u', comments: [] }) });
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-only-')); }
const cards = (map) => async (c) => map[c] || { ok: false, error: `${c} not found` };

test('planOnlyMarker: structural matches only', () => {
  assert.equal(lib.planOnlyMarker({ title: 'Plan only: x' }), 'title');
  assert.equal(lib.planOnlyMarker({ title: '[plan-only] x' }), 'title');
  assert.equal(lib.planOnlyMarker({ title: 'x', description: 'Intro\n**Do not implement** until the owner agrees' }), 'description');
  assert.equal(lib.planOnlyMarker({ title: 'x', description: '- Plan-only session.' }), 'description');
  assert.equal(lib.planOnlyMarker(NORMAL), null);
  for (const d of ['- Do not implement a new scraper; reuse fetchPage()', '## Plan only applies to phase 2', '> plan only when the owner asks']) assert.equal(lib.planOnlyMarker({ title: 'x', description: d }), null, d);
  assert.equal(lib.planOnlyMarker({ title: '[P1] Plan only: x' }), 'title');
  assert.equal(lib.planOnlyMarker({ title: 'P1: BRO-6083 follow-up: plan only' }), null);
  assert.equal(lib.planOnlyMarker({ title: 'Plan-only? no, implement' }), null);
  assert.equal(lib.planOnlyMarker({ title: 'x', description: '1. Plan only: write the doc' }), 'description');
  assert.equal(lib.planOnlyMarker(SELF), null, "BRO-6088's own text must not trip it");
});

test('flags create_session from a plan-only card named in the branch', async () => {
  const r = await lib.evaluate({ session_id: 's1', tool_name: CS, tool_input: { prompt: 'do it' } }, { fetchCard: cards({ 'BRO-100': PLAN }), branch: 'job/linear-BRO-100-abc', tmpDir: tmp(), env: {} });
  assert.match(r.additionalContext, /PLAN-ONLY CARD: BRO-100/);
  assert.match(r.additionalContext, /Plan only: redesign X/);
  const out = lib.toHookOutput(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'advisory: never decides');
});

test('card from the claim sentinel (UUID) and from the first prompt in the transcript', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'linear-issue-claimed-s2'), '818c81a0-0690-4bac-b126-a3b203fc9c1b\n');
  const r1 = await lib.evaluate({ session_id: 's2', tool_name: CS, tool_input: {} }, { fetchCard: cards({ '818c81a0-0690-4bac-b126-a3b203fc9c1b': PLAN }), tmpDir: dir, env: {} });
  assert.match(r1.additionalContext, /BRO-100/);
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'queue-operation' }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[BRO-100] write the plan' }] } }) + '\n');
  const r2 = await lib.evaluate({ session_id: 'none', tool_name: CS, transcript_path: tp, tool_input: {} }, { fetchCard: cards({ 'BRO-100': PLAN }), tmpDir: dir, env: {} });
  assert.match(r2.additionalContext, /BRO-100/);
});

test('silent for normal cards, no cards, kill switch; skip notice when Linear unreadable', async () => {
  const deps = { fetchCard: cards({ 'BRO-101': NORMAL, 'BRO-6088': SELF }), tmpDir: tmp(), env: {} };
  assert.equal(await lib.evaluate({ tool_name: CS, tool_input: {} }, { ...deps, branch: 'job/linear-BRO-101-x' }), null);
  assert.equal(await lib.evaluate({ tool_name: CS, tool_input: {} }, { ...deps, branch: 'job/linear-BRO-6088-x' }), null);
  assert.equal(await lib.evaluate({ tool_name: CS, tool_input: {} }, { ...deps, branch: 'main' }), null);
  assert.equal(await lib.evaluate({ tool_name: CS, tool_input: {} }, { fetchCard: cards({ 'BRO-100': PLAN }), branch: 'BRO-100', tmpDir: tmp(), env: { PLAN_ONLY_CREATE_SESSION_DISABLE: '1' } }), null);
  const r = await lib.evaluate({ tool_name: CS, tool_input: {} }, { fetchCard: cards({}), branch: 'job/BRO-100', tmpDir: tmp(), env: {} });
  assert.match(r.systemMessage, /plan-only check skipped/);
  assert.equal(r.additionalContext, undefined);
});

test('includes the coordinator reminder when the spawned prompt names a coordinated area', async () => {
  const prompt = 'Fix the opening night lease in the express lane';
  const areas = reg.areasForText(prompt);
  assert.ok(areas.length, `prompt "${prompt}" resolves to a coordinated area`);
  const r = await lib.evaluate({ tool_name: CS, tool_input: { prompt } }, { fetchCard: cards({ 'BRO-100': PLAN, [areas[0].card]: { ok: true, url: 'u', comments: [] } }), startReminder, branch: 'BRO-100', tmpDir: tmp(), env: {} });
  assert.match(r.additionalContext, /COORDINATOR: /);
  const none = await lib.evaluate({ tool_name: CS, tool_input: { prompt: 'unrelated' } }, { fetchCard: cards({ 'BRO-100': PLAN }), startReminder, branch: 'BRO-100', tmpDir: tmp(), env: {} });
  assert.doesNotMatch(none.additionalContext, /COORDINATOR: /);
});

test('deadline: a hung fetch yields null instead of hanging', async () => {
  const r = await lib.evaluateWithDeadline({ tool_name: CS, tool_input: {} }, { fetchCard: () => new Promise(() => {}), branch: 'BRO-100', tmpDir: tmp(), env: {} }, 50);
  assert.equal(r, null);
});

test('block-prompting-remote-tools.sh runs the advisory only for an allowed create_session; settings gives it time', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const sh = (input, env = {}) => execFileSyncStdinFile('bash', [path.join(root, '.claude/hooks/block-prompting-remote-tools.sh')], { input: JSON.stringify(input), encoding: 'utf8', cwd: root, env: { ...process.env, ...env } });
  const ok = { session_id: 'zz', cwd: os.tmpdir(), tool_name: CS, tool_input: { model: 'claude-sonnet-5-5', source_url: 'https://github.com/thomaspryor/Broadwayscore', prompt: 'x\nBUDGET: 6h\nREPORT-BACK: yes' } };
  assert.equal(sh(ok), '', 'no card resolvable: silent');
  const denied = sh({ ...ok, tool_input: { ...ok.tool_input, model: '' } });
  assert.match(denied, /permissionDecision": "deny"/);
  assert.doesNotMatch(denied, /PLAN-ONLY/);
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  const block = settings.hooks.PreToolUse.find((b) => /create_session/.test(b.matcher));
  assert.ok(block.hooks.every((h) => (h.timeout || 0) >= 20), 'timeout covers fetch + reminder deadline');
});

test('hook entry script: garbage stdin prints nothing, exits 0', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  assert.equal(execFileSync('node', [path.join(root, 'scripts/plan-only-create-session-hook.js')], { input: 'not json', encoding: 'utf8' }), '');
});

test('hook entry script: --help prints usage and exits 0 without reading stdin or calling Linear', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = execFileSync('node', [path.join(root, 'scripts/plan-only-create-session-hook.js'), '--help'], { encoding: 'utf8', input: '' });
  assert.match(out, /Usage: plan-only-create-session-hook/);
});
