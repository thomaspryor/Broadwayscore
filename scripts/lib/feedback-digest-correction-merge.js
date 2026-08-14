'use strict';

/**
 * Merges same-run feedback submissions that are corrections/follow-ups of an
 * earlier submission for the same show, before categorization/diagnosis.
 *
 * Why this exists (card #1427, GH #567): a user submitted "add David Coddon's
 * Vanguard Culture review of 3 Summers of Lincoln", then 3 minutes later
 * corrected it ("actually his Stage West column, not Vanguard Culture"). Both
 * submissions were fetched in the same process-feedback.js run, but each was
 * categorized/diagnosed/issued independently — every downstream issue body
 * embeds exactly one `submission.message`, so the correction never reached
 * issue #567 or anywhere else. It was silently discarded.
 *
 * Pure function — no I/O, no GitHub calls. Merges submissions for the SAME
 * run only (cross-run corrections, arriving after the original's issue was
 * already created, are a separate problem). Tested in
 * scripts/lib/feedback-digest-correction-merge.test.mjs.
 */

const { normalizeTitle } = require('./title-match');

function submissionTimestamp(sub) {
  const raw = sub && (sub._date || sub.createdAt);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function normalizedShow(sub) {
  // The Formspree endpoint is a public form — a non-browser POST can send
  // `show` as an array/object (repeated form keys), and normalizeTitle()
  // assumes a string and throws on anything else. A thrown error here is
  // unguarded at the call site and would take down the whole run (thank-you
  // emails, diagnosis, digest) over one malformed submission.
  const show = sub && sub.show;
  return typeof show === 'string' && show ? normalizeTitle(show) : '';
}

function submissionIdOf(sub) {
  return sub && (sub._id || sub.id || sub.createdAt || sub._date);
}

/**
 * Identity key used to require corrections come from the SAME submitter.
 * Without this, two different users submitting about the same popular show
 * within the merge window (plausible on an opening-night traffic spike)
 * would collapse into one submission — the second person's message gets
 * silently folded in as an anonymous "correction" and their name/email
 * (and thank-you email) disappear. Email is the strongest signal; falls
 * back to normalized name only when email is absent. Returns null when
 * neither is present — those submissions never match each other, so two
 * anonymous reports can't be wrongly merged.
 */
function submitterKey(sub) {
  const email = sub && sub.email && String(sub.email).trim().toLowerCase();
  if (email) return `email:${email}`;
  const name = sub && sub.name && String(sub.name).trim().toLowerCase();
  if (name) return `name:${name}`;
  return null;
}

/**
 * Combine 2+ raw submissions (earliest first) for the same show into one
 * submission object. Keeps the earliest submission's identity (name, email,
 * show, user-selected category) but concatenates every message so a single
 * categorization/diagnosis/issue sees the full thread.
 */
function buildMergedSubmission(parts) {
  const primary = parts[0];
  const primaryTs = submissionTimestamp(primary);
  const blocks = parts.slice(1).map((p) => {
    const ts = submissionTimestamp(p);
    const mins = primaryTs !== null && ts !== null ? Math.round((ts - primaryTs) / 60000) : null;
    const label = mins !== null ? `Correction/follow-up sent ~${mins} min later` : 'Correction/follow-up';
    return `--- ${label} ---\n${p.message || ''}`;
  });
  const mergedMessage = [primary.message || '', ...blocks].join('\n\n');
  return {
    ...primary,
    message: mergedMessage,
    _mergedSubmissionIds: parts.map(submissionIdOf).filter(Boolean),
    _isMergedCorrection: true,
  };
}

/**
 * @param {Array<object>} submissions Raw Formspree submissions (unfiltered order preserved).
 * @param {object} [opts]
 * @param {number} [opts.windowMs=300000] Max gap (ms) between consecutive same-show
 *   submissions to still count as one correction thread. Default 5 minutes.
 * @returns {Array<object>} Same-length-or-shorter array: merged threads replace
 *   their members at the position of the earliest member; unmatched submissions
 *   pass through unchanged.
 */
function mergeCorrectionSubmissions(submissions, opts = {}) {
  const windowMs = opts.windowMs ?? 5 * 60 * 1000;
  const list = Array.isArray(submissions) ? submissions : [];
  if (list.length < 2) return list.slice();

  const meta = list.map((sub, idx) => ({
    sub, idx, ts: submissionTimestamp(sub), show: normalizedShow(sub), key: submitterKey(sub),
  }));
  // Only submissions with a usable timestamp, a show name, AND an identifiable
  // submitter (email or name) can be matched — anything else (no show field,
  // unparseable date, fully anonymous) passes through untouched. The
  // submitter key is required so two DIFFERENT people reporting the same show
  // in the same window never merge into one — see submitterKey() above.
  const matchable = meta.filter((m) => m.ts !== null && m.show && m.key);
  const byTime = [...matchable].sort((a, b) => a.ts - b.ts || a.idx - b.idx);

  const groups = [];
  for (const entry of byTime) {
    const openGroup = groups.find((g) => {
      const last = g.members[g.members.length - 1];
      return g.show === entry.show && g.key === entry.key && entry.ts - last.ts <= windowMs;
    });
    if (openGroup) {
      openGroup.members.push(entry);
    } else {
      groups.push({ show: entry.show, key: entry.key, members: [entry] });
    }
  }

  const groupByIdx = new Map();
  for (const g of groups) {
    if (g.members.length < 2) continue; // solo submission — nothing to merge
    for (const m of g.members) groupByIdx.set(m.idx, g);
  }

  const emitted = new Set();
  const result = [];
  for (let idx = 0; idx < list.length; idx++) {
    const g = groupByIdx.get(idx);
    if (!g) {
      result.push(list[idx]);
      continue;
    }
    if (emitted.has(g)) continue; // already emitted at this group's earliest position
    emitted.add(g);
    // Sort by real timestamp, not array index — Formspree's submissions API
    // is not documented/verified as return-order-stable, and buildMergedSubmission
    // treats parts[0] as the earliest (keeps its identity, labels the rest
    // "sent N min later"). Sorting by idx alone would silently invert that
    // if the API ever returns newest-first.
    const ordered = [...g.members].sort((a, b) => a.ts - b.ts || a.idx - b.idx).map((m) => m.sub);
    result.push(buildMergedSubmission(ordered));
  }
  return result;
}

module.exports = { mergeCorrectionSubmissions, submissionIdOf, submissionTimestamp, normalizedShow, submitterKey };
