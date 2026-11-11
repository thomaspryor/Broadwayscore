#!/usr/bin/env node
/**
 * hook-replay.mjs (BRO-7351): replay real session transcripts through the Stop
 * hook twice, once from main (the base) and once from this branch (the head),
 * and report every stop where the decision changed.
 *
 * Why: a rule, hook or guidance change is judged by unit tests written by the
 * same session that wrote it. BRO-7349 passed its tests and still counted
 * quoted text as landings and scoped answers session-wide; only a replay of
 * real sessions showed it. This makes that replay one command.
 *
 * Usage:
 *   node scripts/lib/hook-replay.mjs [transcript.jsonl ...] [--from-events f.json ...]
 *        [--base origin/main] [--max-stops 20] [--record] [--json]
 *   No transcripts: the 3 newest top-level ~/.claude/projects/<proj>/<id>.jsonl with recorded Stops.
 *   --from-events: files saved from the list_events tool (cloud sessions), converted first.
 *   --record: append a row to <repo>/.claude/hook-replays.jsonl keyed by the hook-scope
 *             diff hash, which the land preflight reads (advisory warning when missing).
 *
 * How a stop is replayed: the transcript is cut just before the turn's final text,
 * and the hook gets {transcript_path, last_assistant_message, stop_hook_active} the way
 * Claude Code sends it. HOME and TMPDIR are fresh per (version, transcript) so block
 * budgets start clean and evolve in order; `gh` is stubbed to fail and the Linear,
 * OpenAI, Gemini and GitHub keys are removed, so no replay writes anywhere real.
 * Known blind spot: gates that need Linear (close-out checks) are skipped in replay.
 * Only the FIRST changed stop per transcript is fully reliable: later ones can be
 * knock-on effects of block budgets that already diverged.
 *
 * Exit: 0 report printed (changes are not an error) | 1 internal error | 2 usage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HOOK = '.claude/hooks/verify-edits.sh';
export const LEDGER = '.claude/hook-replays.jsonl';
const SECRET_ENV = ['LINEAR_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'RESEND_API_KEY'];

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
const gitOut = (cwd, args) => {
  const r = git(cwd, args);
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---------------------------------------------------------------- hook scope

const TOKEN_RE = /[\w.-]+\.(?:mjs|cjs|js|py|json)\b/g;
// A file path the hook only compares against (an edited-file watchlist), not code it runs.
const DATA_ONLY_RE = /\.endswith\(|_FALLBACK\s*=/;

/**
 * scripts/lib files a hook script loads, from its text. The hook names them as whole paths
 * (scripts/lib/x.mjs) or as path segments (os.path.join(root, 'scripts', 'lib', 'x.js')), so any
 * file name that exists in scripts/lib counts. Comment lines and text, echo text and watched-path
 * lists do not. `libFiles` = the scripts/lib paths that exist.
 */
export function libsNamedIn(scriptText, libFiles) {
  const have = new Set(libFiles);
  const found = new Set();
  for (const line of String(scriptText).split('\n')) {
    let t = line.trim();
    if (!t || t.startsWith('#') || /^(?:echo|printf)\b/.test(t) || DATA_ONLY_RE.test(t)) continue;
    t = t.replace(/\s#\s.*$/, '');
    for (const m of t.match(TOKEN_RE) || []) {
      const f = `scripts/lib/${path.basename(m)}`;
      if (have.has(f)) found.add(f);
    }
  }
  return [...found].sort();
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Top-level relative imports of a JS file that resolve to existing files (tries .js/.mjs/.cjs/index.js). */
export function relativeImports(file, text, have) {
  const out = [];
  // Top-level imports only: an indented require() is a lazy load inside one function (often the
  // Linear client), which the replay cannot observe and which would pull in most of scripts/lib.
  const top = String(text).split('\n').filter((l) => /^\S/.test(l)).join('\n');
  for (const m of top.matchAll(IMPORT_RE)) {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    const hit = [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}/index.js`].find((c) => have.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Hook scope at `rev`: what this replay can test, i.e. the Stop hook (verify-edits.sh, the only
 * Stop hook in .claude/settings.json), the scripts/lib files it names, and everything those
 * import in turn. PreToolUse hooks are not replayed, so a change to them is out of scope.
 */
export function hookScope(cwd, rev) {
  const text = gitOut(cwd, ['show', `${rev}:${HOOK}`]);
  if (!text) return { hook: HOOK, libs: [] };
  const tracked = (gitOut(cwd, ['ls-tree', '-r', '--name-only', rev, '--', 'scripts']) || '').split('\n').filter(Boolean);
  const have = new Set(tracked);
  const libs = new Set(libsNamedIn(text, tracked.filter((f) => f.startsWith('scripts/lib/'))));
  const queue = [...libs];
  while (queue.length) {
    const f = queue.shift();
    if (!/\.(?:mjs|cjs|js)$/.test(f)) continue;
    for (const dep of relativeImports(f, gitOut(cwd, ['show', `${rev}:${f}`]) || '', have)) {
      if (!libs.has(dep)) { libs.add(dep); queue.push(dep); }
    }
  }
  return { hook: HOOK, libs: [...libs].sort() };
}

export const inHookScope = (file, scope) => file === scope.hook || scope.libs.includes(file);

/** -> { files, hash } for the hook-scope part of base...src; hash null when nothing in scope changed. */
export function hookScopeDiff(cwd, base, src = 'HEAD') {
  const names = gitOut(cwd, ['diff', '--name-only', '--no-renames', `${base}...${src}`]);
  if (names === null) return { files: [], hash: null, error: `git diff ${base}...${src} failed` };
  const scope = hookScope(cwd, src);
  const files = names.split('\n').filter(Boolean).filter((f) => inHookScope(f, scope));
  if (!files.length) return { files, hash: null };
  const patch = git(cwd, ['diff', '--no-renames', `${base}...${src}`, '--', ...files]).stdout || '';
  return { files, hash: createHash('sha256').update(patch).digest('hex').slice(0, 16) };
}

export function canonicalRoot(cwd) {
  const common = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? path.dirname(common) : cwd;
}

export function readLedger(root) {
  try {
    return fs.readFileSync(path.join(root, LEDGER), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Land preflight advice (advisory, never blocks; rule 19): the pushed commit changes
 * Stop-hook code and no replay of real sessions was recorded for that exact change.
 * -> string | null
 */
export function hookReplayWarning({ root, src = 'HEAD', base = 'origin/main', ledgerRoot = null }) {
  try {
    const d = hookScopeDiff(root, base, src);
    if (!d.hash) return null;
    const rows = readLedger(ledgerRoot || canonicalRoot(root));
    if (rows.some((r) => r.hash === d.hash)) return null;
    const shown = d.files.slice(0, 4).join(', ') + (d.files.length > 4 ? `, +${d.files.length - 4} more` : '');
    return `this land changes Stop-hook code (${shown}) and no replay of real sessions was recorded for it (BRO-7351). Before landing a hook or rule change, run: node scripts/lib/hook-replay.mjs --record (replays recent real sessions through main's hook and this branch's, and lists every stop whose decision changed). Advisory only.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- transcript stops

export function textOf(row) {
  const c = row?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

const isMain = (r) => r && !r.isSidechain;
const isAssistantText = (r) => isMain(r) && r.type === 'assistant' && textOf(r).trim() !== '';
function isRealUser(r) {
  if (!isMain(r) || r.type !== 'user' || r.isMeta || r.isCompactSummary) return false;
  const c = r.message?.content;
  if (typeof c === 'string') return c.trim() !== '' && !/^<local-command-(?:stdout|stderr|caveat)>/.test(c.trim());
  return Array.isArray(c) && c.some((b) => b && b.type === 'text' && String(b.text || '').trim() !== '');
}
const hook1Errors = (r) => (r.hookErrors || []).filter((x) => /^\[command hook 1\]/.test(String(x)));

/**
 * Stop points of a transcript. Uses the recorded Stops (system/stop_hook_summary rows) when
 * there are any, else turn ends (last assistant text before a real user message, or EOF).
 * -> [{ cut, text, ts, recorded: 'block'|'allow'|null, recordedTag }]
 *    cut = number of lines the hook sees (the turn's final text row is not yet written).
 */
export function stopPoints(rows) {
  const out = [];
  const summaries = rows.map((r, i) => (r && r.type === 'system' && r.subtype === 'stop_hook_summary' && isMain(r) ? i : -1)).filter((i) => i >= 0);
  if (summaries.length) {
    for (const j of summaries) {
      let t = j - 1;
      while (t >= 0 && !isAssistantText(rows[t])) t--;
      if (t < 0) continue;
      const errs = hook1Errors(rows[j]);
      out.push({ cut: t, text: textOf(rows[t]), ts: rows[j].timestamp || rows[t].timestamp || '', recorded: errs.length ? 'block' : 'allow', recordedTag: errs.length ? String(errs[0]).replace(/^\[command hook \d+\]:\s*/, '').slice(0, 100) : '' });
    }
    return out;
  }
  let last = -1;
  const flush = () => {
    if (last >= 0) out.push({ cut: last, text: textOf(rows[last]), ts: rows[last].timestamp || '', recorded: null, recordedTag: '' });
    last = -1;
  };
  rows.forEach((r, i) => {
    if (isRealUser(r)) flush();
    else if (isAssistantText(r)) last = i;
  });
  flush();
  return out;
}

/** list_events results (saved tool output, `{"ccr": {data: [...]}}` somewhere in the file) -> transcript rows. */
export function eventsToRows(fileTexts) {
  const byId = new Map();
  for (const s of fileTexts) {
    const i = s.indexOf('{"ccr"');
    const j = s.lastIndexOf('}');
    if (i < 0 || j < i) continue;
    let o;
    try { o = JSON.parse(s.slice(i, j + 1)).ccr; } catch { continue; }
    for (const e of o?.data || []) {
      for (const k of ['assistant', 'user']) {
        const v = e[k];
        if (!v) continue;
        const inner = v.internal_anthropic_catchall || v;
        if (!inner.message) continue;
        const id = v.uuid || `${e.created_at}-${byId.size}`;
        byId.set(id, { type: k, message: inner.message, timestamp: e.created_at, uuid: id, isSidechain: Boolean(inner.agent_id) });
      }
    }
  }
  return [...byId.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

// ------------------------------------------------------------------- replay

function cksum(s) {
  const r = spawnSync('cksum', { input: s, encoding: 'utf8' });
  return (r.stdout || '').split(' ')[0];
}

function runHook({ tree, hook, stdin, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(tree, hook)], { cwd: tree, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stderr: err, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

export function decisionOf({ code, stderr, timedOut }) {
  if (timedOut || (code !== 0 && code !== 2)) return { decision: 'crash', tag: timedOut ? 'TIMEOUT' : `EXIT_${code}`, detail: String(stderr).trim().split('\n').slice(-1)[0]?.slice(0, 160) || '' };
  if (code === 0) return { decision: 'allow', tag: '', detail: '' };
  const tag = (String(stderr).match(/\[VE:([A-Z0-9_]+)\]/) || [])[1] || '?';
  const line = String(stderr).split('\n').find((l) => /BLOCKED|🛑/.test(l)) || String(stderr).trim().split('\n')[0] || '';
  return { decision: 'block', tag, detail: line.slice(0, 160) };
}

/**
 * Replay `stops` of one transcript through one tree's hook, in order, sharing one HOME and
 * TMPDIR so state (block budgets) carries from stop to stop as in a real session.
 */
export async function replayOne({ tree, hook = HOOK, lines, stops, label, binDir, timeoutMs = 60000, extraEnv = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `hook-replay-home-${label}-`));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hook-replay-tmp-${label}-`));
  const cut = path.join(tmp, `transcript-${label}.jsonl`);
  const env = { ...process.env, HOME: home, TMPDIR: tmp, CLAUDE_CODE_REMOTE: 'true', HOOK_REPLAY: '1', PATH: `${binDir}:${process.env.PATH}`, ...extraEnv };
  for (const k of SECRET_ENV) delete env[k];
  // CLAUDE_PROJECT_DIR would point the hook's helpers at the live checkout (and its .env keys)
  // instead of the tree under test; the board gates read live Linear state, so they stay off.
  delete env.CLAUDE_PROJECT_DIR;
  env.BOARD_GATE_DISABLED = '1';
  env.CLAUDE_CODE_SESSION_ID = `replay-${label}`;
  const results = [];
  let prevBlocked = false;
  try {
    for (const s of stops) {
      fs.writeFileSync(cut, lines.slice(0, s.cut).join('\n') + '\n');
      const active = s.recorded ? s.prevRecordedBlock : prevBlocked;
      const stdin = JSON.stringify({ session_id: `replay-${label}`, transcript_path: cut, cwd: tree, hook_event_name: 'Stop', stop_hook_active: Boolean(active), last_assistant_message: s.text });
      const d = decisionOf(await runHook({ tree, hook, stdin, env: { ...env, STALL_GATE_NOW: s.ts || '' }, timeoutMs }));
      prevBlocked = d.decision === 'block';
      results.push(d);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    // The hook keeps two state files at fixed /tmp paths keyed by the transcript path.
    fs.rmSync(`/tmp/verify-edits-chain-${cksum(cut)}`, { force: true });
    fs.rmSync(`/tmp/verify-edits-satisfied-${createHash('md5').update(cut).digest('hex').slice(0, 16)}.json`, { force: true });
  }
  return results;
}

/** Detached worktree of `rev` under <root>/.claude/worktrees/ (node_modules resolves from the repo root). */
export function prepareTree(root, name, rev, { withDirtyFrom = null } = {}) {
  const dir = path.join(root, '.claude', 'worktrees', name);
  if (fs.existsSync(dir)) {
    // A leftover directory that is not its own worktree would resolve to the enclosing checkout,
    // and checkout -f there would throw away someone's work.
    const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
    if (!top || fs.realpathSync(top) !== fs.realpathSync(dir)) throw new Error(`${dir} exists and is not a worktree of its own; remove it and re-run`);
    const r = git(dir, ['checkout', '-q', '--detach', '-f', rev]);
    if (r.status !== 0) throw new Error(`could not check out ${rev} in ${dir}: ${r.stderr.trim()}`);
    git(dir, ['clean', '-fdq']);
  } else {
    const r = git(root, ['worktree', 'add', '-q', '--detach', dir, rev]);
    if (r.status !== 0) throw new Error(`git worktree add ${dir} ${rev} failed: ${r.stderr.trim()}`);
  }
  if (withDirtyFrom) {
    const patch = git(withDirtyFrom, ['diff', '--binary', 'HEAD']).stdout;
    if (patch) {
      const a = spawnSync('git', ['apply', '--whitespace=nowarn'], { cwd: dir, input: patch, encoding: 'utf8' });
      if (a.status !== 0) throw new Error(`could not apply uncommitted changes to ${dir}: ${a.stderr.trim()}`);
    }
    // New files not yet added to git are not in that diff.
    for (const f of (git(withDirtyFrom, ['ls-files', '--others', '--exclude-standard']).stdout || '').split('\n').filter(Boolean)) {
      // Nested repos and worktrees list as "dir/"; only plain files are copied.
      if (f.endsWith('/') || f.startsWith('.claude/worktrees/')) continue;
      let st;
      try { st = fs.lstatSync(path.join(withDirtyFrom, f)); } catch { continue; }
      if (!st.isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(withDirtyFrom, f), path.join(dir, f));
    }
  }
  return dir;
}

/** Uncommitted paths (modified, staged, untracked). */
export function dirtyFiles(cwd) {
  // Not gitOut: its trim() would eat the first line's leading status space and cut the path.
  return (git(cwd, ['status', '--porcelain', '--untracked-files=all']).stdout || '').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
}

export function defaultTranscripts(home = os.homedir(), n = 3) {
  const base = path.join(home, '.claude', 'projects');
  let files = [];
  try {
    for (const p of fs.readdirSync(base)) {
      const d = path.join(base, p);
      try {
        for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) files.push(path.join(d, f));
      } catch { /* not a dir */ }
    }
  } catch { return []; }
  files = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f);
  return files.filter((f) => fs.readFileSync(f, 'utf8').includes('"stop_hook_summary"')).slice(0, n);
}

/** Same block? By [VE:TAG] when both have one; an older hook without tags is matched on its message. */
export function sameDecision(b, h) {
  if (b.decision !== h.decision) return false;
  if (b.decision !== 'block') return true;
  if (b.tag !== '?' && h.tag !== '?') return b.tag === h.tag;
  return b.detail.slice(0, 80) === h.detail.slice(0, 80);
}

export function compare(stops, base, head) {
  const changed = [];
  stops.forEach((s, i) => {
    const b = base[i];
    const h = head[i];
    if (!sameDecision(b, h)) changed.push({ i, ts: s.ts, base: b, head: h, message: s.text.replace(/\s+/g, ' ').slice(0, 120) });
  });
  const fidelity = stops.filter((s) => s.recorded).length
    ? { compared: stops.filter((s) => s.recorded).length, agree: stops.filter((s, i) => s.recorded && s.recorded === base[i].decision).length }
    : null;
  return { changed, fidelity, crashes: { base: base.filter((d) => d.decision === 'crash').length, head: head.filter((d) => d.decision === 'crash').length } };
}

function parseArgs(argv) {
  const a = { transcripts: [], events: [], base: 'origin/main', maxStops: 20, record: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--base') a.base = argv[++i];
    else if (x === '--max-stops') a.maxStops = Number(argv[++i]);
    else if (x === '--from-events') a.events.push(argv[++i]);
    else if (x === '--record') a.record = true;
    else if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (x.startsWith('--')) throw new Error(`unknown flag ${x}`);
    else a.transcripts.push(x);
  }
  if (!(a.maxStops > 0)) throw new Error('--max-stops must be a positive number');
  return a;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (a.help) { console.log('usage: node scripts/lib/hook-replay.mjs [transcript.jsonl ...] [--from-events f.json ...] [--base origin/main] [--max-stops 20] [--record] [--json]'); return 0; }
  const cwd = gitOut(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!cwd) { console.error('run inside the Broadwayscore repo'); return 2; }
  const root = canonicalRoot(cwd);
  const headSha = gitOut(cwd, ['rev-parse', 'HEAD']);
  const baseSha = gitOut(cwd, ['rev-parse', a.base]);
  if (!baseSha) { console.error(`unknown base ${a.base}`); return 2; }
  const scopeDiff = hookScopeDiff(cwd, a.base, 'HEAD');
  const dirty = dirtyFiles(cwd);
  const scope = hookScope(cwd, 'HEAD');
  const dirtyInScope = dirty.filter((f) => inHookScope(f, scope));
  if (a.record && dirtyInScope.length) { console.error(`--record needs committed hook code; uncommitted: ${dirtyInScope.join(', ')}`); return 2; }

  const inputs = [];
  for (const t of a.transcripts) inputs.push({ name: path.basename(t), lines: fs.readFileSync(t, 'utf8').split('\n').filter(Boolean) });
  if (a.events.length) {
    const rows = eventsToRows(a.events.map((f) => fs.readFileSync(f, 'utf8')));
    inputs.push({ name: `events:${path.basename(a.events[0])}`, lines: rows.map((r) => JSON.stringify(r)) });
  }
  if (!inputs.length) for (const t of defaultTranscripts()) inputs.push({ name: path.basename(t), lines: fs.readFileSync(t, 'utf8').split('\n').filter(Boolean) });
  if (!inputs.length) { console.error('no transcripts given and none with recorded Stops under ~/.claude/projects'); return 2; }

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-bin-'));
  fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\necho "gh disabled in hook replay" >&2\nexit 1\n', { mode: 0o755 });
  const started = Date.now();
  const report = { base: baseSha, head: headSha, dirty: dirtyInScope, scope: scopeDiff, transcripts: [] };
  // Per-process worktree names: two replays at once must not check out over each other's trees.
  const trees = [];
  try {
    const baseTree = prepareTree(root, `hook-replay-base-${process.pid}`, baseSha);
    trees.push(baseTree);
    const headTree = prepareTree(root, `hook-replay-head-${process.pid}`, headSha, { withDirtyFrom: cwd });
    trees.push(headTree);
    for (const [n, inp] of inputs.entries()) {
      const rows = inp.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      let stops = stopPoints(rows);
      stops.forEach((s, i) => { s.prevRecordedBlock = i > 0 && stops[i - 1].recorded === 'block'; });
      const total = stops.length;
      stops = stops.slice(-a.maxStops);
      const [b, h] = await Promise.all([
        replayOne({ tree: baseTree, lines: inp.lines, stops, label: `base${n}`, binDir }),
        replayOne({ tree: headTree, lines: inp.lines, stops, label: `head${n}`, binDir }),
      ]);
      report.transcripts.push({ name: inp.name, stops: stops.length, total, ...compare(stops, b, h) });
    }
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    for (const t of trees) git(root, ['worktree', 'remove', '--force', t]);
  }
  report.secs = Math.round((Date.now() - started) / 1000);
  const stopsN = report.transcripts.reduce((s, t) => s + t.stops, 0);
  const changedN = report.transcripts.reduce((s, t) => s + t.changed.length, 0);
  const crashN = report.transcripts.reduce((s, t) => s + t.crashes.head, 0);

  if (a.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`hook replay: ${a.base} ${baseSha.slice(0, 9)} vs this branch ${headSha.slice(0, 9)}${dirtyInScope.length ? ' + uncommitted' : ''}, ${stopsN} stops in ${report.transcripts.length} transcript(s), ${report.secs}s`);
    console.log(`hook-scope files changed: ${scopeDiff.files.length ? scopeDiff.files.join(', ') : 'none'}`);
    for (const t of report.transcripts) {
      const fid = t.fidelity ? `; main's hook matches the recorded outcome at ${t.fidelity.agree}/${t.fidelity.compared} stops` : '';
      console.log(`\n${t.name}: last ${t.stops} of ${t.total} stops, ${t.changed.length} changed${fid}${t.crashes.head ? `; ${t.crashes.head} HEAD crash(es)` : ''}`);
      t.changed.forEach((c, k) => {
        const fmt = (d) => (d.decision === 'allow' ? 'allow' : `${d.decision} ${d.tag}`);
        console.log(`  ${k === 0 ? '*' : ' '} stop ${c.i} ${String(c.ts).slice(5, 16)}: ${fmt(c.base)} -> ${fmt(c.head)}`);
        console.log(`      said: ${c.message}`);
        if (c.head.detail) console.log(`      head: ${c.head.detail}`);
        if (c.base.detail && c.base.decision !== 'allow') console.log(`      main: ${c.base.detail}`);
      });
    }
    console.log(`\n* = first change in that transcript (reliable). Later changes may follow from it. Linear-backed gates do not run in replay.`);
  }
  if (a.record) {
    const row = { ts: new Date().toISOString(), head: headSha, base: baseSha, hash: scopeDiff.hash, files: scopeDiff.files, transcripts: report.transcripts.map((t) => t.name), stops: stopsN, changed: changedN, headCrashes: crashN };
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.appendFileSync(path.join(root, LEDGER), JSON.stringify(row) + '\n');
    if (!a.json) console.log(`recorded in ${LEDGER}${scopeDiff.hash ? '' : ' (no hook-scope change on this branch)'}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitFlushed } = createRequire(import.meta.url)('./exit-flushed.js');
  main(process.argv.slice(2)).then(
    (c) => exitFlushed(c),
    (e) => { console.error(`hook-replay: ${e.stack || e.message}`); exitFlushed(1); },
  );
}
