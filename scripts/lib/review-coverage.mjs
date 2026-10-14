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
//   1. a Claude codebase review: an Agent call with subagent_type review-panelist
//   2. an external adversarial review: curl to api.openai.com / Gemini, or `codex exec`
// tsc/lint/build are NOT checked here: land.yml runs them strictly on the rebased tree.
//
// One implementation for both enforcement points:
//   - land gate:   land-preflight.mjs runHook -> landGateDecision (blocks a land/* push)
//   - Stop hook:   .claude/hooks/stop-review-coverage.sh -> `--stop-hook` (SAFE TO EXIT after a
//                  ship-check whose reviewers never ran is refused). Its own repo-only hook, not
//                  verify-edits.sh, which is a copy of a Mac master (cloud-parity.json).
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
import { walkTranscript } from './transcript-scan.mjs';

export const STRONG_SKILLS = ['ship-check', 'code-review'];
// By-hand fallback when the Skill call fails with "Unknown skill" (BRO-5068):
// reading the command file after the failure counts as the run (mirrors verify-edits.sh).
const FALLBACK_FILES = {
  'ship-check': ['.claude/commands/ship-check.md', '.agents/skills/ship-check/SKILL.md'],
};
const EXTERNAL_CALL_RE = /\bcurl\b[\s\S]*?(?:api\.openai\.com|generativelanguage\.googleapis\.com)|\bcodex\s+exec\b/;
export const NO_SHIP_CHECK_RE = /#\s*NO-SHIP-CHECK:\s*(\S.{14,})/;

const skillName = (s) => String(s || '').split(':').pop().replace(/^\//, '');

/** Indices (into events) of real ship-check/code-review runs, with the skill name. */
export function findRuns(events) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  const runs = [];
  const failed = new Set();
  events.forEach((e, i) => {
    if (e.kind === 'user_text') {
      const m = /<command-name>\/?(ship-check|code-review)<\/command-name>/.exec(e.text || '');
      if (m) runs.push({ i, skill: m[1], id: `typed-${i}` });
    } else if (e.kind === 'assistant_tool_use' && e.name === 'Skill') {
      const sk = skillName(e.input?.skill);
      if (!STRONG_SKILLS.includes(sk)) return;
      const r = results.get(e.id);
      if (r && (r.isError || /unknown skill/i.test(r.content || ''))) failed.add(sk);
      else runs.push({ i, skill: sk, id: e.id });
    } else if (e.kind === 'assistant_tool_use' && (e.name === 'Read' || e.name === 'Bash') && failed.size) {
      const target = e.name === 'Read' ? e.input?.file_path || '' : String(e.input?.command || '');
      for (const sk of [...failed]) {
        if ((FALLBACK_FILES[sk] || []).some((f) => target.endsWith(f) || target.includes(f))) {
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
export function evaluateCoverage(events) {
  const runs = findRuns(events);
  if (runs.length === 0) {
    return { ran: false, complete: false, skill: null, missing: ['no /ship-check or /code-review run in this session'], evidence: null };
  }
  const last = runs[runs.length - 1];
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.tool_use_id, e);
  const answered = (id) => {
    const r = results.get(id);
    return !!r && !r.isError;
  };
  const claude = [];
  const external = [];
  for (const e of events.slice(last.i + 1)) {
    if (e.kind !== 'assistant_tool_use') continue;
    if (e.name === 'Agent' || e.name === 'Task') {
      if (e.input?.subagent_type === 'review-panelist' && answered(e.id)) claude.push(e);
    } else if (e.name === 'Bash' && EXTERNAL_CALL_RE.test(String(e.input?.command || '')) && answered(e.id)) {
      external.push(e);
    }
  }
  const missing = [];
  if (claude.length === 0) missing.push('Claude codebase review (Agent with subagent_type "review-panelist")');
  if (external.length === 0) missing.push('external adversarial review (curl to api.openai.com or Gemini, or `codex exec`)');
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
export function landGateDecision({ command = '', events = null, gatedLines = 0, budget = 30, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'skip', reason: 'not a cloud session (the Mac has its own finish-line gate)' };
  if (env.SHIP_CHECK_LAND_GATE_DISABLE === '1') return { decision: 'skip', reason: 'SHIP_CHECK_LAND_GATE_DISABLE=1' };
  const bypass = NO_SHIP_CHECK_RE.exec(command);
  if (bypass) return { decision: 'allow', reason: `NO-SHIP-CHECK bypass: ${bypass[1].trim()}` };
  if (!events || events.length === 0) return { decision: 'skip', reason: 'no transcript to judge (fails open)' };
  if (gatedLines <= budget) return { decision: 'skip', reason: `gated diff is ${gatedLines} lines (<= ${budget})` };
  const cov = evaluateCoverage(events);
  if (cov.complete) return { decision: 'allow', reason: `${cov.skill} coverage complete` };
  return {
    decision: 'block',
    reason: 'review coverage incomplete',
    message: [
      `LAND BLOCKED (BRO-5359): this push lands ${gatedLines} lines of code but the session has no complete review yet.`,
      'Missing:',
      ...cov.missing.map((m) => `  - ${m}`),
      'Run the real /ship-check now, before landing: follow its cloud profile (Claude review-panelist Agent AND an external reviewer), fix what it finds, then push again.',
      'tsc, lint and the build are run by land.yml on the rebased tree; do not skip the reviewers for that reason.',
      'Only if the review truly cannot run: add `# NO-SHIP-CHECK: <reason, 15+ chars>` to the push command (logged).',
    ].join('\n'),
  };
}


const MAX_STOP_BLOCKS = 3;

/**
 * Pure Stop-hook decision. Blocks only a final "SAFE TO EXIT" message when the session's last
 * /ship-check or /code-review run lacks its reviewers. A session with no strong review run at
 * all is left to verify-edits.sh's chain gate (it asks for the review itself).
 * -> { decision: 'allow'|'block', reason, message? }
 */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.SHIP_CHECK_COVERAGE_DISABLE === '1') return { decision: 'allow', reason: 'SHIP_CHECK_COVERAGE_DISABLE=1' };
  const text = String(lastMessage || '').replace(/```[\s\S]*?```/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^[-=_*~\s\u2500-\u257f\u2022\u00b7]+$/.test(l));
  if (!lines.length || !/^SAFE TO EXIT\b/.test(lines[lines.length - 1])) return { decision: 'allow', reason: 'not claiming SAFE TO EXIT' };
  if (/^\s*NO-SHIP-CHECK:\s*(\S.{9,})/m.test(text)) return { decision: 'allow', reason: 'NO-SHIP-CHECK bypass' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  const cov = evaluateCoverage(events);
  if (!cov.ran || cov.complete) return { decision: 'allow', reason: cov.ran ? 'coverage complete' : 'no strong review run' };
  return {
    decision: 'block',
    reason: 'review coverage incomplete',
    message: [
      `BLOCKED (BRO-5359): you ran /${cov.skill} but its reviewers never ran, so it does not count as a review. Missing:`,
      ...cov.missing.map((m) => `  - ${m}`),
      'Finish the real /ship-check (cloud profile in .claude/CLOUD.md), fix what it finds, then close out again.',
      'If a reviewer truly cannot run, say why on a line `NO-SHIP-CHECK: <reason>` in the closing message.',
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
  if (d.decision !== 'block') return 0;
  // Cap blocks per transcript so an unsatisfiable gate can never loop a session.
  const counter = path.join(os.tmpdir(), `review-coverage-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
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
