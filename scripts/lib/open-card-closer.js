/**
 * open-card-closer.js — pure planner for BRO-4523.
 *
 * done-evidence-audit.json (shadow) lists open cards whose own evidence already
 * holds on main (STUCK), and open In Review cards whose check fails
 * (openCheckFails). The recheck ledger records passes for paused cards. Nothing
 * acted on either. This decides what to do; scripts/close-verified-open-cards.js
 * performs it (the Done gate in linear-brain re-runs the evidence on fresh main,
 * so a wrong plan cannot close a card whose check does not pass).
 *
 * Pure: no network, no clock (callers pass `now`).
 */
'use strict';

const IDLE_MS = 24 * 3600 * 1000;
const MAX_BOUNCES = 2;
const BOUNCE_MARKER = '<!-- open-card-closer:bounce -->';
const CLOSE_MARKER = '<!-- open-card-closer:close -->';
const CLOSABLE_AUDIT_STATES = new Set(['In Review', 'In Progress']);
const TERMINAL_TYPES = new Set(['completed', 'canceled']);
const HOLD_LABELS = new Set(['awaiting-owner', 'blocked']);
const BRO_ID = /^BRO-\d+$/;

function ts(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Latest of updatedAt and newest comment createdAt; null if unknown. */
function lastActivityMs(card) {
  const times = [ts(card && card.updatedAt)];
  for (const c of (card && card.comments) || []) times.push(ts(c && c.createdAt));
  const known = times.filter((t) => t !== null);
  return known.length ? Math.max(...known) : null;
}

function countBounces(card) {
  return ((card && card.comments) || []).filter((c) => c && typeof c.body === 'string' && c.body.includes(BOUNCE_MARKER)).length;
}

/** Ids whose recheck ledger row (same UTC day as `now`) says pass. */
function ledgerPassIds(ledgerRows, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const ids = new Set();
  for (const r of ledgerRows || []) {
    if (!r || r.event !== 'recheck' || r.status !== 'pass') continue;
    if (typeof r.ts !== 'string' || !r.ts.startsWith(day)) continue;
    if (BRO_ID.test(String(r.cardId || ''))) ids.add(r.cardId);
  }
  return ids;
}

/**
 * @param {object} o
 * @param {object[]} o.auditRows  done-evidence-audit.json `results`
 * @param {object[]} o.ledgerRows recheck-ledger rows
 * @param {(id:string)=>object|null} o.getCard fresh read: {state,stateType,updatedAt,comments:[{body,createdAt}],labels:[string]}
 * @param {number} o.now epoch ms
 * @returns {{id:string, action:'close'|'bounce'|'skip', reason:string, detail?:string}[]}
 */
function planOpenCardActions({ auditRows, ledgerRows, getCard, now }) {
  const plan = [];
  const seen = new Set();
  const closeIds = new Set();
  for (const r of auditRows || []) {
    if (r && r.verdict === 'STUCK' && CLOSABLE_AUDIT_STATES.has(r.state)) closeIds.add(r.id);
  }
  for (const id of ledgerPassIds(ledgerRows, now)) closeIds.add(id);
  const bounceRows = new Map();
  for (const r of auditRows || []) {
    if (r && r.openCheckFails === true && r.state === 'In Review') bounceRows.set(r.id, r);
  }

  const gate = (id) => {
    const card = getCard(id);
    if (!card) return { skip: 'card could not be re-read' };
    if (TERMINAL_TYPES.has(card.stateType) || card.state === 'Done') return { skip: 'already terminal' };
    if ((card.labels || []).some((l) => HOLD_LABELS.has(String(l).toLowerCase()))) return { skip: 'held by label' };
    const last = lastActivityMs(card);
    if (last === null) return { skip: 'no activity timestamp' };
    if (now - last < IDLE_MS) return { skip: 'active within the last 24h' };
    return { card };
  };

  for (const id of [...closeIds].sort()) {
    seen.add(id);
    const g = gate(id);
    if (g.skip) { plan.push({ id, action: 'skip', reason: g.skip }); continue; }
    plan.push({ id, action: 'close', reason: 'its own check passes on main and the card has been idle >=24h' });
  }
  for (const [id, row] of [...bounceRows].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.has(id)) continue;
    const g = gate(id);
    if (g.skip) { plan.push({ id, action: 'skip', reason: g.skip }); continue; }
    if (g.card.state !== 'In Review') { plan.push({ id, action: 'skip', reason: `no longer In Review (${g.card.state})` }); continue; }
    const n = countBounces(g.card);
    if (n >= MAX_BOUNCES) { plan.push({ id, action: 'skip', reason: `bounce cap reached (${n}/${MAX_BOUNCES})` }); continue; }
    plan.push({ id, action: 'bounce', reason: `In Review but its own check fails on main (bounce ${n + 1}/${MAX_BOUNCES})`, detail: row.detail || '' });
  }
  return plan;
}

function buildCloseComment(reason) {
  return `${CLOSE_MARKER}\nAuto-closed (BRO-4523): ${reason}. The Done gate re-ran the card's evidence on fresh main before accepting this.`;
}

function buildBounceComment({ cmd, detail, n }) {
  return `${BOUNCE_MARKER}\nBounced to Todo (BRO-4523, bounce ${n}/${MAX_BOUNCES}): this card sat In Review for >=24h but its own check fails on main${cmd ? ` (\`${cmd}\`)` : ''}${detail ? `: ${detail}` : ''}. Re-dispatching a worker to land the fix and run the check on main before reporting done.`;
}

module.exports = {
  IDLE_MS, MAX_BOUNCES, BOUNCE_MARKER, CLOSE_MARKER,
  lastActivityMs, countBounces, ledgerPassIds, planOpenCardActions, buildCloseComment, buildBounceComment,
};
