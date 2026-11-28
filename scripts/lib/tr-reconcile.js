'use strict';

/**
 * tr-reconcile.js — compare one theatre.reviews round-up against the review
 * files we hold for the matched show (BRO-6084).
 *
 * Every listed row lands in exactly one bucket:
 *   held      a review file for that outlet (+ critic, or its URL) exists and the rebuild keeps it
 *   excluded  the matching file(s) are all dropped for a recorded permanent reason; never resurrected
 *   missing   no file at all; the writer should create one
 * "Buy tickets" pseudo-rows and rows with no outlet are ignored.
 */
const fs = require('fs');
const path = require('path');
const { hasReviewFor } = require('./outlet-ground-truth');
const { resolveArchiveRowOutletId } = require('./archive-outlet-identity');
const { normalizeOutlet, isRegisteredOutlet } = require('./review-normalization');
const { explainExclusion } = require('./review-guards');
const { PERMANENT_REASONS } = require('./census-rebuild-exclusions');

// Ticket links, bare domains and venue links that theatre.reviews renders in the same list as
// critic rows ("Click here to buy tickets direct...", "www.thedukeofyorks.com", "Noël Coward Theatre").
const TICKET_LINK = /^(buy\s+tickets?|book\s+(now|tickets?)|tickets?|see\s+tickets?|get\s+tickets?|click\s+here\b)/i;
// Bare domains and "...Theatre" venue links. Outlets such as "London Theatre", "Everything Theatre"
// or "WhatsOnStage.com" match these shapes too, so a label the outlet registry knows is a critic row.
const DOMAIN_OR_VENUE = /^((https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|co\.uk|org|uk|net)\b|.*\btheatre$)/i;

// theatre.reviews abbreviates some outlets in its row labels; "Time" is The Times
// (without this it resolves to a junk "time" outlet, BRO-6084).
const LABEL_ALIASES = { time: 'The Times', standard: 'Evening Standard', stage: 'The Stage', i: 'The i', mail: 'Daily Mail', 'guardian review': 'The Guardian' };
function canonicalLabel(label) {
  const trimmed = String(label || '').trim().replace(/\.+$/, '');
  return LABEL_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function isPseudoRow(row) {
  const label = String((row && row.outlet) || '').trim();
  if (!label) return true;
  if (TICKET_LINK.test(label)) return true;
  if (!DOMAIN_OR_VENUE.test(label)) return false;
  let registered = false;
  const bare = canonicalLabel(label).replace(/^(https?:\/\/)?(www\.)?/i, '').replace(/\.(com|co\.uk|org|uk|net)$/i, '');
  try { registered = [canonicalLabel(label), bare].some((l) => isRegisteredOutlet(normalizeOutlet(l))); } catch { /* unknown label */ }
  return !registered;
}

function rowOutletId(row) {
  return resolveArchiveRowOutletId({ url: row.url, outletLabel: canonicalLabel(row.outlet), cachedOutletId: row.outletId });
}

/** Read every review file for a show: [{ file, data }]. Missing dir = []. */
function loadShowFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { out.push({ file: path.join(dir, f), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch { /* unreadable: ignore */ }
  }
  return out;
}

/**
 * @param {object[]} rows   extractReviews() output
 * @param {{file:string,data:object}[]} files  loadShowFiles() output
 * @param {object} show     shows.json entry
 * @param {{explain?: Function}} [opts] explain overrides explainExclusion (tests)
 * @returns {{listed:number, held:object[], excluded:object[], missing:object[], ignored:number}}
 */
function classifyRows(rows, files, show, opts = {}) {
  const explain = opts.explain || explainExclusion;
  const held = [];
  const excluded = [];
  const missing = [];
  let ignored = 0;
  const datas = files.map((f) => f.data);
  for (const row of rows || []) {
    if (isPseudoRow(row)) { ignored++; continue; }
    const outletId = rowOutletId(row);
    const probe = { url: row.url, outletId, critic: row.critic };
    const matches = files.filter((f) => hasReviewFor([f.data], probe));
    if (!matches.length) { missing.push({ ...row, outletId }); continue; }
    const reasons = matches.map((m) => {
      try { return explain(m.data, show, m.file); } catch { return 'error'; }
    });
    const allPermanent = reasons.every((r) => r !== null && r !== undefined && PERMANENT_REASONS.has(r));
    // Like the census (census-rebuild-exclusions.js): an excluded file only closes the row that
    // names ITS url. A flagged file for a different production does not hide this round-up's
    // real review, which stays missing and is written.
    const closes = matches.some((m) => !row.url || !m.data || !m.data.url || sameRoundupUrl(row.url, m.data.url));
    if (allPermanent && !closes) { missing.push({ ...row, outletId }); continue; }
    if (allPermanent) excluded.push({ outlet: row.outlet, critic: row.critic, outletId, reason: reasons[0] });
    else held.push({ outlet: row.outlet, critic: row.critic, outletId, row });
  }
  return { listed: held.length + excluded.length + missing.length, held, excluded, missing, ignored };
}

/** One coverage-report row (the shape the card asks for). */
function coverageEntry(show, roundupUrl, c) {
  return {
    showId: show.id,
    roundupUrl,
    listed: c.listed,
    held: c.held.length,
    excluded: c.excluded.length,
    missing: c.missing.length,
    missingRows: c.missing.map((m) => ({ outlet: m.outlet, critic: m.critic || null, ...(m.refusal ? { refusal: m.refusal } : {}) })),
    excludedRows: c.excluded.map((e) => ({ outlet: e.outlet, critic: e.critic || null, reason: e.reason })),
  };
}

/**
 * Archived round-up HTML that no longer matches the post we matched to the
 * show (legacy title-only matching archived the wrong production). Compares the
 * page's canonical/og:url with the matched post URL.
 */
function archiveUrlOf(html) {
  const m = String(html || '').match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || String(html || '').match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}
function sameRoundupUrl(a, b) {
  const n = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && n(a) === n(b);
}

module.exports = { canonicalLabel, isPseudoRow, rowOutletId, loadShowFiles, classifyRows, coverageEntry, archiveUrlOf, sameRoundupUrl };
