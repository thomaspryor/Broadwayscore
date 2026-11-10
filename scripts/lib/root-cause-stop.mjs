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
// (isFixCard), the check stays quiet. A session whose card title is unknown is checked.
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

// First -m of a commit: a quoted subject, or the first line of a `"$(cat <<'EOF' ...)"` heredoc.
// One alternation, so whichever -m comes first wins and a later heredoc body never overrides it.
const COMMIT_MSG_RE = /(?:\s-[a-zA-Z]*m|\s--message=?)\s*(?:"\$\(cat\s*<<-?\s*['"]?(\w+)['"]?[ \t]*\n([^\n]*)|"((?:[^"\\]|\\.)*)"|'([^']*)')/;
const FILE_HEREDOC_RE = /\s(?:-F\s*-|--file=?\s*-)\s*<<-?\s*['"]?(\w+)['"]?[ \t]*\n([^\n]*)/;
const GIT_COMMIT_RE = /^\s*git(?:\s+-[Cc]\s+\S+)*\s+commit\b/;
const COMMIT_OK_RE = /\[[^\]\n]+ [0-9a-f]{7,}\]/;
const COMMIT_FAIL_RE = /nothing (?:added )?to commit|no changes added|^error:|^fatal:|hook failed|pre-commit.*(?:failed|error)/im;
const CONVENTIONAL_RE = /^(feat|fix|chore|docs|refactor|test|tests|perf|style|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;

/** PURE. Split a shell command on unquoted && ; || | and newlines (quotes, and so heredoc-in-quotes, stay whole). */
function splitShell(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += cmd[++i] ?? '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === '\\') cur += c + (cmd[++i] ?? '');
    else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      segs.push(cur); cur = '';
    } else cur += c;
  }
  segs.push(cur);
  return segs;
}

/**
 * PURE. Subjects of the commits this session made: the first -m (quoted or heredoc) or `-F - <<EOF`
 * subject of each `git commit` that did not fail, and the `message` of the connector's GitHub
 * file-push tools (the cloud landing path has no git commit command).
 */
export function commitSubjects(events) {
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.tool_use_id, e]));
  const out = [];
  for (const e of events) {
    if (e.kind !== 'assistant_tool_use') continue;
    const r = results.get(e.id);
    if (!r) continue;
    if (e.name === 'Bash') {
      const text = String(r.content || '');
      // A piped commit exits 0 when git refused it, so judge the output: a failure marker with no
      // `[branch sha]` success line means nothing was committed.
      if ((r.isError || COMMIT_FAIL_RE.test(text)) && !COMMIT_OK_RE.test(text)) continue;
      const cmd = String(e.input?.command || '');
      const fileHd = FILE_HEREDOC_RE.exec(cmd);
      for (const seg of splitShell(cmd)) {
        if (!GIT_COMMIT_RE.test(seg)) continue;
        const m = COMMIT_MSG_RE.exec(seg);
        const s = m ? (m[2] ?? m[3] ?? m[4]) : fileHd && fileHd[2];
        if (s && s.trim()) out.push(s.trim());
      }
      if (!out.length && fileHd && /\bgit\b[^\n]*\scommit\b/.test(cmd) && fileHd[2].trim()) out.push(fileHd[2].trim());
    } else if (!r.isError && /^mcp__github__(?:push_files|create_or_update_file)$/.test(e.name || '') && e.input?.message) {
      out.push(String(e.input.message).split('\n')[0].trim());
    }
  }
  return out;
}

/**
 * PURE. Does a commit subject read as a fix? A conventional type decides on its own (so
 * "feat: add missing X" is a feature); otherwise the card-title test applies after dropping a
 * leading "BRO-123:" tag. FIX_RE is shared with the Linear Done gate, so it is not widened here.
 * Known trade-off: "ship-check fixes" reads as a fix, so a feature session that lands one gets a
 * single reminder (block budget 1); that is the wording the real BRO-7129 incident used.
 */
export function subjectReadsAsFix(subject) {
  const s = String(subject || '').trim().replace(/^(?:BRO-\d+\s*[:\-–]?\s*)+/i, '');
  if (/^revert\b/i.test(s)) return false;
  const c = CONVENTIONAL_RE.exec(s);
  if (c) return c[1].toLowerCase() === 'fix';
  return isFixCard({ title: s });
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
  // BRO-7301: titles describe symptoms, so a bug card often has no fix word. A feature-looking
  // title is only trusted when the commits it landed do not read as fixes either.
  if (titles.length && !titles.some((t) => isFixCard({ title: t })) && !commitSubjects(events.slice(0, Math.max(...landedPushIndices(events)) + 1)).some(subjectReadsAsFix)) return { decision: 'allow', reason: 'not a fix card' };
  if (hasRootCauseAnswer(answerTexts(events, lastMessage))) return { decision: 'allow', reason: 'rule-21 answer stated' };
  return { decision: 'block', reason: 'landed a fix with no rule-21 answer', message: MESSAGE };
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
  logHit({ session: input.session_id || null, blocked: n < budget, n, budget });
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
