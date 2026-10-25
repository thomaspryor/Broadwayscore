#!/usr/bin/env node
// scripts/lib/review-coverage.mjs (BRO-5359) — did a /ship-check (or /code-review)
// really run, or only get invoked? Sessions were calling the Skill and then
// running one cheap reviewer, after the code had already landed. The Stop
// hook only saw "a Skill call exists", and land/* pushes were never gated, so
// nothing could tell a reduced run from a full one.
//
// This lib reads the session transcript and answers one question: after the
// last real ship-check/code-review run, did the reviewers the skill requires
// actually get launched? Required (cloud profile, see .claude/commands/ship-check.md):
//   1. a Claude codebase review: an Agent call (review-panelist preferred; some containers lack that
//      type and sessions fall back to general-purpose, so any subagent type counts) with a real
//      review prompt
//   2. an external adversarial review: curl to api.openai.com / Gemini, or `codex exec`
// tsc/lint/build are NOT checked here: land.yml runs them strictly on the rebased tree.
// Known limits (accepted, BRO-5359 ship-check): this sets a floor, not proof of review quality;
// coverage is not tied to the pushed diff hash (verify-edits.sh's fixup budget covers edits made
// after the review); /code-review runs are trusted, not coverage-checked. Heredoc bodies are data
// (BRO-5430), so a review run as `bash <<EOF ... curl ... EOF`, or written to a script by a heredoc
// and run in the same command, does not count; the ship-check recipe keeps curl/codex outside it.
//
// One implementation for both enforcement points:
//   - land gate:   land-preflight.mjs runHook -> landGateDecision (blocks a land/* push)
//   - Stop hook:   verify-edits.sh (the Stop hook wired in EVERY cloud container) pipes its input to `--stop-hook`;
//                  a final 'SAFE TO EXIT' after a hollow ship-check is refused. A separate new hook would only
//                  reach containers whose cached setup was built after it landed, and a hooks/lib one is never
//                  wired at all (scripts/install-home-claude-config.js wires only .claude/hooks/<name>.sh).
//
// Rules (cloud only, CLAUDE_CODE_REMOTE=true):
//   land gate  - a `git push ... land/*` over 30 gated lines needs complete ship-check coverage, plus
//                `npm run build` when the diff touches src/. Bypass: `# NO-SHIP-CHECK: <15+ chars>` inside
//                the push command. Kill switches: SHIP_CHECK_LAND_GATE_DISABLE=1; LAND_PREFLIGHT_DISABLE=1
//                turns off the whole land hook. Events are logged to .claude/land-preflight.jsonl.
//   Stop hook  - for a session with a /ship-check run: reviewers ran; /did-it-work printed its TESTED
//                block; /what-else printed 5 ordered LENSES lines and searched the Linear board; the Linear Done close-out came after the last land push.
//                Bypass lines in the closing message: NO-SHIP-CHECK / NO-DID-IT-WORK / NO-WHAT-ELSE /
//                NO-WRAP-UP: <reason, 10+ chars>, each waiving only its own check. Kill switch
//                SHIP_CHECK_COVERAGE_DISABLE=1. Blocks at most 3 times per session.
// and it produces the evidence BRO-4277 wanted (`--record`), so a pass verdict is only
// written when coverage is complete.
//
// CLI:
//   node scripts/lib/review-coverage.mjs --transcript=<path> [--json]
//   node scripts/lib/review-coverage.mjs --record [--transcript=<path>]   (session transcript auto-found)
//   node scripts/lib/review-coverage.mjs --stop-hook          (Stop hook JSON on stdin; exit 2 blocks)
// Exit: 0 complete, 3 incomplete, 2 transcript not found. Fails open (exit 0) on internal error
// for hook use (--json, --stop-hook), never for --record.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { walkTranscript } from './transcript-scan.mjs';

const { stripHeredocBodies } = createRequire(import.meta.url)('./infra-review-scope.js');

export const STRONG_SKILLS = ['ship-check', 'code-review'];
// By-hand fallback when the Skill call fails with "Unknown skill" (BRO-5068):
// reading the command file after the failure counts as the run (mirrors verify-edits.sh).
const FALLBACK_FILES = {
  'ship-check': ['.claude/commands/ship-check.md', '.agents/skills/ship-check/SKILL.md'],
};
// A real external review POSTs a prompt: curl with a request body to a model endpoint, or `codex exec`,
// in command position. Not `echo curl api.openai.com`, not `curl .../v1/models`, not a grep for the host.
const MODEL_ENDPOINT_RE = /api\.openai\.com\/v1\/(?:chat\/completions|responses)|generativelanguage\.googleapis\.com\/\S*:generateContent/;
const DATA_FLAG_RE = /\s(?:-d|--data(?:-[a-z]+)?|--json)\b/;
const cmdPos = (word) => new RegExp(`(?:^|[;&|(\\n]|\\$\\()\\s*(?:\\w+=\\S*\\s+)*${word}\\b`);
const CURL_POS_RE = cmdPos('curl');
const CODEX_POS_RE = cmdPos('codex\\s+exec');
// The shell code a command runs, for "is X in command position" checks: heredoc bodies and quoted
// strings blanked in ONE pass (BRO-5430). Two passes ('...' first) let an apostrophe in prose
// ("what's", in a heredoc prompt or a double-quoted string) pair with a later quote and erase a
// real `$(curl`; heredoc text is data, so a curl line inside one is not a call.
const shellCode = (cmd) => stripHeredocBodies(cmd).replace(/'[^']*'|"[^"]*"/g, '""');
const BUILD_RE = /(?:^|[;&|(\n]|\$\()\s*(?:\w+=\S*\s+|time\s+|timeout\s+\S+\s+)*(?:npm\s+run\s+build|npx\s+next\s+build|next\s+build)\b/;
const SHELL_C_BUILD_RE = /^\s*(?:ba)?sh\s+-l?c\s[\s\S]*\b(?:npm\s+run\s+build|next\s+build)\b/;
const MIN_PANELIST_PROMPT = 200; // chars: "say ok" is not a review
const MIN_RESULT_CHARS = 40;
const isExternalReviewCall = (cmd) => {
  const code = shellCode(cmd);
  // The URL is often quoted, so endpoint and body flag read the command with quotes kept, heredoc text out.
  const visible = stripHeredocBodies(cmd);
  return (CURL_POS_RE.test(code) && MODEL_ENDPOINT_RE.test(visible) && DATA_FLAG_RE.test(visible)) || CODEX_POS_RE.test(code);
};
const substantiveResult = (r) => !!r && !r.isError && String(r.content || '').trim().length >= MIN_RESULT_CHARS && !/"error"\s*:/.test(String(r.content));
export const NO_SHIP_CHECK_RE = /#\s*NO-SHIP-CHECK:\s*(\S.{14,})/;

const skillName = (s) => String(s || '').split(':').pop().replace(/^\//, '');

/** Indices (into events) of real ship-check/code-review runs, with the skill name. */
export function findRuns(events, skills = STRONG_SKILLS) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  const runs = [];
  const failed = new Set();
  events.forEach((e, i) => {
    if (e.kind === 'user_text') {
      const m = /<command-name>\/?([a-z-]+)<\/command-name>/.exec(e.text || '');
      if (m && skills.includes(m[1])) runs.push({ i, skill: m[1], id: `typed-${i}` });
    } else if (e.kind === 'assistant_tool_use' && e.name === 'Skill') {
      const sk = skillName(e.input?.skill);
      if (!skills.includes(sk)) return;
      const r = results.get(e.id);
      if (r && (r.isError || /unknown skill/i.test(r.content || ''))) failed.add(sk);
      else runs.push({ i, skill: sk, id: e.id });
    } else if (e.kind === 'assistant_tool_use' && (e.name === 'Read' || e.name === 'Bash') && failed.size) {
      const target = e.name === 'Read' ? e.input?.file_path || '' : String(e.input?.command || '');
      for (const sk of [...failed]) {
        const files = FALLBACK_FILES[sk] || [`.claude/commands/${sk}.md`, `.agents/skills/${sk}/SKILL.md`];
        if (files.some((f) => target.endsWith(f) || target.includes(f))) {
          runs.push({ i, skill: sk, id: e.id });
          failed.delete(sk);
        }
      }
    }
  });
  return runs;
}

/**
 * Coverage after the last strong review run in the session.
 * -> { ran, complete, skill, missing: string[], evidence|null }
 */
export function evaluateCoverage(events, { requireBuild = false } = {}) {
  const runs = findRuns(events);
  if (runs.length === 0) {
    return { ran: false, complete: false, skill: null, missing: ['no /ship-check or /code-review run in this session'], evidence: null };
  }
  const last = runs[runs.length - 1];
  // /code-review has its own procedure (it never launches these reviewers), so it is not
  // coverage-checked; verify-edits.sh already accepts it as a strong review. A later
  // /code-review therefore also covers an earlier thin ship-check.
  if (last.skill !== 'ship-check') return { ran: true, complete: true, skill: last.skill, missing: [], evidence: null };
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  const answered = (id) => {
    const r = results.get(id);
    return !!r && !r.isError;
  };
  const answeredWell = (id) => substantiveResult(results.get(id));
  const claude = [];
  const external = [];
  for (const e of events.slice(last.i + 1)) {
    if (e.kind !== 'assistant_tool_use') continue;
    if (e.name === 'Agent' || e.name === 'Task') {
      if (String(e.input?.prompt || '').length >= MIN_PANELIST_PROMPT && /\b(?:review|audit|adversar\w*)\b/i.test(String(e.input?.prompt)) && answered(e.id)) claude.push(e);
    } else if (e.name === 'Bash' && isExternalReviewCall(String(e.input?.command || '')) && answeredWell(e.id)) {
      external.push(e);
    }
  }
  // land.yml runs tsc + lint but NOT `next build`; a src/ change needs the build run by the session.
  // Any build in the session counts (did-it-work often builds before ship-check is invoked).
  const built = events.some((e) => e.kind === 'assistant_tool_use' && e.name === 'Bash' && answered(e.id) && (BUILD_RE.test(shellCode(String(e.input?.command || ''))) || SHELL_C_BUILD_RE.test(String(e.input?.command || ''))));
  const missing = [];
  if (requireBuild && !built) missing.push('the build (`npm run build`, Phase 2 of ship-check): land.yml does not run it and this diff touches src/');
  if (claude.length === 0) missing.push('Claude codebase review (an Agent call, subagent_type review-panelist, with a real review prompt of 200+ characters)');
  if (external.length === 0) missing.push('external adversarial review (curl -d to api.openai.com /v1/chat/completions, Gemini generateContent, or `codex exec`) with a real response');
  const complete = missing.length === 0;
  let evidence = null;
  if (complete) {
    const h = createHash('sha256');
    for (const e of [...claude, ...external]) h.update(`${e.id}\n${results.get(e.id)?.content || ''}\n`);
    evidence = {
      outputsHash: h.digest('hex'),
      invocationId: String(last.id),
      checks: [`claude-subagent-review x${claude.length}`, `external-review x${external.length}`],
    };
  }
  return { ran: true, complete, skill: last.skill, missing, evidence };
}

/**
 * Pure land-push decision. `gatedLines` = gated diff size of the pushed range.
 * -> { decision: 'allow'|'skip'|'block', reason, message? }
 */
export function landGateDecision({ command = '', events = null, gatedLines = 0, budget = 30, touchesSrc = false, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'skip', reason: 'not a cloud session (the Mac has its own finish-line gate)' };
  if (env.SHIP_CHECK_LAND_GATE_DISABLE === '1') return { decision: 'skip', reason: 'SHIP_CHECK_LAND_GATE_DISABLE=1' };
  const bypass = NO_SHIP_CHECK_RE.exec(command);
  if (bypass) return { decision: 'allow', reason: `NO-SHIP-CHECK bypass: ${bypass[1].trim()}` };
  if (!events || events.length === 0) return { decision: 'skip', reason: 'no transcript to judge (fails open)' };
  if (gatedLines <= budget) return { decision: 'skip', reason: `gated diff is ${gatedLines} lines (<= ${budget})` };
  const cov = evaluateCoverage(events, { requireBuild: touchesSrc });
  if (cov.complete) return { decision: 'allow', reason: `${cov.skill} coverage complete` };
  return {
    decision: 'block',
    reason: 'review coverage incomplete',
    message: [
      `LAND BLOCKED (BRO-5359): this push lands ${gatedLines} lines of code but the session has no complete review yet.`,
      'Missing:',
      ...cov.missing.map((m) => `  - ${m}`),
      'Run the real /ship-check now, before landing: follow its cloud profile (a Claude review Agent AND an external reviewer), fix what it finds, then push again.',
      'land.yml runs tsc and lint on the rebased tree, but NOT the build: a src/ change needs `npm run build` from you. Do not skip the reviewers for that reason.',
      'Only if the review truly cannot run: add `# NO-SHIP-CHECK: <reason, 15+ chars>` to the push command (logged).',
    ].join('\n'),
  };
}


const TESTED_RE = /(?:^|\n)[\s*#>_`=\u2500-\u257f-]*TESTED\b/;
/** Numbers 1-5 found IN ORDER as lines under the LAST `LENSES:` header; items may wrap (max 3 lines between). */
function lensNumbers(text) {
  const lines = String(text).split('\n');
  let best = new Set();
  // Every LENSES: header is tried (a later "LENSES: done" must not hide the real block); the best one counts.
  lines.forEach((l, h) => {
    if (!/^[\s*#>_`-]*LENSES\s*:/i.test(l)) return;
    const found = new Set();
    let want = 1;
    let prev = h;
    for (let i = h + 1; i < Math.min(lines.length, h + 40) && want <= 5; i++) {
      const m = /^[\s*_>`-]*\**\s*([1-5])[.)]\**\s+\S/.exec(lines[i]);
      if (m && Number(m[1]) === want && i - prev <= 4) {
        found.add(m[1]);
        want += 1;
        prev = i;
      } else if (i - prev > 4) {
        break;
      }
    }
    if (found.size > best.size) best = found;
  });
  return best;
}
// The board is Linear. The old GitHub roadmap (issue 1 of broadway-scorecard-data) is retired and no longer counts.
// Command position: line start, after ; & | ( { or a newline, or after a shell keyword (a for/while/if body).
// Run on shellCode() output, so quoted strings and heredoc bodies are already blanked; comments are dropped too.
const BOARD_CMD_POS = String.raw`(?:^|[;&|(\n]|\{\s|\b(?:do|then|else)\s)\s*`;
const boardShell = (cmd) => shellCode(cmd).replace(/(^|\s)#[^\n]*/g, '$1');
const BOARD_READ_RE = new RegExp(`${BOARD_CMD_POS}(?:node\\s+)?\\S*linear-brain\\.js\\s+find\\b|${BOARD_CMD_POS}(?:node\\s+)?\\S*linear-next\\.js\\s+--list\\b`);
// Cloud names the Linear connector's tools mcp__<uuid>__list_issues; GitHub's mcp__github__list_issues must not count.
const BOARD_READ_TOOL_RE = /linear.*__list_issues$|^mcp__[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}__list_issues$/i;
const LINEAR_DONE_RE = /linear-brain\.js\s+update\s+BRO-\d+[^\n]*--state[=\s]+["']?Done|linear-session\.js\s+report\b[^\n]*--status[=\s]+["']?done\b/i;
const LAND_PUSH_RE = /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\bland\//;

/**
 * The rest of the finish chain, checked for substance (BRO-5359 /what-else): the same
 * "invoked but hollow" failure as /ship-check. Only called for a session that did code work
 * (a /ship-check or /code-review run exists). verify-edits.sh already asks for a MISSING
 * /what-else or /wrap-up; this checks what the ones that ran actually did.
 * -> string[] of problems
 */
export function evaluateChain(events, { lastMessage = '' } = {}) {
  const problems = [];
  const bypass = (tok) => new RegExp(`^\\s*${tok}:\\s*(\\S.{9,})`, 'm').test(lastMessage);
  const texts = (from) => events.slice(from + 1).filter((e) => e.kind === 'assistant_text').map((e) => e.text || '').join('\n');

  const dwi = findRuns(events, ['did-it-work']);
  if (!bypass('NO-DID-IT-WORK')) {
    if (dwi.length === 0) problems.push('/did-it-work was never run (it comes before /ship-check: run the real thing against real data)');
    else if (!TESTED_RE.test(texts(dwi[dwi.length - 1].i))) problems.push('/did-it-work printed no TESTED block (real data, 3 diverse cases) after it ran');
  }

  const we = findRuns(events, ['what-else']);
  if (we.length && !bypass('NO-WHAT-ELSE')) {
    const found = lensNumbers(texts(we[we.length - 1].i));
    if (found.size < 5) problems.push(`/what-else printed ${found.size} of 5 numbered lens lines directly under a LENSES: header, each citing a concrete check`);
    const readBoard = events.slice(we[we.length - 1].i + 1).some((e) => e.kind === 'assistant_tool_use' && (
      BOARD_READ_TOOL_RE.test(e.name || '') ||
      (e.name === 'Bash' && BOARD_READ_RE.test(boardShell(String(e.input?.command || ''))))));
    if (!readBoard) problems.push('/what-else never searched the Linear board (after /what-else started: linear-brain.js find, linear-next.js --list, or mcp__Linear__list_issues; the old GitHub roadmap issue and memory/roadmap.md are retired and stale)');
  }

  if (!bypass('NO-WRAP-UP')) {
    let lastLand = -1;
    let lastDone = -1;
    const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
    events.forEach((e, i) => {
      if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash') return;
      const c = String(e.input?.command || '');
      const r = answers.get(e.id);
      // Only a push that really ran counts as a landing: not a dry run, a delete, or one a hook blocked.
      const push = LAND_PUSH_RE.exec(c);
      // Judge the push segment only: `git push … land/x | tail -n 20` must not read as a dry run.
      const segment = push ? c.slice(push.index).split(/[;&|\n]/)[0] : '';
      if (push && r && !r.isError && !/--dry-run|\s-n\s|--delete\b|\s-d\s|\s:(?:refs\/heads\/)?land\//.test(segment)) lastLand = i;
      if (LINEAR_DONE_RE.test(c)) lastDone = i;
    });
    if (lastLand >= 0 && lastDone >= 0 && lastDone < lastLand) problems.push('the Linear close-out was posted before the last landing; post it again now that the landing is verified');
  }
  return problems;
}

const MAX_STOP_BLOCKS = 3;

/**
 * Pure Stop-hook decision. Blocks only a final "SAFE TO ARCHIVE" (legacy "SAFE TO EXIT") message when the session's last
 * /ship-check or /code-review run lacks its reviewers. A session with no strong review run at
 * all is left to verify-edits.sh's chain gate (it asks for the review itself).
 * -> { decision: 'allow'|'block', reason, message? }
 */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.SHIP_CHECK_COVERAGE_DISABLE === '1') return { decision: 'allow', reason: 'SHIP_CHECK_COVERAGE_DISABLE=1' };
  const text = String(lastMessage || '').replace(/```[\s\S]*?```/g, '');
  const lines = text.split('\n').map((l) => l.trim().replace(/^[*_>#\s•-]+/, '').replace(/[*_\s]+$/, '')).filter((l) => l && !/^[-=_*~\s\u2500-\u257f\u2022\u00b7]+$/.test(l));
  // BRO-6020: SAFE TO ARCHIVE is the current claim; legacy SAFE TO EXIT stays an alias.
  if (!lines.length || !/^SAFE TO (?:ARCHIVE|EXIT)\b/.test(lines[lines.length - 1])) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  const cov = evaluateCoverage(events);
  // Only a session that did reviewed code work is held to the rest of the chain.
  const problems = [];
  const noShipCheck = /^\s*NO-SHIP-CHECK:\s*(\S.{9,})/m.test(text);
  if (cov.ran && !cov.complete && !noShipCheck) problems.push(...cov.missing.map((m) => `/${cov.skill} did not run its reviewers: ${m}`));
  // The newest message is not flushed to the transcript when the Stop hook runs (verify-edits.sh
  // has the same note), so add it: a LENSES/TESTED block in the closing message must count.
  // The chain checks apply to sessions that ran /ship-check; a pure /code-review (PR review) is not held to them.
  if (findRuns(events, ['ship-check']).length) problems.push(...evaluateChain([...events, { kind: 'assistant_text', text: String(lastMessage || '') }], { lastMessage: text }));
  if (problems.length === 0) return { decision: 'allow', reason: cov.ran ? 'chain complete' : 'no strong review run' };
  return {
    decision: 'block',
    reason: 'finish chain incomplete',
    message: [
      'BLOCKED (BRO-5359): the finish chain was invoked but not done. A skill call that skips its substance does not count:',
      ...problems.map((m) => `  - ${m}`),
      'Do the missing parts for real (cloud profile in .claude/CLOUD.md), then close out again.',
      'If a step truly cannot run, say why on a line `NO-SHIP-CHECK:` / `NO-DID-IT-WORK:` / `NO-WHAT-ELSE:` / `NO-WRAP-UP: <reason, 10+ chars>` in the closing message.',
    ].join('\n'),
  };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** --stop-hook entry: hook JSON on stdin; exit 2 + stderr blocks. Always fails open. */
function stopHookMain() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return 0;
  }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp) });
  const counter = path.join(os.tmpdir(), `review-coverage-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
  if (d.decision !== 'block') {
    // Coverage is complete (or not claimed): reset the block budget for any later uncovered review.
    if (d.decision === 'allow' && d.reason === 'chain complete') fs.rmSync(counter, { force: true });
    return 0;
  }
  // Cap blocks per transcript so an unsatisfiable gate can never loop a session.
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0;
  } catch { /* first block */ }
  if (n >= MAX_STOP_BLOCKS) return 0;
  try {
    fs.writeFileSync(counter, String(n + 1));
  } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

/** Find this session's transcript (cloud keeps them under ~/.claude/projects/*). */
export function findSessionTranscript(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const root = path.join(home, '.claude', 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main(argv) {
  if (argv.includes('--stop-hook')) return stopHookMain();
  const arg = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const record = argv.includes('--record');
  const transcript = arg('transcript') || findSessionTranscript(process.env.CLAUDE_CODE_SESSION_ID);
  if (!transcript || !fs.existsSync(transcript)) {
    process.stderr.write('review-coverage: transcript not found\n');
    return 2;
  }
  const cov = evaluateCoverage(walkTranscript(transcript));
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(cov) + '\n');
  if (record) {
    if (!cov.complete) {
      process.stderr.write(`review-coverage: NOT recording a pass. Missing:\n${cov.missing.map((m) => `  - ${m}`).join('\n')}\n`);
      return 3;
    }
    const { recordVerdict } = await import('./review-gate.mjs');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const r = recordVerdict({ repoRoot, reviewer: cov.skill, result: 'pass', sessionId: process.env.CLAUDE_CODE_SESSION_ID || null, evidence: cov.evidence });
    process.stdout.write(JSON.stringify(r) + '\n');
    return 0;
  }
  if (!argv.includes('--json')) {
    process.stdout.write(cov.complete ? `coverage complete (${cov.skill})\n` : `coverage incomplete:\n${cov.missing.map((m) => `  - ${m}`).join('\n')}\n`);
  }
  return cov.complete ? 0 : 3;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(`review-coverage: internal error: ${e && e.message}\n`);
      process.exit(process.argv.includes('--record') ? 1 : 0);
    },
  );
}
