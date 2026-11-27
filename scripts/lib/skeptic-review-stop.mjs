#!/usr/bin/env node
// BRO-7839: at session close, ask the owner's question for them. The owner ended most code sessions with "is this
// fully tested?", and most sessions then admitted gaps and found real bugs. The other Stop gates check that SOMETHING
// ran (live-run-stop, review-coverage); none asks whether the RIGHT things were tested.
//
// When a cloud session that edited code in this chunk of work claims SAFE TO ARCHIVE (or defers proof to a later run),
// a separate model that did not do the work reads what the session changed and what it ran, and answers: "Is this
// fully tested? List each thing that is untested or could still be broken, and the exact check that would prove it."
// Material gaps block the close with that list; the session runs each check or states a concrete reason it cannot
// (sends real email, spends real money, needs the owner's device). The next close re-asks with the previous list.
// A chunk the reviewer passed is not re-asked until new code edits happen.
//
// Input is built from the transcript alone (buildReviewInput), so scripts/lib/skeptic-review-replay.mjs runs the same
// review on past sessions. Secrets are redacted before anything leaves the container (redact()).
// Reviewer: OpenAI (the key cloud containers have), model pin GPT54_MINI, 25s cap, spend metered by the
// install() fetch meter, pointed at the session ledger (meterToSessionLedger). Any error, timeout or missing key allows (fails open).
//
// Rollout (CLAUDE.md rule 19, same shape as live-run-stop): one block per chunk until SKEPTIC_BLOCKING_FROM, then up
// to MAX_ROUNDS. Every decision goes to .cache/skeptic-review-stop.log (`--digest` counts them).
// Bypass: NO-SKEPTIC: <15+ chars> (a schedule-only reason is refused). Kill switch SKEPTIC_REVIEW_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh as [VE:SKEPTIC]; pinned by skeptic-review-stop.test.mjs.
import './llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043); main() points it at the session ledger
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { claimsSafeToArchive, runShellCode, lastAcceptedClaimIndex, landedPushIndices, findSessionTranscript, isSkepticReviewCall, SKEPTIC_VERDICT_RE, evaluateCoverage } from './review-coverage.mjs';
import { shellEditsCode, editPathText } from './retro-coverage-stop.mjs';
import { defersProof } from './live-run-stop.mjs';
import { answerTexts } from './root-cause-stop.mjs';
import { isMainModule } from './is-main-module.mjs';

const require = createRequire(import.meta.url);
const { GPT54_MINI } = require('./models.js');

export const SKEPTIC_BLOCKING_FROM = '2026-11-25';
export const MAX_ROUNDS = 3;
export const REVIEW_TIMEOUT_MS = 25000;
export const REVIEW_MODEL = GPT54_MINI;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CODE_EXT_RE = /\.(?:m?[jt]sx?|cjs|sh|py|ya?ml|sql)$/;
const CODE_DIR_RE = /^(?:src|scripts|\.github|\.claude\/(?:hooks|commands|skills|agents)|supabase|tests)\//;
const NO_SKEPTIC_RE = /^[ \t>*_-]*NO-SKEPTIC(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(\S.{14,})$/im;
// One definition of an acceptable "cannot run here" reason, shared with the per-gap answer check (BRO-7872).
const { SCHEDULE_ONLY_REASON_RE, REAL_COST_REASON_RE, answerInstructions } = require('./skeptic-gap-answers.js');
const CAPS = { edits: 14000, perSnippet: 700, commands: 45, cmd: 300, tail: 300, notes: 2500, claim: 3000 };

/** Repo-relative path ('' when outside the repo or a worktree of it). */
export function repoPath(p) {
  const s = String(p || '');
  if (/\/\.claude\/projects\/|\/scratchpad\//.test(s) || /^\/tmp\//.test(s)) return '';
  const wt = s.match(/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (wt) return wt[1];
  const m = s.match(/^\/(?:home\/user|repo|workspace)\/Broadwayscore\/(.*)$/i);
  if (m) return m[1];
  return /^\//.test(s) ? '' : s.replace(/^\.\//, '');
}

const isCodePath = (rel) => !!rel && CODE_DIR_RE.test(rel) && CODE_EXT_RE.test(rel);

/** PURE. Indices of events after `from` that edit tracked code (tool edits to code paths, or shell writes). */
export function codeEditIndices(events, from) {
  const out = [];
  events.forEach((e, i) => {
    if (i <= from || e.kind !== 'assistant_tool_use') return;
    if (EDIT_TOOLS.has(e.name) && isCodePath(repoPath(e.input?.file_path || e.input?.notebook_path))) out.push(i);
    else if (e.name === 'Bash' && shellEditsCode(e.input?.command)) out.push(i);
  });
  return out;
}

const SECRET_RES = [
  [/\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,})/g, '[REDACTED_KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_GH_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED_KEY]'],
  [/\b(?:lin_api|re|xoxb|xoxp)_[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=(?!\$)[^\s'"]{6,}/g, '$1=[REDACTED]'],
  [/\b([A-Za-z][A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))(["']?\s*[:=]\s*["']?)(?!\$)[^\s'",]{6,}/gi, '$1$2[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
];
/** PURE. Strip secrets and personal data from text sent to the reviewer. */
export function redact(text) {
  let s = String(text ?? '');
  for (const [re, rep] of SECRET_RES) s = s.replace(re, rep);
  return s;
}

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + ' …[cut]' : t; };
const tailOf = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? '…' + t.slice(-n) : t; };
const resultText = (r) => (!r ? '' : typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? ''));
// Review texts are copyrighted and live in private repos (CLAUDE.md section 11): never ship their content out.
const PRIVATE_SOURCE_RE = /review-texts|broadway-review-texts|aggregator-archive/;

/**
 * PURE. What the reviewer sees, from the transcript events after `from` plus the claim being judged.
 * -> { files, edits, commands, notes, claim, previousGaps }
 */
export function buildReviewInput(events, from, lastMessage, previousGaps = []) {
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const files = new Set();
  const edits = [];
  const commands = [];
  const notes = [];
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'assistant_text' && e.text && e.text !== lastMessage) notes.push(e.text);
    if (e.kind !== 'assistant_tool_use') continue;
    const r = answers.get(e.id);
    if (EDIT_TOOLS.has(e.name)) {
      const rel = repoPath(e.input?.file_path || e.input?.notebook_path);
      if (!rel || !isCodePath(rel)) continue;
      files.add(rel);
      if (e.name === 'Write') edits.push(`WRITE ${rel}\n${clip(e.input?.content, CAPS.perSnippet)}`);
      else if (e.name === 'MultiEdit') for (const m of e.input?.edits || []) edits.push(`EDIT ${rel}\n- ${clip(m.old_string, CAPS.perSnippet / 2)}\n+ ${clip(m.new_string, CAPS.perSnippet)}`);
      else edits.push(`EDIT ${rel}\n- ${clip(e.input?.old_string, CAPS.perSnippet / 2)}\n+ ${clip(e.input?.new_string, CAPS.perSnippet)}`);
    } else if (e.name === 'Bash') {
      const cmd = String(e.input?.command || '');
      if (shellEditsCode(cmd)) {
        for (const m of editPathText(cmd).matchAll(/(?:^|[\s'"=(/])((?:src|scripts|\.github|\.claude\/hooks|supabase|tests)\/[\w./-]+)/g)) if (isCodePath(m[1])) files.add(m[1]);
        edits.push(`SHELL EDIT\n${clip(cmd, CAPS.perSnippet)}`);
      }
      const out = PRIVATE_SOURCE_RE.test(cmd) ? '[private review text omitted]' : tailOf(resultText(r), CAPS.tail);
      commands.push({ cmd: clip(cmd.replace(/\s+/g, ' '), CAPS.cmd), ok: r ? !r.isError : null, tail: out });
    } else if (/^mcp__github__actions_|^mcp__github__get_job_logs|^Skill$|^Agent$/.test(e.name || '')) {
      const arg = e.name === 'Skill' ? e.input?.skill : e.name === 'Agent' ? e.input?.description : (e.input?.workflow_id || e.input?.method || '');
      commands.push({ cmd: `[${e.name}] ${clip(arg, 120)}`, ok: r ? !r.isError : null, tail: tailOf(resultText(r), 160) });
    }
  }
  // Newest edits matter most when the cap bites; keep the order they happened in.
  const keptEdits = [];
  let budget = CAPS.edits;
  for (let k = edits.length - 1; k >= 0 && budget > 0; k--) { keptEdits.unshift(edits[k]); budget -= edits[k].length; }
  return {
    files: [...files],
    edits: keptEdits.map(redact),
    omittedEdits: edits.length - keptEdits.length,
    commands: commands.slice(-CAPS.commands).map((c) => ({ ...c, cmd: redact(c.cmd), tail: redact(c.tail) })),
    omittedCommands: Math.max(0, commands.length - CAPS.commands),
    notes: redact(tailOf(notes.join('\n---\n'), CAPS.notes)),
    claim: redact(clip(lastMessage, CAPS.claim)),
    previousGaps,
  };
}

export const SYSTEM_PROMPT = [
  'You are a skeptical senior engineer reviewing work another engineer (an AI coding session) just called done.',
  'The project owner is not technical. At the end of every session they ask one question, and most of the time the honest answer has been "no" and real bugs turned up only because they asked:',
  '"Is this fully tested? What is untested or could still be broken?"',
  'Answer that question for them, from the evidence below: the code changes, every command the session ran (with whether it succeeded and its output tail), and its closing message.',
  'A gap is MATERIAL when real behaviour could still be broken and nothing in the commands shows it works. Typical material gaps:',
  '- a changed code path never executed on real data (only unit tests with fixtures, or only syntax/type checks, or tests that mock the changed part);',
  '- the real entry point never exercised: the workflow/cron/hook/page/CLI that runs the changed code in production;',
  '- a claim in the closing message ("verified", "works", "fixed", numbers) with no command output behind it;',
  '- other callers or data affected by the change but never checked; a deploy/land/migration that was pushed but never confirmed;',
  '- an edge case the diff itself makes likely (empty input, missing field, second run, failure path, concurrency) with no test.',
  'NOT gaps: anything a command above already ran successfully and whose output shows it worked; style or refactors; tests for code that did not change;',
  'anything the session explicitly gave a concrete reason it cannot run here (it would send real email to people, spend real money in bulk, or needs the owner\'s own device). A vague reason ("will know tomorrow", "runs on cron") is NOT a reason: the gap stays.',
  'If PREVIOUS GAPS are listed, the session was already asked once: mark each closed only if a later command or concrete reason covers it, and do not invent new minor gaps to keep blocking.',
  'Be specific to THIS change. Each check must be one exact command or concrete action the session can run now in its container. At most 6 gaps, most important first.',
  'Reply with JSON only: {"verdict":"fully_tested"|"gaps","gaps":[{"what":"<what is untested or could be broken, one sentence>","why":"<why it could break, one sentence>","check":"<exact command or check that would prove it>","severity":"material"|"minor"}]}',
].join('\n');

/** PURE. The user message for the reviewer. */
export function reviewPrompt(input) {
  const parts = [];
  parts.push(`FILES CHANGED (${input.files.length}): ${input.files.join(', ') || '(none listed)'}`);
  parts.push(`CODE CHANGES${input.omittedEdits ? ` (oldest ${input.omittedEdits} omitted)` : ''}:\n${input.edits.join('\n\n') || '(none)'}`);
  parts.push(`COMMANDS RUN, in order${input.omittedCommands ? ` (oldest ${input.omittedCommands} omitted)` : ''}:\n` + (input.commands.map((c, i) => `${i + 1}. [${c.ok === false ? 'FAILED' : c.ok ? 'ok' : '?'}] ${c.cmd}${c.tail ? `\n   output: ${c.tail.replace(/\n/g, ' ⏎ ')}` : ''}`).join('\n') || '(none)'));
  if (input.notes) parts.push(`SESSION NOTES (its own words while working):\n${input.notes}`);
  if (input.previousGaps?.length) parts.push(`PREVIOUS GAPS (asked at the last close attempt):\n${input.previousGaps.map((g, i) => `${i + 1}. ${g.what} -> check: ${g.check}`).join('\n')}`);
  parts.push(`CLOSING MESSAGE:\n${input.claim}`);
  return parts.join('\n\n');
}

/** PURE. Parse the reviewer reply. -> { gaps: [{what, why, check, severity}] } | { error } */
export function parseGaps(text) {
  let j;
  try { j = JSON.parse(String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { error: 'reviewer reply was not JSON' }; }
  if (!j || !Array.isArray(j.gaps)) return { error: 'reviewer reply had no gaps array' };
  const gaps = j.gaps
    .filter((g) => g && typeof g.what === 'string' && g.what.trim())
    .map((g) => ({ what: g.what.trim(), why: String(g.why || '').trim(), check: String(g.check || '').trim(), severity: g.severity === 'minor' ? 'minor' : 'material' }))
    .slice(0, 6);
  return { gaps };
}

/** Ask the reviewer. fetchImpl injectable for tests. -> { gaps, usage } | { error } */
export async function callReviewer(input, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = REVIEW_TIMEOUT_MS, model = REVIEW_MODEL } = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) return { error: 'no OPENAI_API_KEY' };
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: reviewPrompt(input) }],
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' },
  };
  if (/^gpt-5/.test(model)) body.reasoning_effort = 'low';
  let res;
  try {
    res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { return { error: `reviewer call failed: ${e && e.name === 'TimeoutError' ? 'timeout' : e && e.message}` }; }
  let json;
  try { json = await res.json(); } catch { return { error: `reviewer HTTP ${res.status}, unreadable body` }; }
  if (!res.ok) return { error: `reviewer HTTP ${res.status}: ${clip(json?.error?.message, 160)}` };
  const parsed = parseGaps(json?.choices?.[0]?.message?.content);
  return parsed.error ? parsed : { gaps: parsed.gaps, usage: json.usage || null };
}

/**
 * Spend goes through the install() fetch meter (one count per call). This runs as a Stop hook in a session checkout,
 * where the committed ledger must stay untouched (CI owns it), so point the meter at the session ledger, which is
 * the tracked ledger again under GITHUB_ACTIONS or a test run. Call before the first reviewer request.
 */
export function meterToSessionLedger(env = process.env) {
  try {
    const ledger = require('./gemini-usage-ledger.js');
    ledger.setSessionUsageCaller('skeptic-review-stop');
    if (!env.GEMINI_USAGE_LEDGER_PATH) env.GEMINI_USAGE_LEDGER_PATH = ledger.sessionLedgerPath();
  } catch { /* record only */ }
}

/** PURE. Does an accepted NO-SKEPTIC bypass appear in this chunk (or the claim)? */
export function bypassReason(events, from, lastMessage) {
  for (const t of answerTexts(events.slice(from + 1), lastMessage)) {
    const m = NO_SKEPTIC_RE.exec(String(t));
    if (m && (!SCHEDULE_ONLY_REASON_RE.test(m[1]) || REAL_COST_REASON_RE.test(m[1]))) return m[1].trim();
  }
  return null;
}

/**
 * PURE Stop-hook pre-decision (no network). -> { decision: 'allow', reason } | { decision: 'review', chunkKey, editKey, from }
 * chunkKey (budget) = the last accepted SAFE TO ARCHIVE claim before this chunk, so fixes made in reply to a block do
 * not reset the budget. editKey (pass cache) = the last code edit: a passed chunk is re-asked only after new edits.
 */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.SKEPTIC_REVIEW_STOP_DISABLE === '1') return { decision: 'allow', reason: 'SKEPTIC_REVIEW_STOP_DISABLE=1' };
  if (!claimsSafeToArchive(lastMessage) && !defersProof(lastMessage)) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE or deferring proof' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  const from = lastAcceptedClaimIndex(events, lastMessage);
  const edits = codeEditIndices(events, from);
  if (!edits.length) return { decision: 'allow', reason: 'no code edits in this chunk' };
  // Backstop only (BRO-7839): /ship-check runs this same reviewer in Phase 5. If it ran after the last code edit, the
  // gaps were already in front of the session before landing; do not pay for a second read at close.
  const shipCheckReview = lastSkepticShipCheckIndex(events);
  const by = bypassReason(events, from, lastMessage);
  if (by) return { decision: 'allow', reason: `NO-SKEPTIC bypass: ${by.slice(0, 120)}`, bypass: true };
  const key = (i) => (i < 0 ? 'start' : String(events[i].id || events[i].messageId || events[i].ts || i));
  if (shipCheckReview > edits[edits.length - 1]) {
    // BRO-7872: the ship-check list was in front of the session, but a list nobody answered is not a review. This is the
    // last Stop gate, so it is reached on the close every other gate accepts, even after review-coverage's own block
    // budget ran out (3FKM's final close went through that way). No reviewer call: the gaps are already listed.
    const unanswered = evaluateCoverage(events, { lastMessage, env }).unansweredGaps || [];
    if (unanswered.length) return { decision: 'unanswered', unanswered, from, chunkKey: key(from), editKey: `${key(edits[edits.length - 1])}:answers` };
    return { decision: 'allow', reason: 'ship-check skeptic review ran after the last code edit; no unanswered gaps after the last /ship-check' };
  }
  return { decision: 'review', from, chunkKey: key(from), editKey: key(edits[edits.length - 1]) };
}

/** PURE. Index of the last answered `skeptic-review-stop.mjs --ship-check` run that printed its verdict, else -1. */
export function lastSkepticShipCheckIndex(events) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  let at = -1;
  events.forEach((e, i) => {
    if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash' || !isSkepticReviewCall(String(e.input?.command || ''))) return;
    const r = results.get(e.id);
    if (r && !r.isError && SKEPTIC_VERDICT_RE.test(String(r.content || ''))) at = i;
  });
  return at;
}

/** PURE. The ship-check report: the verdict line review-coverage.mjs looks for, then each gap and its check. */
export function shipCheckReport(r) {
  if (r.error) return `SKEPTIC REVIEW UNAVAILABLE (${r.error}); this does not count as a review. Ask yourself the owner's question by hand: "Is this fully tested? What is untested or could still be broken?" and run what that names.`;
  const material = r.gaps.filter((g) => g.severity === 'material');
  const minor = r.gaps.filter((g) => g.severity !== 'material');
  const fmt = (g, i) => `${i + 1}. ${g.what}${g.why ? ` (${g.why})` : ''}\n   check: ${g.check || '(name one)'}`;
  return [
    material.length ? `SKEPTIC REVIEW: ${material.length} material gap(s). Before recording the ship-check, answer EACH gap as "GAP <n>: ran <the command>" (it must have run and passed), "GAP <n>: cannot run here: <concrete reason>", or "GAP <n>: not a gap: <why>", passed to the record command: node scripts/lib/review-coverage.mjs --record --answer='GAP 1: ...' (chat text can be missing from the transcript). --record refuses a pass while any gap is unanswered (BRO-7872).` : 'SKEPTIC REVIEW: no material gaps.',
    ...material.map(fmt),
    ...(minor.length ? ['Minor (optional):', ...minor.map(fmt)] : []),
  ].join('\n');
}

export function roundBudget(now = new Date()) {
  return now.toISOString().slice(0, 10) >= SKEPTIC_BLOCKING_FROM ? MAX_ROUNDS : 1;
}

export function blockMessage(gaps, { round, budget }) {
  const lines = gaps.map((g, i) => `${i + 1}. ${g.what}${g.why ? ` (${g.why})` : ''}\n   check: ${g.check || '(name one)'}`);
  return [
    `BLOCKED (BRO-7839, skeptic review ${round}/${budget}): an independent reviewer asked the owner's question, "Is this fully tested? What is untested or could still be broken?", and found:`,
    ...lines,
    'Run each check now and fix what it shows. If one truly cannot run here (it would send real email to people, spend real money in bulk, or needs the owner\'s device), say so in one line naming that gap and the reason. "We will know after the next scheduled run" is not a reason.',
    'Then close again; the reviewer re-reads the new evidence. A wrong gap: say why in one line, it is judged on the next close. Last resort: NO-SKEPTIC: <15+ chars on why> (logged and counted).',
  ].join('\n');
}

// ------------------------------------------------------------------ IO (state, log, CLI)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Canonical (main-checkout) root, so a worktree session's rows land where health-check.js reads them (BRO-7843).
function canonicalRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) return path.dirname(path.isAbsolute(common) ? common : path.join(ROOT, common));
  } catch { /* fall back to this checkout */ }
  return ROOT;
}
const LOG = path.join(canonicalRoot(), '.cache', 'skeptic-review-stop.log');
const stateFile = (tp, chunkKey) => path.join(os.tmpdir(), `skeptic-review-${createHash('sha1').update(tp + '\u0000' + chunkKey).digest('hex').slice(0, 12)}.json`);
function readState(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { rounds: 0, passedEditKey: null, lastGaps: [] }; } }
function writeState(f, s) { try { fs.writeFileSync(f, JSON.stringify(s)); } catch { /* best effort */ } }
let logPath = LOG;
function logHit(entry) {
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ }
}

/** PURE. Counts over the decision log rows (shared with the daily digest: skeptic-review-digest.js). */
export function digest(rows) { return require('./skeptic-review-digest.js').countSkepticRows(rows); }

export async function main(argv, { env = process.env, now = new Date(), stdin = null, fetchImpl = globalThis.fetch } = {}) {
  logPath = env.SKEPTIC_REVIEW_LOG || LOG;
  if (env === process.env) meterToSessionLedger();
  if (argv.includes('--digest')) {
    let rows = [];
    try { rows = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* empty */ }
    process.stdout.write(JSON.stringify(digest(rows)) + '\n');
    return 0;
  }
  if (argv.includes('--ship-check')) {
    // /ship-check Phase 5 (BRO-7839): the same reviewer over the work since the last landed push, read from this
    // session's own transcript. Always exit 0: the gaps are findings for ship-check to fix, not a hook decision.
    const tArg = argv.find((a) => a.startsWith('--transcript='))?.slice(13);
    const tp = tArg || findSessionTranscript(env.CLAUDE_CODE_SESSION_ID);
    if (!tp || !fs.existsSync(tp)) { process.stdout.write(shipCheckReport({ error: 'session transcript not found (pass --transcript=<path>)' }) + '\n'); return 0; }
    if (tArg && env.CLAUDE_CODE_SESSION_ID && !tArg.includes(env.CLAUDE_CODE_SESSION_ID)) { process.stdout.write(shipCheckReport({ error: '--transcript is not this session\'s transcript' }) + '\n'); return 0; }
    const events = walkTranscript(tp);
    if (!events.length) { process.stdout.write(shipCheckReport({ error: 'transcript has no events' }) + '\n'); return 0; }
    const landed = landedPushIndices(events);
    const from = landed.length ? landed[landed.length - 1] : -1;
    const texts = events.filter((e) => e.kind === 'assistant_text');
    const claim = texts.length ? String(texts[texts.length - 1].text || '') : '';
    const reviewInput = buildReviewInput(events, from, claim, []);
    if (!reviewInput.files.length && !reviewInput.edits.length) { process.stdout.write('SKEPTIC REVIEW: no material gaps. (No code edits since the last landed push.)\n'); return 0; }
    const r = await callReviewer(reviewInput, { env, fetchImpl, timeoutMs: 60000 });
    logHit({ session: env.CLAUDE_CODE_SESSION_ID || null, outcome: 'ship-check', ...(r.error ? { reason: r.error } : { gaps: r.gaps, usage: r.usage }), files: reviewInput.files.length, commands: reviewInput.commands.length });
    process.stdout.write(shipCheckReport(r) + '\n');
    return 0;
  }
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: skeptic-review-stop.mjs --stop-hook (Stop hook JSON on stdin) | --ship-check [--transcript=<path>] | --digest\n'); return 0; }
  let input = {};
  try { input = JSON.parse(stdin ?? fs.readFileSync(0, 'utf8') ?? '{}'); } catch { return 0; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const lastMessage = input.last_assistant_message || '';
  const events = walkTranscript(tp);
  const d = stopHookDecision({ lastMessage, events, env });
  const session = input.session_id || null;
  if (d.bypass) logHit({ session, outcome: 'bypass', reason: d.reason });
  if (d.decision === 'unanswered') {
    // Same per-chunk round budget as a review, so an unanswerable list can never loop a session.
    const f = stateFile(tp, d.chunkKey);
    const st = readState(f);
    const budget = roundBudget(now);
    const base = { session, chunk: d.chunkKey, round: st.rounds + 1, budget, unanswered: d.unanswered.map((g) => g.n) };
    if (st.rounds >= budget) { logHit({ ...base, outcome: 'over-budget', blocked: false, reason: 'ship-check gaps unanswered' }); return 0; }
    writeState(f, { ...st, rounds: st.rounds + 1, lastReviewedEditKey: d.editKey });
    logHit({ ...base, outcome: 'block', blocked: true, reason: 'ship-check gaps unanswered' });
    process.stderr.write([`BLOCKED (BRO-7872, skeptic review ${st.rounds + 1}/${budget}): the ship-check skeptic reviewer listed gaps that still have no answer:`, answerInstructions(d.unanswered), 'Last resort: NO-SKEPTIC: <15+ chars on why> (logged and counted).'].join('\n') + '\n');
    return 2;
  }
  if (d.decision !== 'review') return 0;
  const f = stateFile(tp, d.chunkKey);
  const st = readState(f);
  // Budget and pass cache are checked before any network call: an exhausted or passed chunk costs nothing.
  if (st.passedEditKey === d.editKey) return 0;
  const budget = roundBudget(now);
  if (st.rounds >= budget && st.lastReviewedEditKey === d.editKey) return 0;
  // BRO-7872: with no earlier Stop round, the ship-check list still unanswered is what the reviewer re-checks.
  const previous = st.lastGaps?.length ? st.lastGaps : (evaluateCoverage(events, { lastMessage, env }).unansweredGaps || []).map((g) => ({ what: g.what, check: g.check }));
  const reviewInput = buildReviewInput(events, d.from, lastMessage, previous);
  const r = await callReviewer(reviewInput, { env, fetchImpl });
  if (r.error) { logHit({ session, chunk: d.chunkKey, outcome: 'error', reason: r.error }); return 0; }
  const material = r.gaps.filter((g) => g.severity === 'material');
  const base = { session, chunk: d.chunkKey, round: st.rounds + 1, budget, files: reviewInput.files.length, commands: reviewInput.commands.length, gaps: r.gaps, usage: r.usage };
  if (!material.length) {
    writeState(f, { ...st, passedEditKey: d.editKey, lastGaps: [] });
    logHit({ ...base, outcome: 'pass' });
    return 0;
  }
  if (st.rounds >= budget) {
    // Out of rounds: record what it would have said (the advisory signal), never block.
    writeState(f, { ...st, lastReviewedEditKey: d.editKey, lastGaps: material });
    logHit({ ...base, outcome: 'over-budget', blocked: false });
    return 0;
  }
  writeState(f, { ...st, rounds: st.rounds + 1, lastReviewedEditKey: d.editKey, lastGaps: material });
  logHit({ ...base, outcome: 'block', blocked: true });
  process.stderr.write(blockMessage(material, { round: st.rounds + 1, budget }) + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`skeptic-review-stop: internal error (failing open): ${e && e.message}\n`); process.exitCode = 0; });
}
