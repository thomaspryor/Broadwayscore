#!/usr/bin/env node
// BRO-7294: rule 21 at the moment a cloud session claims it is finished.
//
// A cloud session landed six one-record data patches, ended on SAFE TO ARCHIVE, and admitted they
// were spot fixes only when the owner asked. The only rule-21 check (root-cause-close.js) runs when
// a Linear card is closed, and it is advisory until ROOT_CAUSE_CLOSE_BLOCKING_FROM, so nothing
// stopped the chat claim. This Stop check asks a session that LANDED code (a git push to land/<name>
// or an MCP landing) on a FIX card, and now claims SAFE TO ARCHIVE, to state its rule-21 answer:
//   CLASS-GUARD: <path> (or the older PREVENTION: <path> ; cousins: ...), or
//   NO-ROOT-CAUSE: <why this was a spot fix>   (NO-PREVENTION: is accepted as an alias)
// in its chat message OR in a Linear comment it posted this session (linear-brain.js update/comment
// text, or the Linear connector's save_comment), so a session that closed its card properly passes
// without putting jargon in the owner's chat.
//
// What it does NOT do: judge whether the guard is real. A NO-ROOT-CAUSE line satisfies it, so it
// forces an honest statement, not a root-cause fix. The guard's substance is root-cause-close.js's
// job at card close.
//
// Scope: cloud only (CLAUDE_CODE_REMOTE=true), fails open on any error or missing transcript, kill
// switch ROOT_CAUSE_STOP_DISABLE=1. Feature cards are skipped: when the session names its card
// (linear-brain.js create "<title>" or the connector's save_issue title) and none is a fix card
// (isFixCard) and none of the landed commit subjects reads as a fix (isFixSubject, BRO-7301), the
// check stays quiet. A session whose card title is unknown is checked.
// Block budget per transcript: 1 (a single reminder) until ROOT_CAUSE_CLOSE_BLOCKING_FROM, the same
// rollout date as the card-close gate, then 2. Exit-0 output is invisible to the model, so the
// advisory period is one nudge, never a silent log. Every decision to block is logged to
// .cache/root-cause-stop.log so the hit rate can be read before the budget rises.
// Wired in .claude/hooks/verify-edits.sh; pinned by root-cause-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive } from './review-coverage.mjs';

const require = createRequire(import.meta.url);
const { parseRootCauseBlock, isFixCard, ROOT_CAUSE_CLOSE_BLOCKING_FROM } = require('./root-cause-close.js');

const MIN_REASON = 10;
const NO_PREVENTION_RE = /^[ \t>*_-]*NO-PREVENTION(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(\S.*)$/im;
const LINEAR_WRITE_CMD_RE = /linear-brain\.js\s+update\b|linear-session\.js\s+report\b/;
// The Linear connector is mcp__Linear__* locally and mcp__<uuid>__* in some cloud containers.
const LINEAR_COMMENT_TOOL_RE = /(?:linear.*__|^mcp__[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}__)save_comment$/i;
const LINEAR_ISSUE_TOOL_RE = /(?:linear.*__|^mcp__[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}__)save_issue$/i;
const CREATE_TITLE_RE = /linear-brain\.js\s+create\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;

/**
 * PURE. Titles of the cards this session created to work on itself (only creations name a title).
 * A card filed for someone else (--park / --dispatch) is not this session's work, so it never
 * makes a feature session look like a fix.
 */
export function cardTitles(events) {
  const titles = [];
  for (const e of events) {
    if (e.kind !== 'assistant_tool_use') continue;
    if (e.name === 'Bash') {
      for (const seg of String(e.input?.command || '').split(/\n|&&|;/)) {
        if (/\s--(?:park|dispatch)\b/.test(seg)) continue;
        for (const m of seg.matchAll(CREATE_TITLE_RE)) titles.push(m[1] ?? m[2]);
      }
    } else if (LINEAR_ISSUE_TOOL_RE.test(e.name || '') && !e.input?.id && e.input?.title) {
      titles.push(String(e.input.title));
    }
  }
  return titles.filter(Boolean);
}

/** PURE. Every text where a rule-21 answer may live: assistant chat, Linear comment writes, the closing message. */
export function answerTexts(events, lastMessage = '') {
  const out = [];
  for (const e of events) {
    if (e.kind === 'assistant_text') out.push(e.text || '');
    else if (e.kind === 'assistant_tool_use') {
      if (e.name === 'Bash' && LINEAR_WRITE_CMD_RE.test(String(e.input?.command || ''))) {
        // Start each flag value on its own line, so an inline `--comment "CLASS-GUARD: x"` reads as a field line.
        out.push(String(e.input.command).replace(/\\n/g, '\n').replace(/--(?:comment|body|notes|summary)[=\s]+(?:\$\(cat\s*<<-?\s*)?["']?/g, '\n'));
      }
      else if (LINEAR_COMMENT_TOOL_RE.test(e.name || '')) out.push(String(e.input?.body || ''));
    }
  }
  out.push(String(lastMessage || ''));
  return out;
}

/** PURE. Has the session stated its rule-21 answer? */
export function hasRootCauseAnswer(texts) {
  const { fields, noRootCause } = parseRootCauseBlock(texts);
  if (noRootCause && noRootCause.length >= MIN_REASON) return true;
  if (fields['CLASS-GUARD'] && fields['CLASS-GUARD'].length >= MIN_REASON) return true;
  return texts.some((t) => {
    const m = NO_PREVENTION_RE.exec(String(t || ''));
    return Boolean(m && m[1].trim().length >= MIN_REASON);
  });
}

// BRO-7301: a real bug card often has a symptom title with no FIX_RE word, so a fix session looked
// like a feature session. The landed commits' subjects are the second witness. FIX_RE itself is
// shared with the Linear Done gate and stays unwidened; this check reads commit subjects instead.
const CONVENTIONAL_RE = /^(\w+)(?:\([^)]*\))?!?:\s*\S/;
// Only real conventional types decide on their own; any other `Word:` prefix ("Census: wrong city",
// "WIP: fixing x") is symptom wording and goes through FIX_RE like an untyped subject.
const FIX_TYPES = new Set(['fix', 'hotfix', 'bugfix']);
const OTHER_TYPES = new Set(['feat', 'feature', 'chore', 'data', 'docs', 'doc', 'audit', 'health', 'refactor', 'test', 'tests', 'ci', 'style', 'perf', 'build', 'revert', 'deps', 'release']);
// A review-round fixup ("Ship-check fixes: ...") and a revert are follow-ups on other work, not a bug fix.
const FOLLOWUP_SUBJECT_RE = /^(?:ship-?check|post-?review|code-?review|review|second-opinion|revert)\b/i;
// A real `git commit` sits at a command boundary; its arguments run to the next unquoted ; & | newline.
const COMMIT_CMD_RE = /(?:^|[\n;&|(])[ \t]*git[ \t]+(?:-[Cc][ \t]+(?:"[^"]*"|'[^']*'|\S+)[ \t]+)?commit\b((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\n;&|"'])*)/g;
const HEREDOC_RE = /<<-?[ \t]*['"]?(\w+)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\1\b/g;
const MSG_ARG_RE = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|[ \t]*)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;
const MCP_COMMIT_TOOL_RE = /__(?:push_files|create_or_update_file)$/;

/**
 * PURE. Does this commit subject read as a fix? A conventional type from the known list decides on
 * its own (`fix` yes; feat/chore/data/docs/... no), because words like "fails" or "Auto-fix" in a
 * feat or data subject must not count. Review-round fixups and reverts are never fixes. Everything
 * else (untyped, or an unknown `Word:` prefix) goes to isFixCard (FIX_RE).
 */
export function isFixSubject(subject) {
  const s = String(subject || '').trim();
  if (!s || FOLLOWUP_SUBJECT_RE.test(s)) return false;
  const m = CONVENTIONAL_RE.exec(s);
  if (m) {
    const type = m[1].toLowerCase();
    if (FIX_TYPES.has(type)) return true;
    if (OTHER_TYPES.has(type)) return false;
  }
  return isFixCard({ title: s });
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

/**
 * PURE. The command with heredoc bodies removed, except a commit message's own `-m "$(cat <<EOF`
 * heredoc, which is folded into a plain `-m "<subject>"`. Text that only mentions `git commit` in a
 * heredoc body (notes, PR bodies, Linear comments) is thereby never read as a commit.
 */
function stripHeredocs(cmd) {
  return cmd.replace(/-([a-zA-Z]*m|-message)([ \t]+|=)"\$\(cat[ \t]*(<<-?[ \t]*['"]?(\w+)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\4\b)[ \t\n]*\)"/g,
    (_, f, sep, _h, _t, body) => `-${f}${sep}"${firstLine(body).replace(/["\\]/g, "'")}"`)
    .replace(HEREDOC_RE, '<<HEREDOC');
}

/**
 * PURE. Subjects of the commits this session made in this repo that reached a landing: successful
 * `git commit -m ...` Bash calls (quoted, `-am`, `--message=`, or a heredoc) and the `message` of a
 * successful MCP push_files / create_or_update_file, all at or before the last landing. A commit
 * made after the final landing never reached main, and a command that targets the iOS repo is not
 * this repo's work. Returns the subjects in order.
 */
export function commitSubjects(events) {
  const landed = landedPushIndices(events);
  if (!landed.length) return [];
  const last = landed[landed.length - 1];
  const failed = new Set();
  for (const e of events) if (e.kind === 'tool_result' && e.isError) failed.add(e.tool_use_id);
  const out = [];
  events.forEach((e, i) => {
    if (i > last || e.kind !== 'assistant_tool_use' || failed.has(e.id)) return;
    if (e.name === 'Bash') {
      const cmd = String(e.input?.command || '');
      if (!/\bgit\b/.test(cmd) || /BroadwayScorecard-app/.test(cmd)) return;
      for (const m of stripHeredocs(cmd).matchAll(COMMIT_CMD_RE)) {
        const q = MSG_ARG_RE.exec(m[1]);
        const subject = q ? firstLine((q[1] ?? q[2]).replace(/\\"/g, '"')) : '';
        if (subject) out.push(subject);
      }
    } else if (MCP_COMMIT_TOOL_RE.test(e.name || '') && e.input?.message) {
      out.push(firstLine(e.input.message));
    }
  });
  return out.filter(Boolean);
}

export function blockBudget(now = new Date()) {
  return now.toISOString().slice(0, 10) >= ROOT_CAUSE_CLOSE_BLOCKING_FROM ? 2 : 1;
}

const MESSAGE = [
  'BLOCKED (BRO-7294, rule 21): this session landed a fix and claims SAFE TO ARCHIVE, but never said whether the fix closes the whole class of problem.',
  'Add ONE of these, either as a line in the closing message or in the Linear Outcome comment for the card:',
  '  CLASS-GUARD: <path of the test, check or guard that fails if this class of bug comes back>',
  '  NO-ROOT-CAUSE: <why this was a spot fix, 10+ chars>',
  'If what you landed were one-record patches (data edits that fix a row, not the cause), find the cause and fix it now. If you cannot, put the NO-ROOT-CAUSE line in the Linear Outcome comment AND tell the owner in plain words in the chat that these were spot fixes and what could cause the same problem again. Plain prose alone does not satisfy this check.',
].join('\n');

/**
 * PURE Stop-hook decision.
 * -> { decision: 'allow'|'block', reason, message? }
 */
export function stopHookDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.ROOT_CAUSE_STOP_DISABLE === '1') return { decision: 'allow', reason: 'ROOT_CAUSE_STOP_DISABLE=1' };
  if (!claimsSafeToArchive(lastMessage)) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  if (landedPushIndices(events).length === 0) return { decision: 'allow', reason: 'nothing landed' };
  const titles = cardTitles(events);
  let fixCommit = null;
  if (titles.length && !titles.some((t) => isFixCard({ title: t }))) {
    fixCommit = commitSubjects(events).find(isFixSubject) || null;
    if (!fixCommit) return { decision: 'allow', reason: 'not a fix card' };
  }
  if (hasRootCauseAnswer(answerTexts(events, lastMessage))) return { decision: 'allow', reason: 'rule-21 answer stated' };
  return { decision: 'block', reason: fixCommit ? `fix commit: ${fixCommit}` : 'landed a fix with no rule-21 answer', message: MESSAGE };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'root-cause-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export function main(argv, { env = process.env, now = new Date() } = {}) {
  if (!argv.includes('--stop-hook')) {
    process.stderr.write('usage: root-cause-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n');
    return 0;
  }
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return 0;
  }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env });
  if (d.decision !== 'block') return 0;
  // Cap blocks per transcript so the check can never loop a session.
  const counter = path.join(os.tmpdir(), `root-cause-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0;
  } catch { /* first block */ }
  const budget = blockBudget(now);
  logHit({ session: input.session_id || null, blocked: n < budget, n, budget, reason: d.reason });
  if (n >= budget) return 0;
  try {
    fs.writeFileSync(counter, String(n + 1));
  } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`root-cause-stop: internal error (failing open): ${e && e.message}\n`);
    code = 0;
  }
  process.exitCode = code;
}
