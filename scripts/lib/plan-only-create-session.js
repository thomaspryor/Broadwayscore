/**
 * plan-only-create-session.js — logic for the advisory PreToolUse hook that flags
 * create_session calls made from a session whose Linear card says plan-only
 * (BRO-6088, follow-up to BRO-6083 bullet 4). Hook: settings.json create_session block.
 *
 * Advisory only (CLAUDE.md §19): never denies, every failure path returns null.
 * The marker is structural (card title, or a description line that STARTS with it) so a
 * card that merely quotes the phrase in prose does not trip it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const reg = require('./coordinator-registry');

const CARD_RE = /\bBRO-\d+\b/g;
const PHRASE = '(?:plan[- ]only|do not implement)';
// Title: phrase leads (after optional `[P1]` / `P1:` prefixes) or sits in brackets. A title that merely
// quotes it ("Flag create_session from a plan-only session") is about plan-only sessions, not one.
const TITLE_RE = new RegExp(`^\\W*(?:(?:\\[[^\\]]*\\]|[A-Za-z0-9-]+:)\\s*)*${PHRASE}\\b(?!\\s*\\?)|[\\[(]${PHRASE}[\\])]`, 'i');
// Description: a line that IS the instruction: phrase then end / punctuation / "session" / "until|yet".
// Not "Do not implement a new scraper" or "## Plan only applies to phase 2".
const LINE_RE = new RegExp(`^[ \\t]*(?:(?:[-*>#]+|\\d+\\.)[ \\t]*)?(?:\\*\\*|__)?[ \\t]*${PHRASE}(?:\\*\\*|__)?[ \\t]*(?:$|[:.!;,)\\u2013\\u2014-]|session\\b|until\\b|yet\\b)`, 'im');
const MAX_CARDS = 5;
const DEADLINE_MS = 14000;
const ENRICH_MS = 4000;

/** Which phrase marks this card plan-only: 'title' | 'description' | null. */
function planOnlyMarker({ title = '', description = '' } = {}) {
  if (TITLE_RE.test(String(title))) return 'title';
  if (LINE_RE.test(String(description))) return 'description';
  return null;
}

function cardIds(text) {
  return [...new Set(String(text || '').match(CARD_RE) || [])];
}

/** First user message text of a Claude Code transcript JSONL ('' when unreadable). */
function firstUserText(transcriptPath, fsImpl = fs) {
  try {
    const fd = fsImpl.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(262144);
    const n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
    fsImpl.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const msg = row && row.message;
      if (!msg || (row.type || msg.role) !== 'user') continue;
      const c = msg.content;
      const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('\n') : '');
      if (row.isMeta || /^\s*<(?:local-)?command-/.test(text)) continue; // caveat / slash-command rows
      if (text.trim()) return text; // skip tool-result-only rows
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * Cards this session works on: claim sentinel (Mac, holds a Linear UUID), the BRO-N in the
 * branch / cwd (headless jobs), and the BRO-N tags in the session's first prompt (works in
 * cloud, where neither of the others exists). Capped; order = most specific first.
 */
function sessionCards({ sessionId = '', branch = '', cwd = '', transcriptPath = '', tmpDir = '/tmp', fsImpl = fs } = {}) {
  const out = [];
  if (/^[\w-]+$/.test(sessionId)) {
    try {
      const v = String(fsImpl.readFileSync(path.join(tmpDir, `linear-issue-claimed-${sessionId}`), 'utf8')).trim();
      if (v) out.push(v);
    } catch { /* no sentinel */ }
  }
  out.push(...cardIds(branch), ...cardIds(cwd));
  if (transcriptPath) out.push(...cardIds(firstUserText(transcriptPath, fsImpl)).slice(0, 1)); // the dispatch tag; later ids are mere references
  return [...new Set(out)].slice(0, MAX_CARDS);
}

/**
 * @returns {Promise<{additionalContext?: string, systemMessage?: string}|null>}
 */
async function evaluate(input, { fetchCard, startReminder, env = process.env, branch = '', tmpDir, fsImpl } = {}) {
  if (env.PLAN_ONLY_CREATE_SESSION_DISABLE) return null;
  // The settings block also matches add_repo/send_later/etc.; only create_session starts a session.
  if (!/__create_session$/.test(String((input && input.tool_name) || ''))) return null;
  const ti = (input && input.tool_input) || {};
  const cards = sessionCards({ sessionId: input.session_id, branch, cwd: input.cwd, transcriptPath: input.transcript_path, tmpDir, fsImpl });
  if (!cards.length) return null;
  const fetched = await Promise.all(cards.map(async (c) => ({ ref: c, card: await fetchCard(c) })));
  const hit = fetched.find(({ card }) => card && card.ok && planOnlyMarker(card));
  if (!hit) {
    const err = fetched.every(({ card }) => !card || !card.ok);
    return err ? { systemMessage: `plan-only check skipped: could not read ${cards.join(', ')} (${(fetched[0].card && fetched[0].card.error) || 'no answer'})` } : null;
  }
  const id = hit.card.identifier || hit.ref;
  const prompt = String(ti.prompt || '') + '\n' + String(ti.title || '');
  const areas = reg.areasForText(prompt);
  let reminder = '';
  if (areas.length && startReminder) {
    let t; // the finding is already established: a slow coordinator lookup only drops the reminder
    reminder = await Promise.race([startReminder(prompt, { exclude: id }).catch(() => ''), new Promise((r) => { t = setTimeout(() => r(''), ENRICH_MS); })]);
    clearTimeout(t);
  }
  const lines = [
    `PLAN-ONLY CARD: ${id}${hit.card.title ? ` ("${hit.card.title}")` : ''} is marked plan-only (${planOnlyMarker(hit.card)}), but this session is starting a new session with create_session.`,
    'A plan-only session writes the plan and stops; it does not start implementation sessions (2026-10-23: a planning session started four code sessions on its own, BRO-6083). If the owner asked you to start this one, continue; otherwise do not, and put the proposed sessions in the plan instead.',
  ];
  if (reminder) lines.push(reminder);
  return { additionalContext: lines.join('\n') };
}

/** Run evaluate() under an overall deadline; null on timeout or any error. */
async function evaluateWithDeadline(input, deps, ms = DEADLINE_MS) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([evaluate(input, deps).catch(() => null), timeout]); } finally { clearTimeout(timer); }
}

function toHookOutput(result) {
  if (!result) return null;
  const out = {};
  if (result.additionalContext) out.hookSpecificOutput = { hookEventName: 'PreToolUse', additionalContext: result.additionalContext };
  if (result.systemMessage) out.systemMessage = result.systemMessage;
  return Object.keys(out).length ? out : null;
}

module.exports = { planOnlyMarker, cardIds, firstUserText, sessionCards, evaluate, evaluateWithDeadline, toHookOutput };
