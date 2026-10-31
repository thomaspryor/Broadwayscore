'use strict';
/**
 * The publishDate handed to the content verifier (verifyContent) when a review
 * text is collected (BRO-4884).
 *
 * collect-review-texts.js used to pass `publishDate || textFetchedAt || today`.
 * The today fallback exists for opening night: a fresh stub of a current show
 * has no date yet and really was published about now (DoaS / Proof
 * postmortems). For a historical stub (a Theatre Record link for a 2018 run)
 * it told Haiku the review was written in 2026, so the verifier called real
 * reviews "8 years after the production closed" and flagged them wrong
 * production; the own-venue carve-out then refused them as dated outside the
 * run. The page's own date was only extracted later, when the file was saved.
 *
 * Order: the stored date, then a date read from the fetched page (HTML, URL,
 * byline; same extractors the save step uses), then today only for a show
 * that is running or closed within the grace window. Otherwise null: no date
 * is better than a wrong one (the verifier and the carve-out both handle it).
 *
 * Pure, no I/O (CLAUDE.md §15); tests in verification-publish-date.test.mjs.
 */

const CLOSED_GRACE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function closedLongAgo(show, today) {
  const close = show && show.closingDate ? Date.parse(String(show.closingDate).slice(0, 10)) : NaN;
  const now = Date.parse(String(today).slice(0, 10));
  if (Number.isNaN(close) || Number.isNaN(now)) return false;
  return now - close > CLOSED_GRACE_DAYS * DAY_MS;
}

/**
 * @param {{ storedDate?: string|null, derivedDate?: string|null, textFetchedAt?: string|null, show?: object|null, today: string }} args
 * @returns {string|null} YYYY-MM-DD, or null when nothing trustworthy is known
 */
function verificationPublishDate({ storedDate, derivedDate, textFetchedAt, show, today }) {
  if (storedDate) return storedDate;
  if (derivedDate) return derivedDate;
  if (closedLongAgo(show, today)) return null;
  return String(textFetchedAt || today).slice(0, 10);
}

module.exports = { verificationPublishDate, closedLongAgo, CLOSED_GRACE_DAYS };
