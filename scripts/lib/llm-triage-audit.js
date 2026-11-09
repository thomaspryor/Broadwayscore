'use strict';
/**
 * llm-triage-audit.js — PURE judging rules for the weekly llm-triage audit (BRO-7139 Step 3,
 * plan item 8). Each nomination in data/audit/llm-triage.jsonl is re-checked against what
 * happened afterwards: the card's Linear state (archived included), landings on main naming
 * it, its comments, and, when run locally, its own VERIFY on main now.
 *
 * judgeNomination returns right | wrong | pending with a short enum reason. pending is never
 * counted in the wrong-rate: it means the evidence that decides it has not happened yet.
 * Rows written here are public (ids, enums, dates only), like the triage ledger.
 */
const { OWNER_ANSWERED_COMMENT_RE } = require('./headless-dispatchability.js');
const { isBotComment } = require('./llm-triage-facts.js');

const DAY_MS = 86400000;
const SAMPLE = 40;
const MIN_AGE_DAYS = 7; // keep and close-candidate need 7 days of evidence; younger rows would only read pending
const KEEP_WINDOW_DAYS = 7;
const CLOSE_SETTLE_DAYS = 7;
const AUDIT_LEDGER_PATH = 'data/audit/llm-triage-audit.jsonl';
const THROTTLE_DAYS = 6;

const ms = (x) => { const t = Date.parse(x); return Number.isFinite(t) ? t : null; };
// Machine commits name cards too (ledger/audit refreshes); they are not work on the card.
const BOT_COMMIT_RE = /\[skip ci\]|^(data|audit|chore\(data\)):/i;
const isWorkLanding = (l) => !BOT_COMMIT_RE.test(String((l && l.subject) || ''));
// Verdicts whose "right" is informative. release/blocked are nearly always right (the card or
// blocker was open), so only their wrong outcomes count toward the wrong-rate (conservative).
const SCORED = new Set(['close-candidate', 'keep', 'ask-owner', 'recheck']);
const counts = (i) => i.judgment === 'wrong' || (i.judgment === 'right' && SCORED.has(i.verdict));

/**
 * @param {{id, ts, verdict, recheck_after, blocked_on}} row a triage ledger row
 * @param {{closedAt?: string|null, comments?: Array<{body, createdAt}>, landings?: Array<{date}>|null,
 *          blockerClosedAt?: string|null, verify?: 'pass'|'fail'|'not-run'}} out what happened
 * @returns {{judgment: 'right'|'wrong'|'pending', why: string}}
 */
function judgeNomination(row, out, { nowMs }) {
  const ts = ms(row.ts);
  if (ts == null) return { judgment: 'pending', why: 'bad-ts' };
  const age = nowMs - ts;
  const closedAt = ms(out.closedAt);
  const completedAt = ms(out.completedAt);
  const works = out.landings == null ? null : out.landings.filter(isWorkLanding);
  const comments = (out.comments || []).map((c) => ({ body: String(c.body || ''), at: ms(c.createdAt) })).filter((c) => c.at != null);
  const landedAfter = works == null ? null : works.some((l) => (ms(l.date) || 0) > ts);
  const closedBefore = closedAt != null && closedAt <= ts;
  const v = row.verdict;

  if (v === 'close-candidate') {
    if (closedBefore) return { judgment: 'right', why: 'already-closed' };
    if (landedAfter == null) return { judgment: 'pending', why: 'landings-unknown' };
    if (landedAfter) return { judgment: 'wrong', why: 'landing-after-nomination' };
    if (out.verify === 'fail') return { judgment: 'wrong', why: 'verify-fails-now' };
    if (age < CLOSE_SETTLE_DAYS * DAY_MS) return { judgment: 'pending', why: 'too-soon' };
    return { judgment: 'right', why: 'no-later-work' };
  }
  // Every other verdict says work or a decision is still open: wrong if the card was already closed.
  if (closedBefore) return { judgment: 'wrong', why: 'closed-before-nomination' };

  if (v === 'release') return { judgment: 'right', why: 'open-at-nomination' };

  if (v === 'blocked') {
    if (!row.blocked_on) return { judgment: 'wrong', why: 'no-blocker-named' };
    if (out.blockerClosedAt === undefined) return { judgment: 'pending', why: 'blocker-unknown' };
    const b = ms(out.blockerClosedAt);
    if (b != null && b <= ts) return { judgment: 'wrong', why: 'blocker-closed-before' };
    return { judgment: 'right', why: 'blocker-open-at-nomination' };
  }

  if (v === 'keep') {
    const end = ts + KEEP_WINDOW_DAYS * DAY_MS;
    if (works && works.some((l) => { const t = ms(l.date); return t != null && t > ts && t <= end; })) return { judgment: 'right', why: 'landed-in-window' };
    if (comments.some((c) => c.at > ts && c.at <= end && !isBotComment(c.body))) return { judgment: 'right', why: 'worker-active' };
    if (closedAt != null && closedAt > ts && closedAt <= end) return { judgment: 'right', why: 'closed-in-window' };
    if (nowMs < end) return { judgment: 'pending', why: 'too-soon' };
    if (out.commentsTruncated) return { judgment: 'pending', why: 'comments-truncated' };
    if (works == null) return { judgment: 'pending', why: 'landings-unknown' };
    return { judgment: 'wrong', why: 'no-worker-activity-7d' };
  }

  if (v === 'ask-owner') {
    if (out.commentsTruncated) return { judgment: 'pending', why: 'comments-truncated' };
    const answers = comments.filter((c) => OWNER_ANSWERED_COMMENT_RE.test(c.body));
    if (answers.some((c) => c.at <= ts)) {
      // An earlier answer only makes this wrong when no new question came after it.
      const lastAnswer = Math.max(...answers.filter((c) => c.at <= ts).map((c) => c.at));
      const askedAgain = comments.some((c) => c.at > lastAnswer && c.at <= ts && /DECISION NEEDED/i.test(c.body) && !OWNER_ANSWERED_COMMENT_RE.test(c.body));
      if (!askedAgain) return { judgment: 'wrong', why: 'already-answered' };
    }
    if (answers.some((c) => c.at > ts)) return { judgment: 'right', why: 'owner-answered' };
    return { judgment: 'pending', why: 'unanswered' };
  }

  if (v === 'recheck') {
    const due = ms(row.recheck_after);
    if (due == null) return { judgment: 'wrong', why: 'no-recheck-date' };
    if (nowMs < due + DAY_MS) return { judgment: 'pending', why: 'not-due' };
    if (out.verify === 'fail') return { judgment: 'wrong', why: 'verify-fails-after-date' };
    // Only a completion counts as held: a cancel says nothing about the recheck.
    if (out.verify === 'pass' || (completedAt != null && completedAt > ts)) return { judgment: 'right', why: 'held' };
    return { judgment: 'pending', why: 'recheck-unresolved' };
  }
  return { judgment: 'pending', why: 'unknown-verdict' };
}

const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/**
 * Nominations to audit: CI rows with a verdict, at least MIN_AGE_DAYS old, latest per card,
 * a deterministic hash-ordered sample (stable week to week, so pending ones get re-judged).
 */
function sampleNominations(rows, { nowMs, n = SAMPLE, includeLocal = false, settled = new Set() } = {}) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!r || !r.verdict || !/^BRO-\d+$/.test(String(r.id))) continue;
    if (!includeLocal && r.source !== 'ci') continue;
    const t = ms(r.ts);
    if (t == null || nowMs - t < MIN_AGE_DAYS * DAY_MS) continue;
    const k = `${r.id}|${r.ts}`;
    if (!settled.has(k)) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => hash(`${a.id}|${a.ts}`) - hash(`${b.id}|${b.ts}`) || a.id.localeCompare(b.id) || a.ts.localeCompare(b.ts)).slice(0, n);
}

/** id|ts keys an earlier audit already judged right or wrong (never re-sampled). */
function settledKeys(auditRows) {
  const out = new Set();
  for (const r of auditRows || []) for (const i of (r && r.items) || []) if (i.judgment === 'right' || i.judgment === 'wrong') out.add(`${i.id}|${i.nominatedTs}`);
  return out;
}

/** One public audit ledger row. */
function auditRow(items, { ts, source, runId = null }) {
  const judged = items.filter((i) => i.judgment !== 'pending');
  const scored = items.filter(counts);
  const wrong = judged.filter((i) => i.judgment === 'wrong').length;
  const byVerdict = {};
  for (const i of items) {
    const b = byVerdict[i.verdict] || (byVerdict[i.verdict] = { right: 0, wrong: 0, pending: 0 });
    b[i.judgment]++;
  }
  return {
    v: 1, ts, source, runId, sampled: items.length, judged: judged.length, wrong, pending: items.length - judged.length,
    scored: scored.length, wrongRate: scored.length ? Math.round((wrong / scored.length) * 1000) / 1000 : null, byVerdict,
    items: items.map((i) => ({ id: i.id, nominatedTs: i.nominatedTs, verdict: i.verdict, judgment: i.judgment, why: i.why })),
  };
}

/** True when the last CI audit is newer than THROTTLE_DAYS (the step runs nightly, audits weekly). */
function auditedRecently(auditRows, nowMs, days = THROTTLE_DAYS) {
  return (auditRows || []).some((r) => r && r.source === 'ci' && !r.error && r.judged > 0 && nowMs - (ms(r.ts) || 0) < days * DAY_MS);
}

/**
 * Every distinct nomination's newest judgment across all audit rows: {right, wrong, judged, wrongRate}.
 * The acceptance criterion reads this, so a nomination re-judged weekly counts once.
 */
function cumulativeJudgments(auditRows, { includeLocal = false } = {}) {
  const last = new Map();
  for (const r of auditRows || []) {
    if (!includeLocal && (!r || r.source !== 'ci')) continue;
    for (const i of (r && r.items) || []) {
      const k = `${i.id}|${i.nominatedTs}`;
      const prev = last.get(k);
      if (!prev || (ms(r.ts) || 0) >= prev.at) last.set(k, { at: ms(r.ts) || 0, judgment: i.judgment, verdict: i.verdict });
    }
  }
  let right = 0; let wrong = 0; let scored = 0;
  for (const it of last.values()) {
    if (it.judgment === 'right') right++; else if (it.judgment === 'wrong') wrong++;
    if (counts(it)) scored++;
  }
  return { right, wrong, judged: right + wrong, scored, wrongRate: scored ? wrong / scored : null };
}

module.exports = { SAMPLE, MIN_AGE_DAYS, AUDIT_LEDGER_PATH, THROTTLE_DAYS, isWorkLanding, judgeNomination, sampleNominations, settledKeys, auditRow, auditedRecently, cumulativeJudgments };
