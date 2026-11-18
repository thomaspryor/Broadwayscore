#!/usr/bin/env node
// BRO-7738: a session may not close SAFE TO ARCHIVE on a change to something a workflow runs until it ran that thing
// for real. 2026-11-18: a cloud session changed the Sentry triage script, landed it with unit tests green and reported
// done; only when the owner asked "Did you fully test it?" did it dispatch the workflow (which then did real work the
// tests never touched). Every gate passed: /did-it-work accepts any non-look command, ship-check reads code.
//
// This Stop check (cloud only, claims SAFE TO ARCHIVE) looks at the chunk of work since the previous SAFE TO ARCHIVE
// claim. If that chunk landed an edit to a workflow file, or to a script a workflow runs DIRECTLY (its path is in the
// workflow, comments ignored; test.yml and land.yml do not count, the land run already executes those), it asks for
// one of:
//   1. a dispatch, after the last land push, of a workflow that runs the edited file, then a read of that run
//      (actions_get / get_job_logs / list_workflow_jobs / wait-for-run / wait-for-land), or
//   2. a run of the edited script itself (`node scripts/x.js …`, `bash scripts/x.sh …`) after its last edit that
//      finished without error and was not --help / --version / node --check.
// A plain NO-LIVE-RUN: <15+ chars> line covers a run that would spend money or send real email. "It only runs on cron" is refused: dispatch it or dry-run it now.
// Library files a workflow script imports are not judged (the 2-level closure covers ~90% of scripts/lib, see the
// BRO-7738 review); /did-it-work still asks for those to be run.
//
// Rollout (CLAUDE.md section 19): one nudge per chunk of work until LIVE_RUN_BLOCKING_FROM, then two. Every decision
// that would block is logged to .cache/live-run-stop.log. Fails open on any error; kill switch LIVE_RUN_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh as [VE:LIVERUN]; pinned by live-run-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive, runShellCode, lastAcceptedClaimIndex } from './review-coverage.mjs';
import { shellEditsCode } from './retro-coverage-stop.mjs';
import { answerTexts } from './root-cause-stop.mjs';

export const LIVE_RUN_BLOCKING_FROM = '2026-11-25';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const EXCLUDED_WORKFLOWS = /^(?:test|land)\.ya?ml$/;
const SCRIPT_REF_RE = /(?:^|[\s'"=(/])(scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh|py))\b/g;
// Owner 2026-11-18: "we'll know tomorrow if it works" -> "can you just force a dry run now?" -> "good idea!". A message that
// defers proof to a later scheduled run is judged like a SAFE TO ARCHIVE claim, whatever its verdict line says.
export const WAIT_TO_SEE_RE = new RegExp([
  String.raw`\b(?:we'?ll|we will|I'?ll|I will|you'?ll|you will)\s+(?:know|find out|confirm|learn|see(?!\s+you\b)|be able to tell)\b[^.\n]{0,80}?\b(?:tomorrow|tonight|overnight|in the morning|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|next (?:run|cron|scheduled run|week|day|pass|firing)|in (?:\d+|a few|a couple of|one|two|three) (?:days?|hours?)|after (?:the )?(?:next|nightly|scheduled))\b`,
  String.raw`\bonce (?:the |it )?(?:next|nightly|tonight'?s|tomorrow'?s|morning'?s|first scheduled|scheduled) (?:cron|run|job|pass|firing)\b`,
  String.raw`\bonce the (?:cron|job|scheduled run) runs\b`,
  String.raw`\b(?:once|when|after) (?:tomorrow'?s|tonight'?s|the next|the nightly|the scheduled)\b[^.\n]{0,40}\b(?:we'?ll|we will|I'?ll|you'?ll)\s+(?:know|see|find out|confirm)\b`,
  String.raw`\b(?:proof|confirmation|verification) (?:comes|will come)\b[^.\n]{0,40}\b(?:tomorrow|tonight|next|scheduled|nightly|cron)`,
  String.raw`\bwill be (?:verified|confirmed|proven|proved) (?:by|in|on|with|after)\b[^.\n]{0,40}\b(?:tomorrow|tonight|next|scheduled|nightly|cron)`,
  String.raw`^\s*RECHECK-AFTER\b`,
].join('|'), 'im');
/** Deferral language outside code fences and quotes (a session quoting the phrase is not deferring). */
export const defersProof = (text) => WAIT_TO_SEE_RE.test(String(text || '').replace(/```[\s\S]*?```/g, '').replace(/"[^"\n]{1,200}"|“[^”\n]{1,200}”/g, '""'));
// A bypass whose reason is only "it runs on a schedule" is refused: every scheduled workflow can be dispatched or dry-run now.
// A schedule word plus a money/email reason is a real reason (CLAUDE.md sections 8 and 17): those must not be dispatched.
const REAL_COST_REASON_RE = /\b(?:e-?mail|broadcast|subscribers?|readers?|resend|send(?:s|ing)?|\$\d|money|paid|spend\w*|cost\w*|charge\w*|credits?|quota)\b/i;
const SCHEDULE_ONLY_REASON_RE = /\b(?:cron|schedul\w*|tomorrow|tonight|overnight|next run|nightly|daily run|only runs|runs (?:at|every|on))\b/i;
const NO_LIVE_RUN_RE = /^[ \t>*_-]*NO-LIVE-RUN(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(\S.{14,})$/im;
const RESULT_READ_TOOL_RE = /^mcp__github__(?:actions_get|get_job_logs|actions_list)$/;
const RESULT_READ_CMD_RE = /\b(?:wait-for-run\.sh|gh\s+run\s+view)\b|\bcloud-dispatch\.js\b[^\n;&|]*\s--wait\b/;
// Review P1: a dispatch only runs the new code once the land has merged, so a wait-for-land read must come first.
const LAND_DONE_CMD_RE = /\bwait-for-land\.js\b/;
// A command, not text that mentions one (echo/grep of the script name): it must start the command or follow a separator.
const CMD_START = '(?:^|[;&|(\\n])\\s*';
const FAILED_OUTPUT_RE = /^\s*(?:\w*Error|Error \[\w+\]):|Traceback \(most recent call last\)|\bUnhandled(?:PromiseRejection)?\b|\b(?:404|422) Not Found|\bNot Found\b/m;
const NOT_A_RUN_RE = /(?:^|\s)(?:--help|-h|--version)(?:\s|$)/;

/** PURE. Map of repo-relative script path -> [workflow file names] from { name: yamlText }. Comment lines are skipped. */
export function workflowScriptIndex(workflows) {
  const idx = new Map();
  for (const [name, text] of Object.entries(workflows)) {
    if (EXCLUDED_WORKFLOWS.test(name)) continue;
    for (const line of String(text).split('\n')) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.replace(/\s#.*$/, '').matchAll(SCRIPT_REF_RE)) {
        if (/\.test\.\w+$/.test(m[1])) continue;
        if (!idx.has(m[1])) idx.set(m[1], new Set());
        idx.get(m[1]).add(name);
      }
    }
  }
  return new Map([...idx].map(([k, v]) => [k, [...v]]));
}

/** Repo-relative path of an absolute file path (worktree or main checkout), or ''. */
export function repoRelative(p) {
  const s = String(p || '');
  const wt = s.match(/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (wt) return wt[1];
  const m = s.match(/(?:^|\/)((?:scripts|\.github)\/.*)$/);
  return m && !/\/\.claude\/projects\//.test(s) ? m[1] : '';
}

/**
 * PURE. Files edited after `from` that run live: [{ file, workflows, lastEdit }]. A workflow file runs itself.
 */
export function liveEdits(events, from, index) {
  const out = new Map();
  events.forEach((e, i) => {
    if (i <= from || e.kind !== 'assistant_tool_use') return;
    let paths = [];
    if (EDIT_TOOLS.has(e.name)) paths = [e.input?.file_path];
    // Edits made in the shell (sed -i, > redirect, python writes): every live path the editing command names (what-else gap).
    else if (e.name === 'Bash' && shellEditsCode(e.input?.command)) {
      const c = String(e.input?.command || '');
      paths = [...c.matchAll(/(?:^|[\s'"=(/])((?:\.github\/workflows\/[\w.-]+\.ya?ml)|(?:scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh|py)))\b/g)].map((m) => m[1]);
    }
    for (const p of paths) add(p, i);
  });
  return [...out.values()];
  function add(path, i) {
    const rel = repoRelative(path) || (/^(?:scripts|\.github)\//.test(String(path)) ? String(path) : null);
    if (!rel) return;
    let workflows = null;
    const wf = rel.match(/^\.github\/workflows\/([^/]+\.ya?ml)$/);
    if (wf) workflows = EXCLUDED_WORKFLOWS.test(wf[1]) ? null : [wf[1]];
    else if (index.has(rel)) workflows = index.get(rel);
    if (workflows) out.set(rel, { file: rel, workflows, lastEdit: i });
  }
}

/** PURE. Was the live file exercised? -> 'dispatch' | 'direct' | null */
export function liveRunFor(events, edit, lastLand) {
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const text = (r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? ''));
  const ok = (e) => { const r = answers.get(e.id); return !!r && !r.isError && !FAILED_OUTPUT_RE.test(text(r)); };
  let landDone = false;
  const wfRe = new RegExp(`(?:^|[\\s/'"])(?:${edit.workflows.map((w) => w.replace(/[.]/g, '\\.')).join('|')})\\b`);
  let dispatchAt = -1;
  for (let i = lastLand + 1; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'assistant_tool_use' || !ok(e)) continue;
    if (e.name === 'Bash' && LAND_DONE_CMD_RE.test(runShellCode(e.input?.command) || '')) { landDone = true; continue; }
    if (!landDone) continue;
    if (e.name === 'mcp__github__actions_run_trigger' && wfRe.test(' ' + String(e.input?.workflow_id || ''))) { dispatchAt = i; continue; }
    if (e.name === 'Bash') {
      const c = runShellCode(e.input?.command) || '';
      if (new RegExp(`${CMD_START}(?:gh\\s+workflow\\s+run|node\\s+\\S*cloud-dispatch\\.js)\\b`).test(c) && wfRe.test(c)) { dispatchAt = i; if (RESULT_READ_CMD_RE.test(c)) return 'dispatch'; continue; }
      if (dispatchAt >= 0 && RESULT_READ_CMD_RE.test(c)) return 'dispatch';
    }
    if (dispatchAt >= 0 && RESULT_READ_TOOL_RE.test(e.name || '') && e.input?.method !== 'list_workflows') return 'dispatch';
  }
  if (/\.github\/workflows\//.test(edit.file)) return null;
  const base = edit.file.replace(/[.]/g, '\\.');
  const runRe = new RegExp(`${CMD_START}(?:node|npx\\s+tsx|tsx|bash|sh|python3?)\\s+(?:-\\S+\\s+)*(?:\\S*/)?${base}(?=\\s|$|[;&|)])([^\\n;&|]*)`);
  for (let i = edit.lastEdit + 1; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash' || !ok(e)) continue;
    const c = runShellCode(e.input?.command) || '';
    const m = runRe.exec(c);
    if (m && !NOT_A_RUN_RE.test(m[1]) && !/\s(?:--check|-c)\s/.test(m[0])) return 'direct';
  }
  return null;
}

export function blockBudget(now = new Date()) {
  return now.toISOString().slice(0, 10) >= LIVE_RUN_BLOCKING_FROM ? 2 : 1;
}

export function blockMessage(missing) {
  const lines = missing.slice(0, 5).map((m) => `- ${m.file} (run by ${m.workflows.slice(0, 3).join(', ')}${m.workflows.length > 3 ? ', …' : ''})`);
  return [
    'BLOCKED (BRO-7738): this session landed a change to something a workflow runs, and never ran it for real. Unit tests and reviews do not show that the live job works.',
    ...lines,
    'Do one of these, then close again:',
    '  1. Run the edited script itself on real data (a --dry-run counts; --help and node --check do not): node <file> …',
    '  2. Dispatch the workflow that runs it, after node scripts/lib/wait-for-land.js land/<name> says it landed (mcp__github__actions_run_trigger, or node scripts/cloud-dispatch.js <workflow> --wait), then read the run result (mcp__github__actions_get / get_job_logs, or the --wait output) and fix what it shows.',
    'Do not dispatch something that spends real money in bulk or sends real email (CLAUDE.md sections 8 and 17): run it with --dry-run instead, or write NO-LIVE-RUN: <15+ chars on why>, and say plainly it is not yet proven live.',
    'Waiting for the next scheduled run ("we will know tomorrow") is not proof and not a bypass reason: dispatch it now, or run it with --dry-run now.',
  ].join('\n');
}

/** PURE Stop-hook decision. -> { decision, reason, message?, chunkKey? } */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env, index = new Map() }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.LIVE_RUN_STOP_DISABLE === '1') return { decision: 'allow', reason: 'LIVE_RUN_STOP_DISABLE=1' };
  const defers = defersProof(lastMessage);
  if (!claimsSafeToArchive(lastMessage) && !defers) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE or deferring proof' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  // BRO-7738: a claim another Stop hook refused is not a boundary (lastAcceptedClaimIndex).
  const from = lastAcceptedClaimIndex(events, lastMessage);
  const allBypass = new RegExp(NO_LIVE_RUN_RE.source, 'gim');
  const accepted = (why) => !SCHEDULE_ONLY_REASON_RE.test(why) || REAL_COST_REASON_RE.test(why);
  if (answerTexts(events.slice(from + 1), lastMessage).some((t) => [...String(t).matchAll(allBypass)].some((m) => accepted(m[1])))) return { decision: 'allow', reason: 'NO-LIVE-RUN bypass' };
  const landed = landedPushIndices(events).filter((i) => i > from);
  if (!landed.length) return { decision: 'allow', reason: 'nothing landed in this chunk' };
  const lastLand = landed[landed.length - 1];
  // Only edits that a land push after them carried count.
  const edits = liveEdits(events, from, index).filter((x) => x.lastEdit < lastLand);
  if (!edits.length) return { decision: 'allow', reason: 'no landed edit to a file a workflow runs' };
  // A dispatch counts only after the LAST land: an earlier land may not have carried an edit committed later
  // (BRO-7738 ship-check), so a chunk spanning two lands is judged strictly; running the script directly still counts.
  const missing = edits.filter((x) => !liveRunFor(events, x, lastLand));
  if (!missing.length) return { decision: 'allow', reason: 'every live file was run' };
  return {
    decision: 'block',
    chunkKey: from < 0 ? '' : String(events[from].messageId || events[from].ts || from),
    reason: `not run live: ${missing.map((m) => m.file).join(', ')}`.slice(0, 300),
    message: blockMessage(missing),
  };
}

/** Read every workflow under <root>/.github/workflows. */
export function loadWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  const out = {};
  for (const f of fs.readdirSync(dir)) if (/\.ya?ml$/.test(f)) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'live-run-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export function main(argv, { env = process.env, now = new Date() } = {}) {
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: live-run-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n'); return 0; }
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { return 0; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const index = workflowScriptIndex(loadWorkflows(root));
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env, index });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `live-run-stop-${createHash('sha1').update(tp + '\u0000' + (d.chunkKey || '')).digest('hex').slice(0, 12)}`);
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first block */ }
  const budget = blockBudget(now);
  logHit({ session: input.session_id || null, chunk: d.chunkKey || null, blocked: n < budget, n, budget, reason: d.reason });
  if (n >= budget) return 0;
  try { fs.writeFileSync(counter, String(n + 1)); } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`live-run-stop: internal error (failing open): ${e && e.message}\n`); code = 0; }
  process.exitCode = code;
}
