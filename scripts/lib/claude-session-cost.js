'use strict';

/**
 * claude-session-cost.js (BRO-5671): the Claude cloud-session cost ledger and its 7-day summary.
 *
 * Why: no Claude spend was recorded after the one-off ccusage snapshot (data/audit/ccusage-2026-09-*),
 * so the system could not see its own cost per landed card (BRO-5668 sampled 30 sessions by hand).
 *
 * The cost source is the claude-code-remote `get_session` tool (ccr.external_metadata.usage.cost_usd),
 * which GitHub Actions cannot call. So a cloud session that has get_session records the rows:
 *   1. `node scripts/record-claude-session-cost.js --list` prints the sessions that landed commits in
 *      the last 24h (Claude-Session trailers) and the cards each landed;
 *   2. it calls get_session for each and pipes the results to `--from-json`.
 * The digest (board-numbers.js) and validate-data.js only read the ledger, so it works from Actions;
 * the one writer is claude-session-cost-writer.js (kept apart so readers carry no write path).
 *
 * COST IS CUMULATIVE. A session alive for days is recorded on several days with a growing cost_usd,
 * so a window's spend per session is (latest cost in the window) - (latest cost before it), never a sum.
 * A session first recorded inside the window has no baseline, so its whole lifetime cost lands there:
 * that spend went into the cards it landed, and no earlier window counted it. Only sessions that
 * landed commits are recorded, so this is cost per LANDED card, not total account spend.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_REL = 'data/audit/claude-session-cost.jsonl';
const SESSION_RE = /\bsession_[A-Za-z0-9]{8,}\b/;
const SESSION_TRAILER_RE = /^Claude-Session:\s*\S*?(session_[A-Za-z0-9]{8,})/gm;
const CARD_RE = /\bBRO-\d+\b/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400 * 1000;

/** opus | sonnet | haiku | codex | other, from any model string. */
function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'codex']) if (m.includes(f)) return f;
  return 'other';
}

/** PURE. Problems with one ledger row ([] = valid). */
function validateRow(row) {
  const errs = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['not an object'];
  if (!DATE_RE.test(String(row.date || ''))) errs.push('date must be YYYY-MM-DD');
  if (!SESSION_RE.test(String(row.session || ''))) errs.push('session must be a session_… id');
  if (typeof row.model !== 'string' || !row.model) errs.push('model must be a non-empty string');
  if (typeof row.origin !== 'string') errs.push('origin must be a string');
  if (typeof row.costUsd !== 'number' || !Number.isFinite(row.costUsd) || row.costUsd < 0) errs.push('costUsd must be a finite number >= 0');
  if (!Array.isArray(row.cards) || row.cards.some((c) => !/^BRO-\d+$/.test(String(c)))) errs.push('cards must be an array of BRO-N ids');
  return errs;
}

/** PURE. JSONL text -> { rows, errors:[{line, problems}] }. Blank lines are skipped. */
function parseLedger(text) {
  const rows = [];
  const errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let row;
    try { row = JSON.parse(line); } catch (e) { errors.push({ line: i + 1, problems: ['not JSON'] }); return; }
    const problems = validateRow(row);
    if (problems.length) errors.push({ line: i + 1, problems });
    else rows.push(row);
  });
  return { rows, errors };
}

function ledgerPath(repoRoot) {
  return path.join(repoRoot || path.resolve(__dirname, '..', '..'), LEDGER_REL);
}

/** Ledger rows from disk; a missing file is { rows: [], errors: [], missing: true }. */
function readLedger({ file = ledgerPath(), readFile = fs.readFileSync } = {}) {
  let text;
  try { text = readFile(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { rows: [], errors: [], missing: true };
    throw e;
  }
  return { ...parseLedger(text), missing: false };
}

/**
 * PURE. `git log --format=%ct%x09%B%x00` text -> Map(sessionId -> { cards:Set, lastMs }).
 * A commit counts when its message has a Claude-Session trailer; its cards are the BRO ids in its subject.
 */
function sessionsFromGitLog(text) {
  const out = new Map();
  for (const rec of String(text || '').split('\0')) {
    const body = rec.replace(/^\s+/, '');
    const tab = body.indexOf('\t');
    if (tab < 0) continue;
    const ms = Number(body.slice(0, tab)) * 1000;
    const msg = body.slice(tab + 1);
    const sessions = [...msg.matchAll(SESSION_TRAILER_RE)].map((m) => m[1]);
    if (!sessions.length) continue;
    // Cards from the SUBJECT only, as landedPerLane counts them: bodies cite related cards
    // ("BRO-5668 sampled ...") that this session did not land.
    const cards = (msg.split('\n')[0].match(CARD_RE) || []);
    for (const s of sessions) {
      const e = out.get(s) || { cards: new Set(), lastMs: 0 };
      cards.forEach((c) => e.cards.add(c));
      e.lastMs = Math.max(e.lastMs, Number.isFinite(ms) ? ms : 0);
      out.set(s, e);
    }
  }
  return out;
}

/** Sessions that landed commits on `ref` in the last `hours` (git read; injectable exec). */
function landedSessions({ cwd, hours = 24, ref = 'origin/main', exec = require('child_process').execFileSync } = {}) {
  const text = exec('git', ['log', ref, `--since=${hours}.hours`, '--format=%ct%x09%B%x00'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return sessionsFromGitLog(text);
}

/**
 * PURE. One get_session result (object or JSON text) -> { session, costUsd, model, origin } or
 * { error }. Reads ccr.external_metadata.usage.cost_usd; the other fields are best-effort.
 */
function parseGetSession(result) {
  let j = result;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return { error: 'get_session result is not JSON' }; } }
  if (!j || typeof j !== 'object') return { error: 'get_session result is empty' };
  const ccr = j.ccr || j;
  const session = String(ccr.id || ccr.session_id || '');
  if (!SESSION_RE.test(session)) return { error: 'get_session result has no session id' };
  const meta = ccr.external_metadata || {};
  const usage = meta.usage || {};
  const field = usage.cost_usd !== undefined ? 'cost_usd' : usage.total_cost_usd !== undefined ? 'total_cost_usd' : null;
  if (!field) return { session, error: 'no external_metadata.usage.cost_usd' };
  const raw = usage[field];
  // Only a real number (or numeric text): '' / false / null would read as $0 and understate spend.
  const cost = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN);
  if (!Number.isFinite(cost) || cost < 0) return { session, error: `usage.${field} is not a number: ${JSON.stringify(raw)}` };
  // Named fields only (no deep search): a nested tool config's "model" must not label the session.
  const model = ccr.model || meta.model || usage.model || (ccr.session_context && ccr.session_context.model) || ccr.configured_model;
  const origin = ccr.initiation || meta.origin || meta.initiation || ccr.title || '';
  return { session, costUsd: Math.round(cost * 10000) / 10000, model: model ? String(model) : 'unknown', origin: String(origin).slice(0, 120) };
}

/**
 * PURE. Spend over the `days` before `nowMs` from ledger rows.
 * Per session: latest cost on a window date minus latest cost before the window (cumulative cost).
 * Cards: distinct BRO ids on the window's rows. -> { totalUsd, sessions, cards, perCardUsd, byModel:{family:{usd,sessions}} }
 */
function summarizeCost(rows, { nowMs = Date.now(), days = 7 } = {}) {
  const startDate = new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
  const endDate = new Date(nowMs).toISOString().slice(0, 10);
  const bySession = new Map();
  const sorted = [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const r of sorted) {
    const s = bySession.get(r.session) || { before: 0, inWindow: null, model: r.model, cards: new Set() };
    if (r.date <= startDate) s.before = Math.max(s.before, r.costUsd);
    else if (r.date <= endDate) {
      s.inWindow = Math.max(s.inWindow ?? 0, r.costUsd);
      s.model = r.model;
      r.cards.forEach((c) => s.cards.add(c));
    }
    bySession.set(r.session, s);
  }
  const cards = new Set();
  const byModel = {};
  let total = 0;
  let sessions = 0;
  for (const s of bySession.values()) {
    if (s.inWindow === null) continue;
    const usd = Math.max(0, s.inWindow - s.before);
    sessions += 1;
    total += usd;
    s.cards.forEach((c) => cards.add(c));
    const fam = modelFamily(s.model);
    byModel[fam] = byModel[fam] || { usd: 0, sessions: 0 };
    byModel[fam].usd += usd;
    byModel[fam].sessions += 1;
  }
  return { totalUsd: total, sessions, cards: cards.size, perCardUsd: cards.size ? total / cards.size : null, byModel, startDate, endDate };
}

/**
 * PURE. Codex runner run-summary comments (on the runner card, daily-runner.js) -> Claude-check
 * spend and cards landed. Reads "- Claude check: N review(s), $X API cost" and the two Landed lines.
 */
function summarizeCodexCheck(comments, { nowMs = Date.now(), days = 7 } = {}) {
  // One parser for the runner summary (codex-runner.js runnerSummaryFacts), so a format change there is seen here.
  const { runnerSummaryFacts } = require('./codex-runner.js');
  const since = nowMs - days * DAY_MS;
  let usd = 0;
  let runs = 0;
  const landed = new Set();
  for (const c of comments || []) {
    const t = Date.parse(c.createdAt);
    if (!Number.isFinite(t) || t < since || t > nowMs) continue;
    const f = runnerSummaryFacts(c.body);
    if (!f.hasCheckLine) continue;
    runs += 1;
    usd += f.checkUsd;
    f.landedIds.forEach((id) => landed.add(id));
  }
  return { usd, runs, cards: landed.size, perCardUsd: landed.size ? usd / landed.size : null };
}

const money = (v) => `$${Number(v).toFixed(2)}`;

/** One digest line. claude/codex may be null (unread) -> "n/a". */
function renderCostLine({ claude, codex, days = 7 } = {}) {
  const parts = [];
  if (!claude) parts.push('n/a');
  else if (!claude.sessions) parts.push('nothing recorded');
  else {
    const fams = Object.entries(claude.byModel).sort((a, b) => b[1].usd - a[1].usd).map(([f, v]) => `${f[0].toUpperCase()}${f.slice(1)} ${money(v.usd)}`);
    parts.push(`${money(claude.totalUsd)} over ${claude.cards} cards (${claude.perCardUsd === null ? 'n/a' : money(claude.perCardUsd)}/card)${fams.length ? `; ${fams.join(', ')}` : ''}`);
  }
  parts.push(codex
    ? `Codex check ${money(codex.usd)} (${codex.perCardUsd === null ? 'n/a' : `${money(codex.perCardUsd)}/card`})`
    : 'Codex check n/a');
  return `Claude cost, ${days} days: ${parts.join('; ')}`;
}

module.exports = {
  LEDGER_REL, modelFamily, validateRow, parseLedger, ledgerPath, readLedger, sessionsFromGitLog, landedSessions,
  parseGetSession, summarizeCost, summarizeCodexCheck, renderCostLine,
};
