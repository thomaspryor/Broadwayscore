#!/usr/bin/env node
/**
 * audit-pull-quotes.js
 *
 * Two checks over the live corpus, both aimed at the class the owner reported
 * on 2026-08-01 (bad + missing pull quotes on new Broadway / West End shows):
 *
 *   1. QUALITY — every shipped pullQuote in reviews.json is run back through
 *      the hard guards in scripts/lib/pull-quote-guards.js. A hit means a bad
 *      quote is live right now: listing/credits chrome, a tag cloud, copyright
 *      furniture, a promo teaser, or a quote cut mid-word.
 *
 *   2. PARITY — re-runs the real selectBestExcerpt() from rebuild-all-reviews.js
 *      over each review-texts file and diffs the result against the shipped
 *      pullQuote. Shows what the NEXT rebuild will change, before it runs.
 *      (rebuild-all-reviews.js exports its pure helpers and executes nothing
 *      when required, so this reads only — it never writes reviews.json.)
 *
 * This is a read-only audit. It writes nothing except an optional report file.
 *
 * Run:
 *   node scripts/audit-pull-quotes.js                    # quality check, whole corpus
 *   node scripts/audit-pull-quotes.js --since=2026-01-01 # limit to recent shows
 *   node scripts/audit-pull-quotes.js --parity           # + re-run selection and diff
 *   node scripts/audit-pull-quotes.js --show=<id>        # single show
 *   node scripts/audit-pull-quotes.js --fail-on-hit      # exit 1 if quality hits
 *   node scripts/audit-pull-quotes.js --json=<path>      # write a report file
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --help must be handled before anything reads data (CLAUDE.md / task #498).
function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 27).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const {
  hasListingChrome,
  isTagCloudExcerpt,
  isMidWordTruncation,
  hasCopyrightChrome,
  isPromoTeaser,
  isInternalNote,
} = require('./lib/pull-quote-guards');

// audit-chrome-pullquotes.js shipped its CHROME_PREFIX_PATTERNS as a "CI guard"
// but nothing ever invoked it — `grep -rn audit-chrome-pullquotes .github scripts`
// finds only its own file. Its patterns (leading "Review:", "By Firstname
// Lastname", "Photo:", venue+address) are good and tested, so consume them here
// rather than leave a second detector rotting unrun.
const { isChromePrefix } = require('./audit-chrome-pullquotes');

const ROOT = path.join(__dirname, '..');
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');
const SHOWS_FILE = process.env.SHOWS_FILE || path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');

function arg(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Which hard guard, if any, does this shipped quote trip?
 * `sources` are the texts available for the mid-word-truncation evidence check.
 */
function classifyBadQuote(quote, sources) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  if (isInternalNote(quote)) return 'internal-note';
  if (hasCopyrightChrome(quote)) return 'copyright-chrome';
  if (isPromoTeaser(quote)) return 'promo-teaser';
  if (isChromePrefix(quote)) return 'chrome-prefix';
  if (hasListingChrome(quote)) return 'listing-chrome';
  if (isTagCloudExcerpt(quote)) return 'tag-cloud';
  if (isMidWordTruncation(quote, sources)) return 'mid-word-truncation';
  return null;
}

function sourcesForReview(data) {
  if (!data) return [];
  return [
    data.fullText,
    ...((data.llmScore && data.llmScore.keyPhrases) || []).map(p => p && p.quote).filter(Boolean),
    data.llmScore && data.llmScore.keyQuote,
    data.llmPullQuote,
    data.showScoreExcerpt,
    data.bwwExcerpt,
    data.nycTheatreExcerpt,
    data.stagedoorExcerpt,
    data.dtliExcerpt,
  ].filter(t => typeof t === 'string' && t);
}

/** Load every review-texts JSON for a show, keyed by outletId. */
function loadShowTexts(showId, reviewTextsDir) {
  const dir = path.join(reviewTextsDir || REVIEW_TEXTS_DIR, showId);
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const d = readJson(path.join(dir, f));
      if (d && typeof d === 'object') out.push({ file: f, data: d });
    } catch { /* unreadable file — the rebuild reports these separately */ }
  }
  return out;
}

/**
 * The corpus-wide quality scan, extracted so a test can require() it
 * directly instead of re-implementing the guard-check loop (CLAUDE.md
 * rule 15). Same logic main() runs; main() below is a thin CLI wrapper.
 */
function findBadPullQuotes(reviews, reviewTextsDir) {
  const textsByShow = new Map();
  function textsFor(showId) {
    if (!textsByShow.has(showId)) textsByShow.set(showId, loadShowTexts(showId, reviewTextsDir));
    return textsByShow.get(showId);
  }
  function fileForReview(r) {
    return textsFor(r.showId).find(({ data }) => data.outletId === r.outletId
      && (!r.criticName || !data.criticName || data.criticName === r.criticName));
  }

  const badQuotes = [];
  for (const r of reviews) {
    if (!r.pullQuote) continue;
    const entry = fileForReview(r);
    const reason = classifyBadQuote(r.pullQuote, sourcesForReview(entry && entry.data));
    if (reason) {
      badQuotes.push({
        showId: r.showId, outletId: r.outletId, criticName: r.criticName,
        reason, url: r.url, pullQuote: r.pullQuote.slice(0, 200),
      });
    }
  }
  return badQuotes;
}

function main() {
  const since = arg('since');
  const onlyShow = arg('show');
  const doParity = process.argv.includes('--parity');
  const failOnHit = process.argv.includes('--fail-on-hit');
  const jsonOut = arg('json');

  const shows = readJson(SHOWS_FILE).shows || [];
  const reviews = readJson(REVIEWS_FILE).reviews || [];

  let inScope = new Set(shows.map(s => s.id));
  if (since) {
    inScope = new Set(shows.filter(s => {
      const d = s.openingDate || s.previewsStartDate;
      return d && d >= since;
    }).map(s => s.id));
  }
  if (onlyShow) inScope = new Set([onlyShow]);

  const scoped = reviews.filter(r => inScope.has(r.showId));
  console.log(`audit-pull-quotes: ${scoped.length} reviews across ${inScope.size} show(s)${since ? ` (opened >= ${since})` : ''}`);

  // Index review-texts per show once — parity needs the full file, quality only
  // needs the source strings.
  const textsByShow = new Map();
  function textsFor(showId) {
    if (!textsByShow.has(showId)) textsByShow.set(showId, loadShowTexts(showId));
    return textsByShow.get(showId);
  }
  function fileForReview(r) {
    return textsFor(r.showId).find(({ data }) => data.outletId === r.outletId
      && (!r.criticName || !data.criticName || data.criticName === r.criticName));
  }

  // --- 1. QUALITY ---------------------------------------------------------
  const badQuotes = findBadPullQuotes(scoped, REVIEW_TEXTS_DIR);

  console.log(`\n[quality] ${badQuotes.length} shipped pull quote(s) trip a hard guard`);
  const byReason = {};
  for (const b of badQuotes) (byReason[b.reason] = byReason[b.reason] || []).push(b);
  for (const [reason, list] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(4)} ${reason}`);
    for (const b of list.slice(0, 5)) {
      console.log(`       ${b.showId} / ${b.outletId}: ${JSON.stringify(b.pullQuote.slice(0, 110))}`);
    }
    if (list.length > 5) console.log(`       ... and ${list.length - 5} more`);
  }

  // --- 2. PARITY ----------------------------------------------------------
  let parity = null;
  if (doParity) {
    // Requiring rebuild-all-reviews.js runs NOTHING (top-level return guard);
    // it only hands back the pure excerpt helpers.
    const { selectBestExcerpt } = require('./rebuild-all-reviews.js');
    const titleById = new Map(shows.map(s => [s.id, s.title]));

    const changes = { filled: [], cleared: [], changed: [], same: 0, skipped: 0 };
    for (const r of scoped) {
      const entry = fileForReview(r);
      if (!entry) { changes.skipped++; continue; }
      let next;
      try {
        next = selectBestExcerpt(entry.data, titleById.get(r.showId));
      } catch (e) {
        changes.skipped++;
        continue;
      }
      const before = r.pullQuote || null;
      const after = next || null;
      if (before === after) { changes.same++; continue; }
      const rec = {
        showId: r.showId, outletId: r.outletId, criticName: r.criticName,
        before: before && before.slice(0, 200),
        after: after && after.slice(0, 200),
      };
      if (!before && after) changes.filled.push(rec);
      else if (before && !after) changes.cleared.push(rec);
      else changes.changed.push(rec);
    }

    parity = changes;
    console.log(`\n[parity] next rebuild would: fill ${changes.filled.length}, clear ${changes.cleared.length}, change ${changes.changed.length} (unchanged ${changes.same}, no-file ${changes.skipped})`);
    for (const [label, list] of [['FILLED', changes.filled], ['CLEARED', changes.cleared], ['CHANGED', changes.changed]]) {
      if (!list.length) continue;
      console.log(`\n  --- ${label} (${list.length}) ---`);
      for (const c of list.slice(0, 25)) {
        console.log(`  ${c.showId} / ${c.outletId}`);
        console.log(`    before: ${JSON.stringify(c.before)}`);
        console.log(`    after:  ${JSON.stringify(c.after)}`);
      }
      if (list.length > 25) console.log(`  ... and ${list.length - 25} more`);
    }
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      scannedReviews: scoped.length,
      scannedShows: inScope.size,
      since: since || null,
      badQuotes,
      parity,
    }, null, 2));
    console.log(`\nreport → ${jsonOut}`);
  }

  return failOnHit && badQuotes.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { classifyBadQuote, sourcesForReview, findBadPullQuotes, loadShowTexts, hasHelpFlag };
