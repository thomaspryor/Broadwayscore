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
// (--fixes validates the shape; the weekly rollup counts what recurs). Up to MAX_NUDGES (3) per transcript per reason
// (exit 2, BRO-7729) plus a log line in .cache/retro-coverage-stop.log so the hit rate is readable.
// Cloud only, fails open on any error, kill switch RETRO_COVERAGE_STOP_DISABLE=1.
// Wired in .claude/hooks/verify-edits.sh as [VE:RETROCOV]; pinned by retro-coverage-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive, runShellCode } from './review-coverage.mjs';
import { isMainModule } from './is-main-module.mjs';

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

// BRO-7701: auto-mode sessions often edit with the shell (sed -i, a python/node heredoc, cat >, tee), which the
// Edit/Write check alone missed: the audit session landed a config change that way and this gate let it through.
// .claude/ state and ledger files (.claude/state/, *.jsonl, a bare worktree dir) are not code: only hooks, commands,
// skills, agents and top-level config JSON count.
const CODE_TOKEN = String.raw`(?:src/|scripts/|\.github/|\.claude/(?:hooks|commands|skills|agents)/|\.claude/[\w.-]+\.json\b)`;
const B = String.raw`(?:^|[\s'"=(<>])`; // a path starts at a boundary (after normalizing, absolute repo paths start bare)
const TARGET_RE = new RegExp(`${B}['"]?${CODE_TOKEN}`);
const SCRIPT_WRITE_RE = /open\([^)]*,\s*['"][wa]|writeFileSync|appendFileSync|write_text|(?<!std(?:out|err))\.write\(/;
/** Absolute or ./ paths into the repo or a worktree become repo-relative. Token by token with indexOf: linear on any input. */
const ROOT_RE = /^\/(?:home\/user|repo|workspace)\/Broadwayscore\//i; // another repo's scripts/ is not this repo's code
function normalizeToken(tok) {
  const wt = tok.lastIndexOf('.claude/worktrees/');
  if (wt >= 0) { const slash = tok.indexOf('/', wt + 18); return slash < 0 ? tok : tok.slice(slash + 1); }
  return tok.replace(ROOT_RE, '').replace(/^\.\//, '');
}
function normalizePaths(c) {
  return c.split(/([\s'"=(<>]+)/).map((tok, i) => (i % 2 ? tok : normalizeToken(tok))).join('');
}
/** Split on && || ; | and newlines that sit outside quotes (a sed script 's/a/b/;s/c/d/' stays whole). */
function splitClauses(c) {
  const out = []; let cur = ''; let q = '';
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && c[i + 1] === '&')) { out.push(cur); cur = ''; if (c[i + 1] === ch) i++; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
/** PURE. One shell clause (no && ; | splitting left to do) that writes a tracked code file. */
function clauseEditsCode(cl) {
  // A trailing shell comment is not the destination; sudo, env A=1 and /bin/ prefixes do not change the command.
  const t = cl.replace(/\s#.*$/, '').trim().replace(/^(?:(?:sudo|env)\s+(?:-\S+\s+)*(?:\w+=\S*\s+)*)+/, '').replace(/^\/(?:usr\/)?s?bin\//, '');
  // sed/perl in place: -i anywhere in the clause (before or after the script), or --in-place.
  if (/^(?:sed|perl)\b/.test(t) && /\s(?:-\w*i\w*|--in-place)\b/.test(t) && TARGET_RE.test(t)) return true;
  // cp/mv/install: the destination is the last token, or the -t/--target-directory operand (the trailing
  // tokens are then sources). Not for rsync, where -t means "keep times".
  if (/^(?:cp|mv|install|rsync)\b/.test(t)) {
    if (/^install\b.*\s-\w*d\b/.test(t)) return false; // install -d makes directories, not files
    const tdir = /^rsync\b/.test(t) ? null : t.match(/\s(?:-[a-zA-Z]*t\s+|--target-directory[=\s]\s*)(\S+)/);
    if (tdir) return new RegExp(`^['"]?${CODE_TOKEN}`).test(tdir[1]);
    const toks = t.split(/\s+/); // a trailing 2>/dev/null is not the destination (token-wise: linear on any input)
    while (toks.length > 1 && (/^\d*>>?&?/.test(toks[toks.length - 1]) || /^\d*>>?&?$/.test(toks[toks.length - 2] || ''))) {
      toks.pop();
    }
    const last = toks.pop();
    return new RegExp(`^['"]?${CODE_TOKEN}`).test(last);
  }
  if (/^(?:git(?:\s+-C\s+\S+)?\s+apply|patch)\b/.test(t)) return !/\s--(?:check|stat|numstat|summary)\b/.test(t);
  // > >> and tee: the token right after the operator.
  return new RegExp(String.raw`(?:>>?|\btee(?:\s+(?:-a|--append))?)\s*['"]?${CODE_TOKEN}`).test(t);
}
/** PURE. Does one shell command write a tracked code file? Quoted prose (commit messages, PR bodies) is not a target. */
export function shellEditsCode(command) {
  const raw = normalizePaths(String(command || ''));
  // runShellCode drops heredoc bodies and whitespace-holding quotes, keeping real shell (and bash -c bodies).
  if (splitClauses(runShellCode(raw)).some(clauseEditsCode)) return true;
  // A python/node script writing a file: the write call and a code path in the same command.
  return SCRIPT_WRITE_RE.test(raw) && TARGET_RE.test(raw);
}

/** PURE. Did the session edit tracked code (not only data/ or memory)? */
export function editedCode(events) {
  return events.some((e) => e.kind === 'assistant_tool_use' && (
    (/^(?:Edit|Write|NotebookEdit)$/.test(e.name || '') && CODE_PATH_RE.test(repoRelative(e.input?.file_path)))
    || (e.name === 'Bash' && shellEditsCode(e.input?.command))));
}

/** PURE. The `--record` commands this session ran that really ran (answered, not an error), with their event index. */
export function recordRuns(events) {
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  return events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === 'assistant_tool_use' && e.name === 'Bash')
    .map(({ e, i }) => ({ index: i, command: runShellCode(e.input?.command) || '', result: answers.get(e.id) }))
    // --check exits 10 on a flagged retro, which the harness may report as an error: a flagged run still ran.
    .filter((x) => RECORD_RE.test(x.command) && x.result && (!x.result.isError || /RETRO REQUIRED/.test(String(x.result.content || ''))));
}

// BRO-7729: a --record row lives in the checkout's data/audit/session-retro.jsonl until a land push carries it to
// main; the weekly rollup reads main. A session (2026-11-17) recorded, committed the row only to its claude/ branch
// and closed SAFE TO ARCHIVE: the gate passed and the loop never saw it. So the last record run must be followed by a
// commit that takes the ledger (git add of it, data/audit, -A, ., --all, or commit -a) and then a land push.
// git with any global options (-C dir, -c k=v, --no-pager) before the subcommand.
const GIT = String.raw`\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+)\s+)*`;
// Stages the ledger: add of it, data/audit, -A/--all/-u/., or commit -a/--all/naming it (which also commits).
const stageRe = (file) => new RegExp(`${GIT}(?:add\\b[^\\n;&|]*(?:${file}|data\\/audit\\/?(?:\\*(?:\\.jsonl)?)?(?=[\"'\\s;&|]|$)|\\s(?:-A|--all|-u|--update|\\.)(?=\\s|$))|commit\\b[^\\n;&|]*(?:\\s-[a-zA-Z]*a[a-zA-Z]*\\b|\\s--all\\b|${file}))`);
const RETRO_FILE = String.raw`session-retro\.jsonl`;
const COST_FILE = String.raw`claude-session-cost\.jsonl`;
const COMMIT_RE = new RegExp(`${GIT}commit\\b(?![^\\n;&|]*--dry-run)`);
const OTHER_REPO_RE = /broadway-scorecard-data|broadway-review-texts|BroadwayScorecard-app/i; // their ledgers are not this one
/** PURE. [{ index, stages, commits }] for each successful event that stages or commits the ledger (an API write to land/ does both). */
function ledgerEvents(events, file) {
  const STAGE = stageRe(file);
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const out = [];
  events.forEach((e, i) => {
    if (e.kind !== 'assistant_tool_use') return;
    const r = answers.get(e.id);
    if (!r || r.isError) return; // a failed commit ("nothing to commit") carries nothing
    if (e.name === 'Bash') {
      const c = runShellCode(e.input?.command) || '';
      if (OTHER_REPO_RE.test(c)) return;
      const stages = STAGE.test(c);
      const commits = COMMIT_RE.test(c);
      if (stages || commits) out.push({ index: i, stages, commits });
    } else if (/^mcp__github__(?:push_files|create_or_update_file)$/.test(e.name || '') && String(e.input?.branch || '').startsWith('land/')
      && new RegExp(file).test(JSON.stringify(e.input || {}))) {
      // An API write only carries the row if it goes to a land/ branch (a claude/ branch is the incident shape).
      out.push({ index: i, stages: true, commits: true });
    }
  });
  return out;
}
/** PURE. Index of the first commit that carries the ledger staged at or after `from`, or undefined. */
export function ledgerCommitIndex(events, from, file = RETRO_FILE) {
  const ev = ledgerEvents(events, file).filter((x) => x.index >= from);
  const stage = ev.find((x) => x.stages);
  if (!stage) return undefined;
  return ev.find((x) => x.index >= stage.index && x.commits)?.index;
}
/** PURE. Did a land push carry the row of the record run at `recordIndex`? Record, stage, commit, land push, in that
 *  order; one command may chain any of them (`--record && git commit -am r && git push … land/x`). */
export function recordReachedLand(events, recordIndex, file = RETRO_FILE) {
  const commit = ledgerCommitIndex(events, recordIndex, file);
  return commit !== undefined && landedPushIndices(events).some((i) => i >= commit);
}

// BRO-7729 cousin: the cost row (record-claude-session-cost.js, wrap-up BRO-6504) has the same shape and no gate at all:
// 5 sessions on main's cost ledger since 2026-11-17 against ~24 code-landing sessions. Same rule: it ran, and a land
// push after it carried data/audit/claude-session-cost.jsonl.
const COST_RE = /record-claude-session-cost\.js\b[^\n;&|]*--from-json\b/;
/** PURE. Event indices of cost-row runs that succeeded. */
export function costRuns(events) {
  const answers = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const out = [];
  events.forEach((e, i) => {
    if (e.kind !== 'assistant_tool_use' || e.name !== 'Bash') return;
    const r = answers.get(e.id);
    if (r && !r.isError && COST_RE.test(runShellCode(e.input?.command) || '') && /\b[1-9]\d* row\(s\) written/.test(String(r.content || ''))) out.push(i);
  });
  return out;
}

const MSG = {
  norow: 'Retro missing: this session landed code but never ran `node scripts/lib/session-retro.js --check --record`. Run it (it reads the transcript: edit-to-end time, hook blocks by hook, land refusals, bypasses), then turn each finding into a fix now or a card and re-run with `--record --fixes=BRO-N,<sha>` (or `--no-action="<why nothing needs a fix>"`). Then close again. Bypass (own token, not shared with other gates): NO-RETRO: <reason, 10+ chars>.',
  unlanded: 'Retro not on main: the last `session-retro.js --record` row was never carried to main by a land push after it (a row left in a worktree or on a claude/ branch is invisible to the weekly rollup). Commit it and land it: `git add data/audit/session-retro.jsonl && git commit -m "retro: session row"`, then `git push origin HEAD:refs/heads/land/<name>` and follow the Land run. Next time run --record before your final land push so it rides that push. Bypass (own token, not shared with other gates): NO-RETRO: <reason, 10+ chars>.',
  nocost: 'Cost row missing: this session landed code but never recorded its spend. Call get_session with no session_id, save the result to a scratchpad file, run `node scripts/record-claude-session-cost.js --from-json=<file> --cards=BRO-N`, then commit `data/audit/claude-session-cost.jsonl` and land it with the retro row (`git push origin HEAD:refs/heads/land/<name>`). Bypass (the same NO-RETRO token as the retro check): NO-RETRO: <reason, 10+ chars>.',
  costunlanded: 'Cost row not on main: the last `record-claude-session-cost.js` row was never carried to main by a land push after it (a claude/ branch push does not count). Commit `data/audit/claude-session-cost.jsonl` and land it: `git push origin HEAD:refs/heads/land/<name>`. Bypass (the same NO-RETRO token as the retro check): NO-RETRO: <reason, 10+ chars>.',
  nolink: 'Retro not closed: the retro row crossed a threshold ("RETRO REQUIRED") but links no fix or card. For each finding fix it now (guard, test, hook) or file a card, then re-run `node scripts/lib/session-retro.js --record --fixes=BRO-N,<sha>` (or `--no-action="<why nothing needs a fix>"` when the long time or many blocks were idle or expected). A memory note is not a fix. Bypass (own token, not shared with other gates): NO-RETRO: <reason, 10+ chars>.',
};

/** PURE Stop-hook decision. -> { decision: 'allow'|'block', reason, message? } */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env, hasGetSession = false }) {
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
  if (!recordReachedLand(events, runs[runs.length - 1].index)) return { decision: 'block', reason: 'retro row never carried to main by a land push', message: MSG.unlanded };
  // Only a session that had the get_session tool can record its cost (wrap-up: "No get_session tool: skip").
  if (hasGetSession && env.COST_ROW_GATE !== 'off') {
    const cost = costRuns(events);
    if (cost.length === 0) return { decision: 'block', reason: 'landed code, no cost row recorded', message: MSG.nocost };
    if (!recordReachedLand(events, cost[cost.length - 1], COST_FILE)) return { decision: 'block', reason: 'cost row never carried to main by a land push', message: MSG.costunlanded };
  }
  return { decision: 'allow', reason: flagged ? 'retro closed with links' : 'retro recorded, no threshold crossed' };
}

export const MAX_NUDGES = 3;

const GET_SESSION = 'mcp__claude-code-remote__get_session';
/** PURE. True when the session was offered `name` (a prompt_snapshot / tool-listing attachment names it) or called it.
 *  A plain substring scan is wrong: a session that only read or grepped this file would carry the name too. */
export function transcriptHasTool(text, name) {
  for (const line of String(text).split('\n')) {
    if (!line.includes(name)) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // Only a real tool-list entry counts (ship-check P2): a name in removedNames, a system-prompt mention or a
    // longer sibling name (…get_session_cost) must not switch the cost gate on.
    const a = d.type === 'attachment' ? d.attachment || {} : null;
    if (a && a.type === 'prompt_snapshot' && Array.isArray(a.tools) && a.tools.some((t) => t?.name === name)) return true;
    if (a && /^deferred_tools/.test(String(a.type || '')) && [a.addedNames, a.readdedNames].some((l) => Array.isArray(l) && l.includes(name))) return true;
    const content = d.type === 'assistant' ? d.message?.content : null;
    if (Array.isArray(content) && content.some((c) => c?.type === 'tool_use' && c.name === name)) return true;
  }
  return false;
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
  let hasGetSession = false; // unknown -> skip the cost check
  try { hasGetSession = transcriptHasTool(fs.readFileSync(tp, 'utf8'), GET_SESSION); } catch { /* fail open */ }
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env, hasGetSession });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `retro-coverage-stop-${createHash('sha1').update(tp + '\u0000' + d.reason).digest('hex').slice(0, 12)}`);
  // BRO-7729: one nudge let a session close again with the gap still open (2026-11-17: a flagged, unlinked retro
  // closed SAFE TO ARCHIVE). Now up to MAX_NUDGES blocks per transcript per reason, so the way past is the fix or a
  // logged NO-RETRO reason; the cap still means it can never loop a session forever.
  let count = 0;
  try { count = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first time */ }
  logHit({ session: input.session_id || null, blocked: count < MAX_NUDGES, nudge: count + 1, reason: d.reason });
  if (count >= MAX_NUDGES) return 0;
  try { fs.writeFileSync(counter, String(count + 1)); } catch { /* best effort */ }
  process.stderr.write((count > 0 ? `(Repeat ${count + 1} of ${MAX_NUDGES}: closing again does not clear this. Do the step below, or write NO-RETRO: <reason> in your closing.)\n` : '') + d.message + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`retro-coverage-stop: internal error (failing open): ${e && e.message}\n`);
  }
  process.exitCode = code;
}
