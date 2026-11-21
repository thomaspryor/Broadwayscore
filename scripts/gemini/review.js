#!/usr/bin/env node
/**
 * scripts/gemini/review.js: run Gemini as a repo-reading, read-only code reviewer (BRO-7987).
 *
 * Before this, /plan-review's Gemini leg was a bare generateContent curl with only the
 * plan text, so Gemini could not open a single file, and /ship-check had no Gemini leg.
 * The Gemini CLI can read the repository with its own file tools. This wrapper:
 *   1. makes the CLI available (cloud: installs the pinned @google/gemini-cli; Mac: uses
 *      an installed one and never installs), and needs GEMINI_API_KEY
 *   2. runs it headless in the current directory with `--approval-mode plan` AND
 *      scripts/gemini/review-policy.toml, which allows only the read tools. Plan mode alone
 *      is not read-only headless (the CLI auto-allows exit_plan_mode, then writes).
 *   3. refuses the result if the working tree changed during the run (UNSAFE)
 *   4. counts real file reads; a review that read nothing gets a warning header, since a
 *      probe showed gemini-2.5-pro citing file:line it never opened
 *   5. logs the spend to the LLM usage ledger (provider gemini)
 *
 * Usage:  <prompt on stdin> | node scripts/gemini/review.js --caller=ship-check [--model=M] [--timeout-sec=900]
 * stdout: the review text (only when exit 0)
 * stderr: one status line: `GEMINI-REVIEW: ok|no-reads model=M reads=N`, or `MISSING: <why>`,
 *         `EMPTY: <why>`, `FAILED: <why>`, `UNSAFE: <why>`
 * Exit:   0 review printed | 3 MISSING (fall back) | 1 EMPTY/FAILED | 4 UNSAFE (tree changed)
 * Never prints the API key.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIN = process.env.GEMINI_CLI_VERSION || '0.70.0';
// Pro, not Flash: on a planted cross-file bug both caught it 3/3, but Flash missed it 1 run in 4 and once
// opened with "No findings" before describing it. Pro is ~$0.09 a review vs ~$0.02 (BRO-7987 probe).
const DEFAULT_MODEL = 'gemini-2.5-pro';
const POLICY = path.join(__dirname, 'review-policy.toml');
const READ_TOOLS = ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'];
const NO_READS_HEADER = 'NOTE: Gemini opened no repository files in this review; treat every file:line claim below as unverified.';

/** Should the CLI be (re)installed? Cloud enforces the pin; the Mac only reports a missing CLI. */
function installDecision({ have, pin, remote }) {
  if (!have) return remote ? 'install' : 'missing';
  if (remote && have !== pin) return 'install';
  return 'use';
}

/** CLI argv for one headless read-only review. */
function buildArgs({ model, policy }) {
  return ['--skip-trust', '--approval-mode', 'plan', '--policy', policy, '-m', model, '-o', 'json',
    '-p', 'Do the review described above. Read the repository files you need before you claim anything about them.'];
}

/**
 * Gemini CLI `-o json` stdout -> { response, reads, toolCalls, usage: [{model, usageMetadata}] } or { error }.
 * The CLI may print warnings before the JSON, so parse from the first `{` line.
 */
function parseCliJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return { error: 'no JSON in the Gemini CLI output' };
  let j;
  try { j = JSON.parse(s.slice(i)); } catch (e) { return { error: `unparseable Gemini CLI JSON (${e.message})` }; }
  if (j.error) return { error: typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)).slice(0, 300) };
  const byName = (j.stats && j.stats.tools && j.stats.tools.byName) || {};
  const reads = READ_TOOLS.reduce((n, t) => n + ((byName[t] && Number(byName[t].success)) || 0), 0);
  const toolCalls = Object.values(byName).reduce((n, v) => n + (Number(v && v.count) || (Number(v && v.success) || 0) + (Number(v && v.fail) || 0)), 0);
  const usage = Object.entries((j.stats && j.stats.models) || {}).map(([model, v]) => {
    const t = (v && v.tokens) || {};
    return { model, usageMetadata: {
      promptTokenCount: Number(t.prompt) || 0,
      candidatesTokenCount: Number(t.candidates) || 0,
      thoughtsTokenCount: Number(t.thoughts) || 0,
      cachedContentTokenCount: Number(t.cached) || 0,
    } };
  });
  return { response: typeof j.response === 'string' ? j.response.trim() : '', reads, toolCalls, usage };
}

/** `git status --porcelain -z` snapshots -> list of paths that differ (empty = unchanged). */
function treeChanges(before, after) {
  const split = (s) => new Set(String(s || '').split('\0').filter(Boolean));
  const a = split(before), b = split(after);
  const out = [];
  for (const x of b) if (!a.has(x)) out.push(x.slice(3) || x);
  for (const x of a) if (!b.has(x)) out.push(x.slice(3) || x);
  return [...new Set(out)];
}

function gitStatus(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function cliVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? String(r.stdout).trim().split(/\s+/).pop() : '';
}

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

function main() {
  const status = (line) => process.stderr.write(line + '\n');
  const done = (code, line) => { status(line); process.exit(code); };
  const caller = arg('caller', 'gemini-review');
  const model = arg('model', process.env.GEMINI_REVIEW_MODEL || DEFAULT_MODEL);
  const timeoutMs = Number(arg('timeout-sec', '900')) * 1000;
  const remote = process.env.CLAUDE_CODE_REMOTE === 'true';
  const bin = process.env.GEMINI_CLI_BIN || 'gemini';

  if (!process.env.GEMINI_API_KEY) done(3, 'MISSING: GEMINI_API_KEY is not set');
  let prompt = '';
  try { prompt = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
  if (!prompt.trim()) done(1, 'FAILED: no prompt on stdin');

  const decision = installDecision({ have: cliVersion(bin), pin: PIN, remote });
  if (decision === 'missing') done(3, 'MISSING: no gemini CLI on PATH (the Mac path never installs it; npm i -g @google/gemini-cli to add it)');
  if (decision === 'install') {
    const r = spawnSync('npm', ['i', '-g', '--no-audit', '--no-fund', `@google/gemini-cli@${PIN}`], { encoding: 'utf8', timeout: 240_000 });
    if (r.status !== 0) done(3, `MISSING: npm install of @google/gemini-cli@${PIN} failed: ${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 200)}`);
    const have = cliVersion(bin);
    if (have !== PIN) done(3, `MISSING: gemini --version says '${have || 'nothing'}' after install, wanted ${PIN}`);
  }

  const cwd = process.cwd();
  const before = gitStatus(cwd);
  const r = spawnSync(bin, buildArgs({ model, policy: POLICY }), {
    cwd, input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const after = before === null ? null : gitStatus(cwd);
  if (before !== null) {
    const changed = treeChanges(before, after);
    if (changed.length) done(4, `UNSAFE: the working tree changed during the Gemini review (${changed.slice(0, 5).join(', ')}); check those files before trusting anything, the read-only policy did not hold`);
  }

  const parsed = parseCliJson(r.stdout);
  // Log what was spent even when the review itself is unusable.
  if (parsed.usage && parsed.usage.length) {
    try {
      const { logSessionCall } = require('../lib/gemini-usage-ledger');
      for (const u of parsed.usage) logSessionCall({ provider: 'gemini', model: u.model, response: { usageMetadata: u.usageMetadata }, caller });
    } catch { /* record only */ }
  }
  if (r.error && r.error.code === 'ETIMEDOUT') done(1, `FAILED: gemini timed out after ${timeoutMs / 1000}s`);
  if (r.status !== 0) {
    const why = parsed.error || String(r.stderr || '').split('\n').filter((l) => l && !/256-color/.test(l)).pop() || `exit ${r.status}`;
    done(1, `FAILED: gemini exited ${r.status}: ${String(why).slice(0, 300)}`);
  }
  if (parsed.error) done(1, `FAILED: ${parsed.error}`);
  if (!parsed.response) done(1, 'EMPTY: gemini exited 0 with no response text');

  process.stdout.write((parsed.reads === 0 ? NO_READS_HEADER + '\n\n' : '') + parsed.response + '\n');
  done(0, `GEMINI-REVIEW: ${parsed.reads === 0 ? 'no-reads' : 'ok'} model=${model} reads=${parsed.reads}`);
}

module.exports = { installDecision, buildArgs, parseCliJson, treeChanges, NO_READS_HEADER, READ_TOOLS, PIN, POLICY };
if (require.main === module) main();
