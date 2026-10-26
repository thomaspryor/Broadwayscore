/**
 * BRO-6336: the owner digest of commercial items the automatic path could not verify. Two sources:
 *   - archive records moved out of pending because no cited page confirmed the figure (archivedReason
 *     'unverified-figure'), and
 *   - pending entries only a person can settle (autoApplyBlocked, e.g. a recoupment claim or a held row).
 * Each item is emailed once: the sender stamps ownerDigestSentAt on the record it reported.
 */
'use strict';

const { UNVERIFIED_REASON } = require('./pending-verify-policy');

const money = (n) => (typeof n === 'number' ? `$${(n / 1e6).toFixed(1)}M` : null);

function claimOf(e) {
  const parts = [];
  if (e.capitalization != null) parts.push(`capitalization ${money(e.capitalization) || e.capitalization}`);
  if (e.weeklyRunningCost != null) parts.push(`weekly cost ${money(e.weeklyRunningCost) || e.weeklyRunningCost}`);
  if (e.recouped === true) parts.push(`recouped${e.recoupedDate ? ` (${e.recoupedDate})` : ''}`);
  else if (e.recouped === false) parts.push('did not recoup');
  if (e.closingDate) parts.push(`closing ${e.closingDate}`);
  return parts.join(', ') || 'a commercial update';
}

function sourceOf(e) {
  const urls = [];
  const add = (u) => { if (typeof u === 'string' && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  if (Array.isArray(e.sources)) for (const s of e.sources) add(s && s.url);
  const m = typeof e.recoupedSource === 'string' ? e.recoupedSource.match(/https?:\/\/[^\s)\]>"']+/) : null;
  if (m) add(m[0].replace(/[.,;:!?]+$/, ''));
  return urls[0] || null;
}

/** Items not yet emailed: [{ id, kind, show, claim, source, why }]. */
function collectUnsent({ pending, archive }) {
  const items = [];
  for (const [key, rec] of Object.entries((archive && archive.shows) || {})) {
    if (rec && rec.archivedReason === UNVERIFIED_REASON && !rec.ownerDigestSentAt) {
      items.push({ id: `archive:${key}`, kind: 'unverified', show: rec.pendingKey || key, claim: claimOf(rec), source: sourceOf(rec), why: rec.archivedDetail || 'no cited page confirms it' });
    }
  }
  for (const [key, e] of Object.entries((pending && pending.shows) || {})) {
    if (e && e.autoApplyBlocked && !e.ownerDigestSentAt && !e.ownerDigestHold) {
      items.push({ id: `pending:${key}`, kind: 'needs-you', show: key, claim: claimOf(e), source: sourceOf(e), why: e.autoApplyBlocked });
    }
  }
  return items;
}

/** Plain-text email body; null when there is nothing new to say. */
function buildDigest(items) {
  if (!items.length) return null;
  const lines = items.map((i) => `${i.show}: ${i.claim}\n  Why it could not be checked: ${i.why}\n  Source: ${i.source || 'none cited'}`);
  const n = items.length;
  return {
    title: `${n} Profitability Scorecard item${n === 1 ? '' : 's'} the automatic check could not confirm`,
    description: `These figures and news items did not pass the source check, so nothing was published from them. Each is listed once.\n\n${lines.join('\n\n')}`,
  };
}

/** Stamps the reported records (mutates pending/archive) after a delivered email. */
function markSent({ pending, archive }, items, now = new Date().toISOString()) {
  for (const i of items) {
    const [where, ...rest] = i.id.split(':');
    const key = rest.join(':');
    const rec = where === 'archive' ? archive.shows[key] : pending.shows[key];
    if (rec) rec.ownerDigestSentAt = now;
  }
}

module.exports = { collectUnsent, buildDigest, markSent };
