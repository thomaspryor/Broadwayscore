#!/usr/bin/env node
// BRO-7985: the final message of a LONG cloud session must recap the whole session, not just the last turn.
// Owner, 2026-11-21: "I had to scroll up so high on this message thread to even be able to remember what we did
// recently." A real long session ended "Nothing changed since my last message", which tells the owner nothing.
//
// Fires only on a SAFE TO ARCHIVE ending (KEEP OPEN and ACTION NEEDED are exempt) in a long session: the session
// landed changes (a land push) OR the owner wrote 3+ messages. The message must then carry a whole-session recap:
// a "This session:" line followed by 1 to 5 plain-English lines with no card ids, file paths or commit hashes.
// Short sessions are exempt. Cloud only, fails open on any error, up to MAX_NUDGES blocks per transcript.
// Kill switch SESSION_RECAP_STOP_DISABLE=1; one-off bypass `NO-RECAP: <reason, 10+ chars>` in the closing message.
// Wired in .claude/hooks/verify-edits.sh as [VE:RECAP]; pinned by session-recap-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTranscript } from './transcript-scan.mjs';
import { landedPushIndices, claimsSafeToArchive } from './review-coverage.mjs';
import { isMainModule } from './is-main-module.mjs';

export const MAX_LINES = 5;
export const MIN_OWNER_MESSAGES = 3;
export const MAX_NUDGES = 3;

const RECAP_HEAD_RE = /^[*_>#\s]*This session[*_\s]*:[*_\s]*(.*)$/i;
// Lines that end the recap: the next owner-format section, the verdict, a decision block.
const SECTION_RE = /^(?:(?:DISPATCHED|DEFERRED|HANDOFF PROMPT|PR-BLOCKER|NO-[A-Z-]+|EXECUTED|PREVENTION|ROOT-CAUSE|CLASS-GUARD|COUSINS|EFFECT|RED-THEN-GREEN|WORKTREE):|Still running\b|Nothing is still running|You need to\b|Nothing needed from you|DECISION NEEDED\b|Why this is your call|Option [AB]\b|My recommendation|Default:|SAFE TO (?:ARCHIVE|EXIT)\b|KEEP OPEN\b|ACTION NEEDED FROM YOU\b|You can remove the worktree|Keep the worktree)/i;
const ID_RE = /\b(?!COVID\b)[A-Z]{2,6}-\d{2,}\b/;
const CODE_RE = /`/;
// A recap line that says nothing was done is the failure this gate exists to stop ("Nothing changed since my last message").
const EMPTY_RE = /^(?:nothing (?:has )?changed|no (?:new )?changes|nothing (?:new|to report|else)|same as (?:before|above)|see (?:above|earlier|my last message))\b/i;
const PATH_RE = /(?:^|[\s`'"(])(?:(?:src|scripts|data|memory|public|node_modules|\.claude|\.github)\/\S+|[\w.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|sh|yml|yaml|css)\b)/;
const HASH_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;

const clean = (l) => l.trim().replace(/^[*_>#\s]+(?=This session)/i, '');

/** PURE. The recap in a message: { found, lines } (lines are the 1..n recap lines, bullet marks stripped). */
export function parseRecap(message) {
  const text = String(message || '').replace(/```[\s\S]*?```/g, '');
  const all = text.split('\n');
  let head = -1;
  for (let i = all.length - 1; i >= 0; i--) { if (RECAP_HEAD_RE.test(clean(all[i]))) { head = i; break; } }
  if (head < 0) return { found: false, lines: [] };
  const lines = [];
  const first = clean(all[head]).match(RECAP_HEAD_RE)[1].trim();
  if (first) lines.push(first);
  for (let i = head + 1; i < all.length; i++) {
    const l = all[i].trim();
    if (!l) { if (lines.length) break; else continue; }
    const body = l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^\*\*|\*\*$/g, '').trim();
    if (SECTION_RE.test(body)) break;
    lines.push(body);
  }
  return { found: true, lines };
}

/** PURE. Messages the owner typed (not hook feedback, notifications, peer messages or compaction summaries). */
export function ownerMessageCount(events) {
  return (events || []).filter((e) => e.kind === 'user_text' && !e.synthetic && !e.foreignTurn && String(e.text || '').trim()).length;
}

const SHAPE = 'Write it as a line "This session:" followed by up to 5 short plain-English lines, one per thing that was built or fixed, written for someone who has not read this thread. No card ids, file paths or commit hashes.';
const HOW = 'Build it from the whole session, not the last turn: list the Linear cards you worked (their titles and Outcome comments) and the land pushes you made (`git log origin/main --oneline` shows what each land carried), then say each in plain words. Put it just above "Still running:".';
const MSG = {
  missing: (why) => `Recap missing: this was a long session (${why}) and you are closing SAFE TO ARCHIVE, but the final message has no whole-session recap (BRO-7985, owner 2026-11-21: "I had to scroll up so high ... to remember what we did"). ${SHAPE} ${HOW} Bypass: NO-RECAP: <reason, 10+ chars>.`,
  empty: `Recap empty: "This session:" has no lines under it. ${SHAPE} ${HOW} Bypass: NO-RECAP: <reason, 10+ chars>.`,
  toolong: (n) => `Recap too long: ${n} lines under "This session:", the limit is ${MAX_LINES}. Merge related items and keep the five that matter most to the owner. ${HOW} Bypass: NO-RECAP: <reason, 10+ chars>.`,
  leak: (what) => `Recap has ${what} in it. The owner is not technical: say what changed in plain words and keep card ids, file paths and commit hashes in the Linear Outcome comment. ${SHAPE} Bypass: NO-RECAP: <reason, 10+ chars>.`,
};

/** PURE Stop-hook decision. -> { decision: 'allow'|'block', reason, message? } */
export function sessionRecapDecision({ lastMessage = '', events = null, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.SESSION_RECAP_STOP_DISABLE === '1') return { decision: 'allow', reason: 'SESSION_RECAP_STOP_DISABLE=1' };
  if (!claimsSafeToArchive(lastMessage)) return { decision: 'allow', reason: 'not claiming SAFE TO ARCHIVE' };
  if (/^[ \t>*_-]*NO-RECAP:[ \t]*\S.{9,}/m.test(lastMessage)) return { decision: 'allow', reason: 'NO-RECAP bypass' };
  if (!events || events.length === 0) return { decision: 'allow', reason: 'no transcript (fails open)' };
  const landed = landedPushIndices(events).length;
  const owner = ownerMessageCount(events);
  if (landed === 0 && owner < MIN_OWNER_MESSAGES) return { decision: 'allow', reason: 'short session (nothing landed, under 3 owner messages)' };
  const why = [landed ? 'it landed changes' : '', owner >= MIN_OWNER_MESSAGES ? `${owner} owner messages` : ''].filter(Boolean).join(' and ');
  const { found, lines } = parseRecap(lastMessage);
  if (!found) return { decision: 'block', reason: 'no recap', message: MSG.missing(why) };
  if (lines.length === 0) return { decision: 'block', reason: 'empty recap', message: MSG.empty };
  if (lines.length > MAX_LINES) return { decision: 'block', reason: 'recap too long', message: MSG.toolong(lines.length) };
  const body = lines.join('\n');
  if (lines.every((l) => EMPTY_RE.test(l))) return { decision: 'block', reason: 'recap says nothing', message: MSG.empty };
  if (ID_RE.test(body)) return { decision: 'block', reason: 'recap has a card id', message: MSG.leak('a card id') };
  if (CODE_RE.test(body)) return { decision: 'block', reason: 'recap has code', message: MSG.leak('code in backticks') };
  if (PATH_RE.test(body)) return { decision: 'block', reason: 'recap has a file path', message: MSG.leak('a file path') };
  if (HASH_RE.test(body)) return { decision: 'block', reason: 'recap has a commit hash', message: MSG.leak('a commit hash') };
  return { decision: 'allow', reason: 'recap present' };
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'session-recap-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export function main(argv, { env = process.env } = {}) {
  if (!argv.includes('--stop-hook')) {
    process.stderr.write('usage: session-recap-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n');
    return 0;
  }
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return 0;
  const d = sessionRecapDecision({ lastMessage: input.last_assistant_message || '', events: walkTranscript(tp), env });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `session-recap-stop-${createHash('sha1').update(tp).digest('hex').slice(0, 12)}`);
  let count = 0;
  try { count = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first time */ }
  logHit({ session: input.session_id || null, blocked: count < MAX_NUDGES, nudge: count + 1, reason: d.reason });
  if (count >= MAX_NUDGES) return 0;
  try { fs.writeFileSync(counter, String(count + 1)); } catch { /* best effort */ }
  process.stderr.write((count > 0 ? `(Repeat ${count + 1} of ${MAX_NUDGES}: closing again does not clear this. Add the recap, or write NO-RECAP: <reason>.)\n` : '') + d.message + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`session-recap-stop: internal error (failing open): ${e && e.message}\n`);
  }
  process.exitCode = code;
}
