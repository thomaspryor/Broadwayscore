#!/usr/bin/env node
/**
 * rule-trial.mjs (BRO-7370): a big change to written guidance (CLAUDE.md, CLOUD.md,
 * AGENTS.md, skills, agent definitions) is tried in one or two fresh trial sessions
 * before it lands. Owner decision 2026-11-11 ("A"): hook code can be replayed
 * against real past sessions (hook-replay.mjs), guidance text cannot, and the
 * costliest past regressions came from guidance text.
 *
 * Usage:
 *   node scripts/lib/rule-trial.mjs status [--base origin/main] [--json]
 *       What guidance this branch changes, how many words, whether a trial is
 *       needed, and the recipe for running one.
 *   node scripts/lib/rule-trial.mjs record --from-json <get_session file> [--from-json <file2>]
 *       --verdict pass|fail --note "<what the trial showed>" [--base origin/main]
 *       Records a trial. Each file is a trial session's get_session JSON; the
 *       session's checked-out revision must carry exactly this branch's guidance
 *       text, so a trial of an older draft does not count.
 *
 * The land preflight warns (advisory, rule 19) when a land push changes guidance
 * by MIN_WORDS or more and no passing trial was recorded for that exact text.
 * The ledger is container-local, so record in the session that pushes land/*.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isMainModule } from './is-main-module.mjs';
import { canonicalRoot, readLedger } from './hook-replay.mjs';

export const LEDGER = '.claude/rule-trials.jsonl';
export const MIN_WORDS = 80; // about one whole new rule; 10 of 29 guidance commits in the 30 days to 2026-11-11 reached it, 18 reached 40

const EXACT = new Set(['.claude/CLOUD.md', 'cloud-memory/MEMORY.md', 'docs/cloud-worker-session-runbook.md']);
const PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /^\.claude\/commands\/[^/]+\.md$/,
  /^\.claude\/skills\/.+\.md$/,
  /^\.agents\/skills\/.+\.md$/,
  /^\.claude\/agents\/[^/]+\.md$/,
];

/** Files every session (or every session using a skill) reads as instructions. Memory topic files are excluded: automated sync rewrites them constantly. */
export function isGuidance(file) {
  return EXACT.has(file) || PATTERNS.some((re) => re.test(file));
}

function git(cwd, args, timeout = 30000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Changed word runs of a `git diff --word-diff=porcelain` patch, per file. Positions,
 * context and line breaks are dropped, so a reflow changes nothing and a rebase onto
 * a newer main keeps the same text identity.
 * -> { words, changes: Map<file, string[]> }
 */
export function wordChanges(porcelain) {
  let words = 0; let file = null; let inHeader = false; let ctx = [];
  const changes = new Map();
  const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p);
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; file = null; ctx = []; continue; }
    if (inHeader) {
      // File name from the +++ line (--- for a deleted file): a "diff --git" line cannot be split safely when a path contains " b/".
      const m = /^(\+\+\+|---) (.+)$/.exec(line);
      if (m && m[2] !== '/dev/null') {
        const p = unquote(m[2]).replace(/^[ab]\//, '');
        if (m[1] === '+++' || !file) file = p;
      }
      if (line.startsWith('@@')) { inHeader = false; ctx = []; }
      continue;
    }
    if (line.startsWith('@@')) { ctx = []; continue; }
    const toks = line.slice(1).split(/\s+/).filter(Boolean);
    if (line[0] === ' ') { ctx = [...ctx, ...toks].slice(-3); continue; }
    if (line[0] !== '+' && line[0] !== '-') continue;
    if (!toks.length) continue;
    words += toks.length;
    if (!changes.has(file)) changes.set(file, []);
    // The three context words before a change place it: "never" before "push" and before "land" are different text.
    changes.get(file).push(`${ctx.join(' ')}|${line[0]}${toks.join(' ')}`);
  }
  return { words, changes };
}

export const countWords = (porcelain) => wordChanges(porcelain).words;

/**
 * -> { files, words, hash } for the guidance part of base...src. Only changed words
 * count: a whitespace reflow is no change and does not void a recorded trial. hash
 * identifies the changed text; null when no guidance words changed.
 */
export function guidanceDiff(cwd, base, src = 'HEAD') {
  const names = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${src}`]);
  if (names === null) return { files: [], words: 0, hash: null, error: `git diff ${base}...${src} failed` };
  const files = names.split('\n').filter(Boolean).filter(isGuidance);
  if (!files.length) return { files, words: 0, hash: null };
  const porcelain = git(cwd, ['diff', '--no-renames', '--word-diff=porcelain', `${base}...${src}`, '--', ...files]);
  if (porcelain === null) return { files, words: 0, hash: null, error: `git diff --word-diff ${base}...${src} failed` };
  const { words, changes } = wordChanges(porcelain);
  if (!words) return { files: [], words: 0, hash: null };
  const changed = [...changes.keys()].sort();
  const text = changed.map((f) => `${f}\n${changes.get(f).join('\n')}`).join('\n\n');
  return { files: changed, words, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

export function minWords(env = process.env) {
  const n = Number(env.RULE_TRIAL_MIN_WORDS);
  return Number.isFinite(n) && n > 0 ? n : MIN_WORDS;
}

/**
 * Land preflight advice (advisory, never blocks; rule 19): the pushed commit changes
 * guidance by minWords() or more and no passing trial was recorded for that exact text.
 * -> string | null
 */
export function ruleTrialWarning({ root, src = 'HEAD', base = 'origin/main', ledgerRoot = null, env = process.env }) {
  try {
    const d = guidanceDiff(root, base, src);
    if (!d.hash || d.words < minWords(env)) return null;
    const rows = readLedger(ledgerRoot || canonicalRoot(root), LEDGER).filter((r) => r.hash === d.hash);
    if (rows.some((r) => r.verdict === 'pass')) return null;
    const shown = d.files.slice(0, 4).join(', ') + (d.files.length > 4 ? `, +${d.files.length - 4} more` : '');
    const failed = rows.some((r) => r.verdict === 'fail')
      ? ' A trial of this exact text was recorded as failed: change the guidance, then trial the new text.'
      : '';
    return `this land changes written guidance (${shown}) by ${d.words} words and no trial session was recorded for this exact text (BRO-7370, owner decision 2026-11-11: big rule-text changes are tried in one or two fresh sessions first).${failed} Run: node scripts/lib/rule-trial.mjs status (prints the recipe), then record the result with rule-trial.mjs record --from-json <trial get_session file> --verdict pass|fail --note "<what it showed>". Advisory only.`;
  } catch {
    return null;
  }
}

/** The Broadwayscore source of a get_session result -> { id, revision, bucket } (throws on a malformed file). */
export function trialSession(json) {
  const s = json.ccr || json;
  if (!/^session_\w+$/.test(s.id || '')) throw new Error('no session id (expected session_...) in the get_session JSON');
  const srcs = (s.session_context && s.session_context.sources) || [];
  const repo = srcs.map((x) => x.git_repository).find((g) => g && /broadwayscore(\.git)?$/i.test(g.url || ''));
  if (!repo || !repo.revision) throw new Error(`${s.id}: no Broadwayscore source revision; start the trial with create_session source_revision=<your pushed branch>`);
  return { id: s.id, revision: repo.revision, bucket: s.status_bucket || '', createdAt: s.created_at || null };
}

/**
 * The commit a trial session checked out. A sha is itself. A branch name resolves to the
 * branch's newest first-parent commit made before the session started, so later edits to
 * the same branch (a newer draft) are not credited to the trial. Fetches the branch first.
 */
export function resolveRevision(cwd, revision, createdAt) {
  if (/^[0-9a-f]{7,40}$/i.test(revision)) {
    const out = git(cwd, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    if (out) return out.trim();
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  const name = revision.replace(/^refs\/heads\//, '');
  git(cwd, ['fetch', '-q', 'origin', name], 90000);
  for (const ref of [`origin/${name}`, name]) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) continue;
    const out = (git(cwd, ['rev-list', '-1', '--first-parent', `--before=${createdAt}`, ref]) || '').trim();
    return out || null;
  }
  return null;
}

/** -> { row } or { error } */
export function buildRecord({ cwd, base, src = 'HEAD', sessions, verdict, note, now = new Date() }) {
  if (!['pass', 'fail'].includes(verdict)) return { error: '--verdict must be pass or fail' };
  if (!note || note.trim().length < 20) return { error: '--note must say what the trial showed (20+ characters)' };
  if (!sessions.length) return { error: 'need at least one --from-json <trial session get_session file>' };
  const d = guidanceDiff(cwd, base, src);
  if (d.error) return { error: d.error };
  if (!d.hash) return { error: `no guidance text changed in ${base}...${src}; nothing to record` };
  const revisions = [];
  for (const s of sessions) {
    if (!s.bucket || /WORKING/.test(s.bucket)) return { error: `${s.id} is still working (or its status is unknown); record after it finishes so its behaviour can be judged` };
    const sha = resolveRevision(cwd, s.revision, s.createdAt);
    if (!sha) return { error: `${s.id}: cannot resolve the commit it ran on (${s.revision}, started ${s.createdAt || 'unknown'})` };
    const t = guidanceDiff(cwd, base, sha);
    if (t.hash !== d.hash) return { error: `${s.id} ran on ${s.revision} (${sha.slice(0, 9)}), whose guidance text differs from this branch's; trial the current text` };
    revisions.push(sha);
  }
  return { row: { ts: now.toISOString(), hash: d.hash, files: d.files, words: d.words, sessions: sessions.map((s) => s.id), revisions, verdict, note: note.trim() } };
}

export function recipe(d, branch) {
  return [
    `1. Push this branch (your session branch, not land/*) so a new session can check it out: ${branch || '<branch>'}.`,
    '2. Start one or two trial sessions with create_session: source_url https://github.com/thomaspryor/Broadwayscore, source_revision <that branch>, model sonnet.',
    '   Prompt: a realistic task the new guidance should change (the kind of request that made you write it), then:',
    '   "TRIAL SESSION: do not push, land, edit Linear, create cards or sessions, email, post or spend. Work in a scratch worktree.',
    '    When done, report what you did and which written guidance (file and rule) you followed or found unclear."',
    '3. When it finishes, read its transcript (list_events) and judge: did it follow the new guidance, and did anything else get worse?',
    '4. Save its get_session JSON to a file and run: node scripts/lib/rule-trial.mjs record --from-json <file> --verdict pass|fail --note "<what it showed>"',
    '5. Archive the trial session.',
    `Guidance changed: ${d.files.join(', ')} (${d.words} words, text ${d.hash}).`,
  ].join('\n');
}

function parseArgs(argv) {
  const a = { cmd: argv[0], base: 'origin/main', src: 'HEAD', json: false, fromJson: [], verdict: null, note: null };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--base') a.base = argv[++i];
    else if (k === '--src') a.src = argv[++i];
    else if (k === '--from-json') a.fromJson.push(argv[++i]);
    else if (k === '--verdict') a.verdict = argv[++i];
    else if (k === '--note') a.note = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { err(`rule-trial: ${e.message}`); return 1; }
  if (a.cmd === 'status') {
    const d = guidanceDiff(cwd, a.base, a.src);
    if (d.error) { err(`rule-trial: ${d.error} (is ${a.base} fetched?)`); return 1; }
    const min = minWords();
    const rows = d.hash ? readLedger(canonicalRoot(cwd), LEDGER).filter((r) => r.hash === d.hash) : [];
    const passed = rows.some((r) => r.verdict === 'pass');
    const needed = Boolean(d.hash) && d.words >= min && !passed;
    if (a.json) { out(JSON.stringify({ ...d, minWords: min, trialNeeded: needed, recorded: rows })); return 0; }
    if (!d.hash) { out('No written guidance changed on this branch. No trial needed.'); return 0; }
    out(`Guidance changed: ${d.files.join(', ')}: ${d.words} words (a trial is needed from ${min}).`);
    if (passed) { out('A passing trial is recorded for this exact text.'); return 0; }
    if (!needed) { out('Below the size that needs a trial.'); return 0; }
    const branch = (git(cwd, ['branch', '--show-current']) || '').trim();
    out(`Trial needed.\n${recipe(d, branch)}`);
    return 0;
  }
  if (a.cmd === 'record') {
    let sessions;
    try {
      sessions = a.fromJson.map((f) => trialSession(JSON.parse(fs.readFileSync(f, 'utf8'))));
    } catch (e) { err(`rule-trial: ${e.message}`); return 1; }
    const r = buildRecord({ cwd, base: a.base, src: a.src, sessions, verdict: a.verdict, note: a.note });
    if (r.error) { err(`rule-trial: refused: ${r.error}`); return 1; }
    fs.appendFileSync(path.join(canonicalRoot(cwd), LEDGER), JSON.stringify(r.row) + '\n');
    out(`recorded ${r.row.verdict} for guidance text ${r.row.hash} (${r.row.sessions.join(', ')}) in ${LEDGER}`);
    return 0;
  }
  err('usage: rule-trial.mjs status | record --from-json <file> --verdict pass|fail --note "..."');
  return 1;
}

if (isMainModule(import.meta.url)) {
  const { exitFlushed } = createRequire(import.meta.url)('./exit-flushed.js');
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) { console.error(`rule-trial: ${e.stack || e.message}`); code = 1; }
  exitFlushed(code);
}
