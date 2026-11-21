#!/usr/bin/env node
/**
 * scripts/gemini/review.js: run Gemini as a repo-reading, read-only code reviewer (BRO-7987).
 *
 * Before this, /plan-review's Gemini leg was a bare REST curl with only the
 * plan text, so Gemini could not open a single file, and /ship-check had no Gemini leg.
 * The Gemini CLI can read the repository with its own file tools. This wrapper:
 *   1. makes the CLI available (cloud: installs the pinned @google/gemini-cli; Mac: uses
 *      an installed one and never installs), and needs GEMINI_API_KEY
 *   2. runs it headless in the current directory with `--approval-mode plan` AND
 *      scripts/gemini/review-policy.toml, which allows only the read tools. Plan mode alone
 *      is not read-only headless (the CLI auto-allows exit_plan_mode, then writes).
 *   3. refuses the result if the working tree changed during the run (UNSAFE)
 *   4. counts real file reads; a run that read nothing is retried once, then gets a warning header, since a
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
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

// Not overridable from the environment: the policy is verified on this version only (Codex review).
const PIN = '0.70.0';
// Flash, not Pro (BRO-7987 probe). The point of this reviewer is that it opens the code, and on a
// 600-line diff Pro opened no files in 3 of 4 runs (while writing "I have verified..."), even with
// READ_NUDGE; Flash opened 6 files in 3 of 3. On a planted cross-file unit bug Flash caught it in
// 6 of 7 runs, Pro 3 of 3. Flash is ~$0.02 a review, Pro ~$0.09. Override: GEMINI_REVIEW_MODEL.
// 2.5-flash shuts down 2026-12-01 (BRO-7511). On CLI 0.70.0, models.js GEMINI_FLASH (3.5-flash-lite,
// same price) opened 2 and 3 files on two probes; gemini-3.8-flash opened 5 for ~5x the price.
// BRO-8016: owner chose strength over price, so the default is models.js GEMINI_REVIEW (Gemini 4
// Carbon). Unlike 2.5-pro it opened files on every probe (54 on the first), about $0.10-0.30 a review.
const DEFAULT_MODEL = require('../lib/models').GEMINI_REVIEW;
const READ_NUDGE = 'Before you answer, open with read_file every file the diff or plan names, and the code it calls. A review that opens no files is rejected. Then do the review described above.';
const RETRY_NUDGE = 'Your previous answer was rejected because you opened no files. ' + READ_NUDGE;
const POLICY = path.join(__dirname, 'review-policy.toml');
// Tools the policy allows. Only CONTENT_TOOLS count as "read the code": a glob or a directory
// listing shows names, and one grep hit anywhere is not opening the changed code (Codex review, BRO-7987).
const READ_TOOLS = ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory'];
const CONTENT_TOOLS = ['read_file', 'read_many_files'];
const NO_READS_HEADER = 'NOTE: Gemini opened no repository files in this review; treat every file:line claim below as unverified.';

/**
 * Should the CLI be (re)installed? Cloud installs the pin. The Mac never installs, and refuses an
 * off-pin CLI: the read-only policy was verified on the pinned version only.
 */
function installDecision({ have, pin, remote }) {
  if (!have) return remote ? 'install' : 'missing';
  if (have !== pin) return remote ? 'install' : 'off-pin';
  return 'use';
}

/** CLI argv for one headless read-only review. */
function buildArgs({ model, policy, retry = false }) {
  return ['--skip-trust', '--approval-mode', 'plan', '--policy', policy, '-m', model, '-o', 'json',
    '-p', retry ? RETRY_NUDGE : READ_NUDGE];
}

/**
 * Gemini CLI `-o json` stdout -> { response, reads, toolCalls, usage: [{model, usageMetadata}] } or { error }.
 * The CLI may print warnings before the JSON, so parse from the first `{` line.
 */
function parseCliJson(text) {
  const s = String(text || '').trim();
  let j;
  try { j = JSON.parse(s); } catch (e) {
    // A warning line ahead of the JSON: parse from the first line that opens an object.
    const i = s.startsWith('{') ? -1 : s.indexOf('\n{');
    if (i < 0) return { error: s.includes('{') ? `unparseable Gemini CLI JSON (${e.message})` : 'no JSON in the Gemini CLI output' };
    try { j = JSON.parse(s.slice(i + 1)); } catch (e2) { return { error: `unparseable Gemini CLI JSON (${e2.message})` }; }
  }
  if (j.error) return { error: typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)).slice(0, 300) };
  const byName = (j.stats && j.stats.tools && j.stats.tools.byName) || {};
  const reads = CONTENT_TOOLS.reduce((n, t) => n + ((byName[t] && Number(byName[t].success)) || 0), 0);
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

/** `git status --porcelain=v1 -z` -> [{ xy, path }]. A rename/copy entry is followed by its source path. */
function parseStatus(z) {
  const tok = String(z || '').split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const xy = tok[i].slice(0, 2);
    out.push({ xy, path: tok[i].slice(3) });
    if (/[RC]/.test(xy)) i++; // skip the rename/copy source
  }
  return out;
}

/** Two snapshots (Map path -> "XY:contenthash") -> paths that differ (empty = unchanged). */
function treeChanges(before, after) {
  const out = new Set();
  for (const [p, sig] of after) if (before.get(p) !== sig) out.add(p);
  for (const p of before.keys()) if (!after.has(p)) out.add(p);
  return [...out];
}

/**
 * Dirty-file snapshot with content hashes, so a write to an already-modified file is seen too
 * (comparing status lines alone missed it, Codex review). Ignored files are not covered; the
 * policy file is the primary lock, this is the tripwire. null when git status fails.
 */
function snapshot(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  // porcelain paths are relative to the repo root, not to cwd
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  const root = top.status === 0 ? top.stdout.trim() : cwd;
  const m = new Map();
  for (const { xy, path: p } of parseStatus(r.stdout)) {
    let h = 'gone';
    try {
      const f = path.join(root, p);
      const st = fs.statSync(f);
      h = st.size > 50 * 1024 * 1024 ? `size${st.size}:${st.mtimeMs}` : crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
    } catch { /* deleted or unreadable */ }
    m.set(p, `${xy}:${h}`);
  }
  return m;
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
  const timeoutSec = Number(arg('timeout-sec', '900'));
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) done(1, `FAILED: --timeout-sec must be a positive number, got '${arg('timeout-sec')}'`);
  const timeoutMs = timeoutSec * 1000;
  const remote = process.env.CLAUDE_CODE_REMOTE === 'true';
  const bin = process.env.GEMINI_CLI_BIN || 'gemini';

  if (!process.env.GEMINI_API_KEY) done(3, 'MISSING: GEMINI_API_KEY is not set');
  let prompt = '';
  try { prompt = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
  if (!prompt.trim()) done(1, 'FAILED: no prompt on stdin');

  const have = cliVersion(bin);
  const decision = installDecision({ have, pin: PIN, remote });
  if (decision === 'missing') done(3, `MISSING: no gemini CLI on PATH (the Mac path never installs it; npm i -g @google/gemini-cli@${PIN} to add it)`);
  if (decision === 'off-pin') done(3, `MISSING: gemini CLI is ${have}, not the pinned ${PIN}; the read-only policy is verified on ${PIN} only (npm i -g @google/gemini-cli@${PIN})`);
  if (decision === 'install') {
    const r = spawnSync('npm', ['i', '-g', '--no-audit', '--no-fund', `@google/gemini-cli@${PIN}`], { encoding: 'utf8', timeout: 240_000 });
    if (r.status !== 0) done(3, `MISSING: npm install of @google/gemini-cli@${PIN} failed: ${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 200)}`);
    const have = cliVersion(bin);
    if (have !== PIN) done(3, `MISSING: gemini --version says '${have || 'nothing'}' after install, wanted ${PIN}`);
  }

  const cwd = process.cwd();
  // A repo .gemini/ folder (settings, hooks, MCP servers, extensions) would load because of
  // --skip-trust, and starting a server or hook is not a tool call the policy can deny.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  const roots = [cwd, top.status === 0 ? top.stdout.trim() : null].filter(Boolean);
  if (roots.some((d) => fs.existsSync(path.join(d, '.gemini')))) done(3, 'MISSING: this checkout has a .gemini/ folder, whose settings could start servers or hooks outside the read-only policy; not running Gemini here');
  // A fresh, empty HOME: no user settings, extensions, MCP servers or ~/.gemini/policies (which sit
  // in the same tier as ours and could outrank it). The API key comes from the environment.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-review-home-'));
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
  let treeChecked = true;

  /** One CLI run -> { parsed } or { fail: [code, line] }. UNSAFE and a failed re-check exit at once. */
  const attempt = (retry) => {
    const before = snapshot(cwd);
    const r = spawnSync(bin, buildArgs({ model, policy: POLICY, retry }), {
      cwd, input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    });
    const parsed = parseCliJson(r.stdout);
    // Log what was spent even when the review is unusable. No usage (timeout, crash, bad JSON)
    // still writes one row, counted as a call of unknown size, so paid failures are not invisible.
    try {
      const { logSessionCall } = require('../lib/gemini-usage-ledger');
      if (parsed.usage && parsed.usage.length) for (const u of parsed.usage) logSessionCall({ provider: 'gemini', model: u.model, response: { usageMetadata: u.usageMetadata }, caller });
      else logSessionCall({ provider: 'gemini', model, response: {}, caller });
    } catch { /* record only */ }
    if (before === null) {
      // Inside a repo a failed git status is a broken check, not a skipped one (Codex review).
      if (top.status === 0) done(1, 'FAILED: git status failed before the Gemini run, so the working tree could not be checked; not trusting a review without it');
      treeChecked = false;
    }
    else {
      const after = snapshot(cwd);
      if (after === null) done(1, 'FAILED: git status failed after the Gemini run, so the working tree could not be re-checked; do not trust this review');
      const changed = treeChanges(before, after);
      if (changed.length) done(4, `UNSAFE: the working tree changed while Gemini ran (${changed.slice(0, 5).join(', ')}); either the read-only lock failed or another process edited these files, so do not use this review`);
    }
    if (r.error && r.error.code === 'ETIMEDOUT') return { fail: [1, `FAILED: gemini timed out after ${timeoutMs / 1000}s`] };
    if (r.status !== 0) {
      const why = parsed.error || String(r.stderr || '').split('\n').filter((l) => l && !/256-color/.test(l)).pop() || `exit ${r.status}`;
      return { fail: [1, `FAILED: gemini exited ${r.status}: ${String(why).slice(0, 300)}`] };
    }
    if (parsed.error) return { fail: [1, `FAILED: ${parsed.error}`] };
    if (!parsed.response) return { fail: [1, 'EMPTY: gemini exited 0 with no response text'] };
    return { parsed };
  };

  const first = attempt(false);
  if (first.fail) done(...first.fail);
  let parsed = first.parsed;
  let retried = false;
  if (parsed.reads === 0) { // one retry: a review that read nothing is not a code review
    retried = true;
    const second = attempt(true);
    if (second.parsed) parsed = second.parsed; // a failed retry keeps the first answer, labelled
  }
  process.stdout.write((parsed.reads === 0 ? NO_READS_HEADER + '\n\n' : '') + parsed.response + '\n');
  done(0, `GEMINI-REVIEW: ${parsed.reads === 0 ? 'no-reads' : 'ok'} model=${model} reads=${parsed.reads}${retried ? ' retried=1' : ''}${treeChecked ? '' : ' tree-check=skipped(not a git repo)'}`);
}

module.exports = { installDecision, buildArgs, parseCliJson, parseStatus, treeChanges, snapshot, NO_READS_HEADER, READ_TOOLS, CONTENT_TOOLS, READ_NUDGE, RETRY_NUDGE, PIN, POLICY };
if (require.main === module) main();
