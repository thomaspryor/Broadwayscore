/**
 * Opening-night broadcast refresh + reminder rules (BRO-6634).
 *
 * Owner ask 2026-10-30: while a show's opening-night email has not gone out,
 * every change to the numbers the email shows (the rounded Critic Score and
 * the review count) should reach the owner right away: the unsent Resend draft
 * is updated in place with the new numbers and the owner is emailed that it
 * changed. No approval step: the owner sends from Resend. A draft that sits
 * unsent gets a reminder every REMINDER_GAP_HOURS, up to MAX_REMINDERS.
 *
 * Pure functions over the opening-night-sent.json `shows` map. "Numbers" are
 * always { [showId]: { score, reviewCount } } with score already rounded the
 * way the email and the site display it. Nothing here sends anything: the
 * workflow and scripts/remind-unsent-broadcast-draft.js do, draft-only and
 * owner-only (CLAUDE.md §17).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REMINDER_GAP_HOURS = 6;
const MAX_REMINDERS = 3;

const displayScore = cs => (typeof cs === 'number' && Number.isFinite(cs) ? Math.round(cs) : null);

// Numbers as the email shows them, from the showsForEmail rows the broadcast
// script builds (score = public show JSON cs, reviewCount = rc).
function numbersFromEmailRows(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || !r.showId) continue;
    out[r.showId] = { score: displayScore(r.score), reviewCount: Number.isFinite(r.reviewCount) ? r.reviewCount : null };
  }
  return out;
}

// Same numbers read from the per-show public JSON the email is built from.
function readShowNumbers(showId, dir = path.join(__dirname, '..', '..', 'public', 'data', 'shows')) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${showId}.json`), 'utf8'));
    return { score: displayScore(j.cs), reviewCount: Number.isFinite(j.rc) ? j.rc : null };
  } catch {
    return null;
  }
}

// True when any show's displayed numbers differ. A show missing on either
// side is a difference only if the other side has numbers for it.
function numbersDiffer(was, now) {
  if (!was || !now) return false;
  const ids = new Set([...Object.keys(was), ...Object.keys(now)]);
  for (const id of ids) {
    const a = was[id];
    const b = now[id];
    if (!a || !b) return true;
    if (a.score !== b.score || a.reviewCount !== b.reviewCount) return true;
  }
  return false;
}

const isPreviewKey = k => k.startsWith('preview:');
const isRecordKey = k => !isPreviewKey(k) && !k.startsWith('push:') && !k.startsWith('overdue-alert:');

// preview:<market>:<id+id>:<YYYY-MM-DD> → [id, id]
function previewKeyIds(key) {
  const parts = key.split(':');
  if (parts.length < 4) return [];
  return parts.slice(2, -1).join(':').split('+').filter(Boolean);
}

// Latest preview entry (any combo) that covers this show.
function latestPreviewForShow(sentShows, showId) {
  let best = null;
  for (const [key, v] of Object.entries(sentShows || {})) {
    if (!isPreviewKey(key) || !v || !v.sentAt) continue;
    if (!previewKeyIds(key).includes(showId)) continue;
    if (!best || v.sentAt > best.sentAt) best = v;
  }
  return best;
}

// An unsent Resend draft the owner has not discarded.
function isUnsentDraft(r) {
  return !!(r && r.completed && r.draftId && r.draftStatus === 'draft' && !r.sentAt && !r.discardedAt);
}

// Draft records keyed by broadcastKey (`<market>:<id+id>`), skipping the
// per-show mirrors (they carry `broadcastKey`).
function unsentDraftRecords(sentShows) {
  const out = [];
  for (const [key, r] of Object.entries(sentShows || {})) {
    if (!isRecordKey(key) || !key.includes(':') || r?.broadcastKey) continue;
    if (!isUnsentDraft(r)) continue;
    const [market, ids] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1).split('+').filter(Boolean)];
    out.push({ broadcastKey: key, market, ids, record: r });
  }
  return out;
}

// The numbers a draft was built with: stamped since BRO-6634, else the last
// preview of each show (the draft run follows the preview in the same run).
function draftBaseline(sentShows, entry) {
  if (entry.record.draftNumbers) return entry.record.draftNumbers;
  const out = {};
  for (const id of entry.ids) {
    const p = latestPreviewForShow(sentShows, id);
    const n = p && p.shows && p.shows[id];
    if (!n) return null;
    out[id] = n;
  }
  return out;
}

// True when the draft shows different numbers from `now`. With no baseline
// (a draft made before BRO-6634 whose previews carry no per-show numbers, e.g.
// A Few Good Men's), fall back to the review count the record was stamped
// with: a count move is a change; the score at draft time is unknown.
function draftChanged(was, now, record) {
  if (was) return numbersDiffer(was, now);
  if (!Number.isFinite(record && record.reviewCount)) return false;
  const total = Object.values(now).reduce((a, n) => a + (n && Number.isFinite(n.reviewCount) ? n.reviewCount : 0), 0);
  return total !== record.reviewCount;
}

/**
 * Unsent drafts whose numbers moved, so the workflow updates them.
 * @param {object} sentShows      opening-night-sent.json `shows`
 * @param {function} readNumbers  showId → {score, reviewCount} | null
 * @param {string[]} [onlyIds]    restrict to drafts whose shows are all in here (ready set)
 * @returns {{broadcastKey, market, ids, was, now}[]}
 */
function draftsNeedingRefresh(sentShows, readNumbers, onlyIds = null) {
  const allow = onlyIds ? new Set(onlyIds) : null;
  const out = [];
  for (const e of unsentDraftRecords(sentShows)) {
    if (allow && !e.ids.every(id => allow.has(id))) continue;
    const was = draftBaseline(sentShows, e);
    const now = {};
    let complete = true;
    for (const id of e.ids) {
      const n = readNumbers(id);
      if (!n || n.reviewCount == null) { complete = false; break; }
      now[id] = n;
    }
    if (!complete || !draftChanged(was, now, e.record)) continue;
    out.push({ broadcastKey: e.broadcastKey, market: e.market, ids: e.ids, was, now });
  }
  return out;
}

/**
 * Decide whether `--update-unsent-draft` should PATCH the draft recorded under
 * broadcastKey with the numbers the email now shows.
 * @returns {{action:'skip', reason:string} | {action:'update', record:object, was:object}}
 */
function unsentDraftUpdatePlan(sentShows, broadcastKey, nowNumbers) {
  const record = (sentShows || {})[broadcastKey];
  if (!isUnsentDraft(record)) return { action: 'skip', reason: `no unsent draft is recorded for ${broadcastKey}` };
  const ids = broadcastKey.slice(broadcastKey.indexOf(':') + 1).split('+').filter(Boolean);
  const was = draftBaseline(sentShows, { ids, record });
  if (!draftChanged(was, nowNumbers, record)) return { action: 'skip', reason: 'the draft already shows these numbers' };
  return { action: 'update', record, was };
}

// Stamp an in-place draft update on the record and its per-show mirrors.
// draftCreatedAt and the reminder fields are kept, so the reminder clock
// still runs from when the draft first appeared.
function stampDraftUpdate(sentShows, broadcastKey, numbers, at, reviewCount) {
  const rec = sentShows[broadcastKey];
  if (!rec) return;
  for (const [key, r] of Object.entries(sentShows)) {
    if (key === broadcastKey || (r && r.broadcastKey === broadcastKey && r.draftId === rec.draftId)) {
      sentShows[key] = { ...r, draftNumbers: numbers, draftUpdatedAt: at, reviewCount };
    }
  }
}

/**
 * Unsent drafts due a "you have not sent this yet" reminder: last created,
 * updated or reminded REMINDER_GAP_HOURS+ ago, fewer than MAX_REMINDERS so far.
 */
function remindersDue(sentShows, nowMs = Date.now()) {
  const out = [];
  for (const e of unsentDraftRecords(sentShows)) {
    const r = e.record;
    if ((r.draftReminderCount || 0) >= MAX_REMINDERS) continue;
    // An "updated with new numbers" email is also a nudge, so it restarts the gap.
    const last = Math.max(...[r.draftCreatedAt, r.draftReminderAt, r.draftUpdatedAt].map(x => Date.parse(x || '')).filter(Number.isFinite));
    if (!Number.isFinite(last)) continue;
    const hours = (nowMs - last) / 3_600_000;
    if (hours < REMINDER_GAP_HOURS) continue;
    const created = Date.parse(r.draftCreatedAt || '');
    out.push({ ...e, hoursSince: hours, draftAgeHours: Number.isFinite(created) ? (nowMs - created) / 3_600_000 : null });
  }
  return out;
}

// Stamp a sent reminder on the draft record and its per-show mirrors.
function stampReminder(sentShows, broadcastKey, at) {
  const rec = sentShows[broadcastKey];
  if (!rec) return;
  const count = (rec.draftReminderCount || 0) + 1;
  for (const [key, r] of Object.entries(sentShows)) {
    if (key === broadcastKey || (r && r.broadcastKey === broadcastKey && r.draftId === rec.draftId)) {
      sentShows[key] = { ...r, draftReminderAt: at, draftReminderCount: count };
    }
  }
}

module.exports = {
  REMINDER_GAP_HOURS, MAX_REMINDERS,
  displayScore, numbersFromEmailRows, readShowNumbers, numbersDiffer,
  previewKeyIds, latestPreviewForShow, isUnsentDraft, unsentDraftRecords,
  draftBaseline, draftChanged, draftsNeedingRefresh, remindersDue, stampReminder,
  unsentDraftUpdatePlan, stampDraftUpdate,
};
