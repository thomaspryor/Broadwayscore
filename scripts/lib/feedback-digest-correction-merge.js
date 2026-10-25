'use strict';

/**
 * Merges same-run submissions that are corrections/follow-ups of an earlier
 * submission, before downstream processing (categorization/diagnosis for
 * feedback; GitHub issue creation for review submissions).
 *
 * Why this exists (card #1427, GH #567): a user submitted "add David Coddon's
 * Vanguard Culture review of 3 Summers of Lincoln", then 3 minutes later
 * corrected it ("actually his Stage West column, not Vanguard Culture"). Both
 * submissions were fetched in the same process-feedback.js run, but each was
 * categorized/diagnosed/issued independently — every downstream issue body
 * embeds exactly one `submission.message`, so the correction never reached
 * issue #567 or anywhere else. It was silently discarded.
 *
 * Card #1498 found the same structural bug in process-review-formspree.js
 * (separate Formspree form/pipeline, one GitHub issue per submission) — a
 * corrected review URL/show name sent minutes after the original is a
 * separate submission with no merge logic. mergeReviewSubmissionCorrections()
 * below reuses the same grouping core with review-submission field names.
 *
 * Pure functions — no I/O, no GitHub calls. Merges submissions for the SAME
 * run only (cross-run corrections, arriving after the original's issue was
 * already created, are a separate problem). Tested in
 * scripts/lib/feedback-digest-correction-merge.test.mjs and
 * scripts/lib/review-submission-correction-merge.test.mjs.
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
 * Groups a submission list into correction threads (same identity + same
 * group key, consecutive gaps within windowMs) and folds each thread through
 * buildMerged. Shared by mergeCorrectionSubmissions (feedback) and
 * mergeReviewSubmissionCorrections (review submissions) — only the
 * field-extraction functions differ between the two pipelines.
 *
 * @param {Array<object>} submissions Raw Formspree submissions (unfiltered order preserved).
 * @param {object} opts
 * @param {number} opts.windowMs Max gap (ms) between consecutive same-key
 *   submissions to still count as one correction thread.
 * @param {(sub: object) => string} opts.getGroupKey Normalized key submissions
 *   must share to be considered the same thread (e.g. show name). Falsy = unmatchable.
 * @param {(sub: object) => string|null} opts.getIdentityKey Submitter identity key.
 *   Null = unmatchable (never merged with anything).
 * @param {(parts: object[]) => object} opts.buildMerged Combines 2+ ordered
 *   (earliest-first) raw submissions into one merged submission object.
 * @returns {Array<object>} Same-length-or-shorter array: merged threads replace
 *   their members at the position of the earliest member; unmatched submissions
 *   pass through unchanged.
 */
function mergeSubmissionsCore(submissions, { windowMs, getGroupKey, getIdentityKey, buildMerged }) {
  const list = Array.isArray(submissions) ? submissions : [];
  if (list.length < 2) return list.slice();

  const meta = list.map((sub, idx) => ({
    sub, idx, ts: submissionTimestamp(sub), show: getGroupKey(sub), key: getIdentityKey(sub),
  }));
  // Only submissions with a usable timestamp, a group key (e.g. show name),
  // AND an identifiable submitter can be matched — anything else (no show
  // field, unparseable date, fully anonymous) passes through untouched. The
  // identity key is required so two DIFFERENT people reporting the same show
  // in the same window never merge into one.
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
    // is not documented/verified as return-order-stable, and buildMerged
    // implementations treat parts[0] as the earliest. Sorting by idx alone
    // would silently invert that if the API ever returns newest-first.
    const ordered = [...g.members].sort((a, b) => a.ts - b.ts || a.idx - b.idx).map((m) => m.sub);
    result.push(buildMerged(ordered));
  }
  return result;
}

/**
 * @param {Array<object>} submissions Raw Formspree submissions (unfiltered order preserved).
 * @param {object} [opts]
 * @param {number} [opts.windowMs=300000] Max gap (ms) between consecutive same-show
 *   submissions to still count as one correction thread. Default 5 minutes.
 * @returns {Array<object>} See mergeSubmissionsCore.
 */
function mergeCorrectionSubmissions(submissions, opts = {}) {
  const windowMs = opts.windowMs ?? 5 * 60 * 1000;
  return mergeSubmissionsCore(submissions, {
    windowMs,
    getGroupKey: normalizedShow,
    getIdentityKey: submitterKey,
    buildMerged: buildMergedSubmission,
  });
}

// --- Review-submission (process-review-formspree.js / card #1498) adapter ---
// Different Formspree form, different field names: show_name (not show),
// submitter_email (not email/name), and structured review_url/outlet_name/
// critic_name/notes fields (not a single free-text message).

function normalizedReviewShow(sub) {
  const show = sub && sub.show_name;
  return typeof show === 'string' && show ? normalizeTitle(show) : '';
}

/**
 * Identity key for review submissions. The form only collects an optional
 * email (no name field) — submissions without one are never matched, so two
 * anonymous submitters can't be wrongly merged. See submitterKey() above for
 * the same rationale on the feedback side.
 */
function reviewSubmitterKey(sub) {
  const email = sub && sub.submitter_email && String(sub.submitter_email).trim().toLowerCase();
  return email ? `email:${email}` : null;
}

/**
 * Per field, the most recent part that actually set it (non-empty) wins.
 * Falls back toward earlier parts rather than blindly taking the latest
 * part's value — the submit-review form resets between submissions
 * (SubmitReviewForm.tsx `form.reset()`), so a correction that only re-types
 * the URL naturally leaves optional fields (notes, critic_name, outlet_name)
 * blank. Spreading the latest part verbatim would silently blank out real
 * values the original submission had instead of carrying them forward.
 */
function latestNonEmpty(parts, field) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const v = parts[i][field];
    if (v) return v;
  }
  return parts[parts.length - 1][field];
}

/**
 * Combine 2+ raw review-submission parts (earliest first) into one. Unlike
 * feedback's free-text message concatenation, a review-submission correction
 * replaces structured fields (a wrong URL, wrong show name) rather than
 * adding to them — so each field's most-recently-set value wins (the
 * corrected info), while every part's values are preserved in
 * _correctionHistory for the human reviewer and issue body.
 */
function buildMergedReviewSubmission(parts) {
  const earliest = parts[0];
  const latest = parts[parts.length - 1];
  const earliestTs = submissionTimestamp(earliest);
  const history = parts.map((p, i) => {
    const ts = submissionTimestamp(p);
    const mins = i > 0 && earliestTs !== null && ts !== null ? Math.round((ts - earliestTs) / 60000) : null;
    const label = i === 0 ? 'Original submission' : mins !== null ? `Correction sent ~${mins} min later` : 'Correction';
    const fields = [
      p.review_url && `Review URL: ${p.review_url}`,
      p.show_name && `Show Name: ${p.show_name}`,
      p.outlet_name && `Outlet Name: ${p.outlet_name}`,
      p.critic_name && `Critic Name: ${p.critic_name}`,
      p.notes && `Notes: ${p.notes}`,
    ].filter(Boolean).join('\n');
    return `--- ${label} ---\n${fields}`;
  });
  return {
    ...latest,
    review_url: latestNonEmpty(parts, 'review_url'),
    show_name: latestNonEmpty(parts, 'show_name'),
    outlet_name: latestNonEmpty(parts, 'outlet_name'),
    critic_name: latestNonEmpty(parts, 'critic_name'),
    notes: latestNonEmpty(parts, 'notes'),
    submitter_email: latestNonEmpty(parts, 'submitter_email'),
    _correctionHistory: history.join('\n\n'),
    _mergedSubmissionIds: parts.map(submissionIdOf).filter(Boolean),
    _isMergedCorrection: true,
  };
}

/**
 * @param {Array<object>} submissions Raw Formspree review-submission entries.
 * @param {object} [opts]
 * @param {number} [opts.windowMs=300000] Default 5 minutes, same as mergeCorrectionSubmissions.
 * @returns {Array<object>} See mergeSubmissionsCore.
 */
function mergeReviewSubmissionCorrections(submissions, opts = {}) {
  const windowMs = opts.windowMs ?? 5 * 60 * 1000;
  return mergeSubmissionsCore(submissions, {
    windowMs,
    getGroupKey: normalizedReviewShow,
    getIdentityKey: reviewSubmitterKey,
    buildMerged: buildMergedReviewSubmission,
  });
}

module.exports = {
  mergeCorrectionSubmissions,
  mergeReviewSubmissionCorrections,
  submissionIdOf,
  submissionTimestamp,
  normalizedShow,
  submitterKey,
  normalizedReviewShow,
  reviewSubmitterKey,
};
