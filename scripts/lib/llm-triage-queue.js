'use strict';
/**
 * llm-triage-queue.js — PURE helpers for the nightly, report-only llm-triage run (BRO-7139 Step 2).
 *
 * selectQueue: which cards tonight's run reads. Only cards the board classifier puts in a
 * category the llm-triage handler owns (board-categories.js CATEGORIES handlers), oldest
 * first, skipping cards triaged within COOLDOWN_DAYS, capped at CAP. Nothing else on the
 * board is read, so a card text the prompt treats as untrusted never reaches a model unless
 * the board already reports it as llm-triage's.
 *
 * ledgerRow: one JSON line per triaged card for data/audit/llm-triage.jsonl. Rows are
 * nominations only; nothing here or in llm-triage.js writes Linear. The repo is public, so a
 * row carries ids, enums and dates only: never the model's reason/question/verify text, which
 * paraphrases card text and owner decisions. Consumers that need the words re-run the triage
 * on the ids (llm-triage.js --ids=... --out=FILE) into a temp file.
 */
const { CATEGORIES } = require('./board-categories.js');

const CAP = 25;
const COOLDOWN_DAYS = 7;
const ERROR_COOLDOWN_DAYS = 1;
const LEDGER_PATH = 'data/audit/llm-triage.jsonl';
const DAY_MS = 86400000;
// Cron start times drift by minutes; a card triaged at 02:16 must be due again 7 nights later
// even when that night starts at 02:15.
const COOLDOWN_SLACK_MS = 6 * 3600000;

/** Category keys whose handlers include llm-triage. */
function ownedCategories(categories = CATEGORIES) {
  return categories.filter((c) => (c.handlers || []).includes('llm-triage')).map((c) => c.key);
}

/** Parse JSONL text into row objects, skipping blank and broken lines. */
function parseLedger(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line must not stop the run */ }
  }
  return rows;
}

/**
 * Cards to triage tonight.
 * @param {{cards: Array<{identifier, category, createdAt}>}} board categorizeBoard() output
 * @param {Array<{id, ts}>} ledgerRows previous rows
 * @returns {{ids: string[], eligible: number, cooling: number}}
 */
function selectQueue(board, ledgerRows, { nowMs, cap = CAP, cooldownDays = COOLDOWN_DAYS, categories = CATEGORIES } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('selectQueue needs nowMs');
  const owned = new Set(ownedCategories(categories));
  const lastSeen = new Map();
  for (const r of ledgerRows || []) {
    if (!r || !r.id) continue;
    // A failed triage cools for ERROR_COOLDOWN_DAYS only: retried soon, but a card that always
    // errors cannot take a cap slot every night.
    const t = Date.parse(r.ts) - (r.error ? (cooldownDays - ERROR_COOLDOWN_DAYS) * DAY_MS : 0);
    if (Number.isFinite(t) && t > (lastSeen.get(r.id) || 0)) lastSeen.set(r.id, t);
  }
  const eligible = ((board && board.cards) || []).filter((c) => c && /^BRO-\d+$/.test(c.identifier) && owned.has(c.category));
  const fresh = eligible.filter((c) => !(lastSeen.has(c.identifier) && nowMs - lastSeen.get(c.identifier) < cooldownDays * DAY_MS - COOLDOWN_SLACK_MS));
  // Never-triaged cards first, then the longest since last triage, then the oldest card. Pure
  // oldest-first would let the oldest cap*cooldown cards rotate forever and starve new ones.
  const seen = (c) => lastSeen.get(c.identifier) || 0;
  fresh.sort((a, b) => seen(a) - seen(b) || (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.identifier.localeCompare(b.identifier));
  return { ids: fresh.slice(0, Math.max(0, cap)).map((c) => c.identifier), eligible: eligible.length, cooling: eligible.length - fresh.length };
}

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

const VERDICTS = new Set(['close-candidate', 'blocked', 'release', 'ask-owner', 'recheck', 'keep']);
const FACT_STATES = new Set(['pass', 'fail', 'none', 'unsafe', 'not-run', 'firing', 'recovered', 'unknown']);
const idOrNull = (x) => (/^BRO-\d+$/.test(String(x || '')) ? String(x) : null);
const dateOrNull = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
const enumOrNull = (x, set) => (set.has(x) ? x : null);
// Errors are ours or the API's; keep the kind, drop anything after it (a bad-JSON message can
// quote the model's reply).
const errorKind = (e) => clip(String(e).split(/[:\n]/)[0].replace(/[^\w .\-]/g, ''), 60);

/** One public ledger row from an llm-triage result row ({id, facts?, verdict?, error?}). */
function ledgerRow(result, { ts, source, runId = null, model = null, category = null }) {
  const v = result.verdict || null;
  const f = result.facts || {};
  return {
    v: 1, ts, source, runId, model, id: idOrNull(result.id), category: category || f.CATEGORY || null,
    verdict: v ? enumOrNull(v.verdict, VERDICTS) : null,
    has_question: v ? !!v.question : null,
    has_verify: v ? !!v.verify : null,
    default_allowed: v ? (v.default_allowed == null ? null : !!v.default_allowed) : null,
    recheck_after: v ? dateOrNull(v.recheck_after) : null,
    duplicate_of: v ? idOrNull(v.duplicate_of) : null,
    blocked_on: v ? idOrNull(v.blocked_on) : null,
    facts: { verify: enumOrNull(f.VERIFY_RESULT, FACT_STATES), condition: enumOrNull(f.CONDITION_STATE, FACT_STATES), landed: f.LANDINGS ? !/^none\b/i.test(String(f.LANDINGS)) : null },
    error: result.error ? errorKind(result.error) : null,
  };
}

module.exports = { CAP, COOLDOWN_DAYS, ERROR_COOLDOWN_DAYS, LEDGER_PATH, ownedCategories, parseLedger, selectQueue, ledgerRow };
