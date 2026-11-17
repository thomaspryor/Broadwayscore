#!/usr/bin/env node
// BRO-7645: close the session-retro loop (BRO-7629 item 6). The audit of its first 15h found 9 of 13
// code-landing sessions wrote a retro row, and almost none linked a fix or card to a flagged one.
// This Stop check asks a cloud session that LANDED code (edited src/, scripts/, .github/ or .claude/
// and pushed to land/<name>) and now claims SAFE TO ARCHIVE for two things:
//   1. a `session-retro.js --record` run, and
//   2. fix links on that record: `--fixes=BRO-N,<sha>` or `--no-action="<reason>"`.
// It reads the TRANSCRIPT (the record command and its flags), not the ledger file: a session in a
// worktree writes its row to the worktree's copy, which this hook's checkout cannot see. The ledger
// stays the data store; the transcript is the witness. It does not judge whether a fix is real
// (--fixes validates the shape; the weekly rollup counts what recurs). One nudge per transcript
// (exit 2) plus a log line in .cache/retro-coverage-stop.log so the hit rate is readable.
// Cloud only, fails open on any error, kill switch RETRO_COVERAGE_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh as [VE:RETROCOV]; pinned by retro-coverage-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive, runShellCode } from './review-coverage.mjs';

const CODE_PATH_RE = /^(?:src|scripts|\.github|\.claude)\//;
/** A path relative to the repo or worktree root, or '' for files outside it (memory, ~/.claude). */
function repoRelative(p) {
  const s = String(p || '');
  if (/\/\.claude\/projects\//.test(s)) return '';
  const wt = s.match(/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (wt) return wt[1];
  return s.replace(/^\/(?:home\/user|repo|workspace)\/[^/]+\//, '').replace(/^\//, '');
}
const RECORD_RE = /session-retro\.js\b[^\n;&|]*--record\b/;
const LINK_RE = /--(?:fixes=(?:BRO-\d+|[0-9a-f]{7,40})|no-action=\S)/;

/** PURE. Did the session edit tracked code (not only data/ or memory)? */
export function editedCode(events) {
  return events.some((e) => e.kind === 'assistant_tool_use' && /^(?:Edit|Write|NotebookEdit)$/.test(e.name || '') && CODE_PATH_RE.test(repoRelative(e.input?.file_path)));
}

/** PURE. The `--record` commands this session ran that really ran (answered, not an error). */
export function recordRuns(events) {
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  return events
    .filter((e) => e.kind === 'assistant_tool_use' && e.name === 'Bash')
    .map((e) => ({ command: runShellCode(e.input?.command) || '', result: answers.get(e.id) }))
    // --check exits 10 on a flagged retro, which the harness may report as an error: a flagged run still ran.
    .filter((x) => RECORD_RE.test(x.command) && x.result && (!x.result.isError || /RETRO REQUIRED/.test(String(x.result.content || ''))));
}

const MSG = {
  norow: 'Retro missing: this session landed code but never ran `node scripts/lib/session-retro.js --check --record`. Run it (it reads the transcript: edit-to-end time, hook blocks by hook, land refusals, bypasses), then turn each finding into a fix now or a card and re-run with `--record --fixes=BRO-N,<sha>` (or `--no-action="<why nothing needs a fix>"`). Then close again. Bypass (own token, not shared with other gates): NO-RETRO: <reason, 10+ chars>.',
  nolink: 'Retro not closed: the retro row crossed a threshold ("RETRO REQUIRED") but links no fix or card. For each finding fix it now (guard, test, hook) or file a card, then re-run `node scripts/lib/session-retro.js --record --fixes=BRO-N,<sha>` (or `--no-action="<why nothing needs a fix>"` when the long time or many blocks were idle or expected). A memory note is not a fix. Bypass (own token, not shared with other gates): NO-RETRO: <reason, 10+ chars>.',
};

/** PURE Stop-hook decision. -> { decision: 'allow'|'block', reason, message? } */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.RETRO_COVERAGE_STOP_DISABLE === '1') return { decision: 'allow', reason: 'RETRO_COVERAGE_STOP_DISABLE=1' };
  if (!claimsSafeToArchive(lastMessage)) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE' };
  if (/NO-RETRO:\s*\S.{8,}/.test(lastMessage)) return { decision: 'allow', reason: 'NO-RETRO bypass' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  if (landedPushIndices(events).length === 0) return { decision: 'allow', reason: 'nothing landed' };
  if (!editedCode(events)) return { decision: 'allow', reason: 'no tracked code edited (data-only)' };
  const runs = recordRuns(events);
  if (runs.length === 0) return { decision: 'block', reason: 'landed code, no retro --record run', message: MSG.norow };
  const flagged = runs.some((r) => /RETRO REQUIRED/.test(String(r.result.content || '')));
  if (flagged && !runs.some((r) => LINK_RE.test(r.command))) return { decision: 'block', reason: 'retro crossed a threshold, no --fixes/--no-action', message: MSG.nolink };
  return { decision: 'allow', reason: flagged ? 'retro closed with links' : 'retro recorded, no threshold crossed' };
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'retro-coverage-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export function main(argv, { env = process.env } = {}) {
  if (!argv.includes('--stop-hook')) {
    process.stderr.write('usage: retro-coverage-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n');
    return 0;
  }
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `retro-coverage-stop-${createHash('sha1').update(tp + '\u0000' + d.reason).digest('hex').slice(0, 12)}`);
  const seen = fs.existsSync(counter); // one nudge per transcript per reason: a later, different gap still gets its own
  logHit({ session: input.session_id || null, blocked: !seen, reason: d.reason });
  if (seen) return 0; // one nudge per transcript; it can never loop a session
  try { fs.writeFileSync(counter, '1'); } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`retro-coverage-stop: internal error (failing open): ${e && e.message}\n`);
  }
  process.exitCode = code;
}
