'use strict';

/**
 * BRO-6155: pure logic for recovering missing major-outlet reviews on West End
 * historical shows (seasons 2016-17..2020-21). Extracted per CLAUDE.md §15 so
 * we-major-recovery.test.mjs exercises the real functions.
 *
 * Slot = (show, major outlet) with no scored review in reviews.json.
 */

const { WE_HISTORICAL_DISCOVERY_SOURCES } = require('./we-historical-corroboration.js');
const {
  earliestShowDate, DAYS_BEFORE_PREVIEW, UK_DAYS_BEFORE_PREVIEW, DAYS_AFTER_CLOSE,
} = require('./date-guard.js');

// slot -> how to search and file it. `domain` is the SERP site: scope (the
// held reviews' real hosts; the SERP matcher compares bare hosts, so no path
// suffix). `serp: false` = never searched: Observer reviews sit on
// theguardian.com/stage or observer.co.uk, so a Guardian-host hit cannot be
// told from a Guardian review).
// `outletId` is passed to ingest verbatim so the file lands under the same
// identity as the reviews we already hold. `ids` = outletIds that fill the slot.
const MAJOR = [
  { slot: 'guardian', outletId: 'guardian', ids: ['guardian'], domain: 'theguardian.com', tier: 1 },
  { slot: 'telegraph', outletId: 'telegraph', ids: ['telegraph'], domain: 'telegraph.co.uk', tier: 1 },
  { slot: 'standard', outletId: 'standard', ids: ['standard'], domain: 'standard.co.uk', tier: 1 },
  { slot: 'times', outletId: 'times-uk', ids: ['times-uk'], domain: 'thetimes.co.uk', hosts: ['thetimes.co.uk', 'thetimes.com'], tier: 1 },
  { slot: 'ft', outletId: 'financialtimes', ids: ['financialtimes'], domain: 'ft.com', tier: 1 },
  { slot: 'stage', outletId: 'thestage', ids: ['thestage'], domain: 'thestage.co.uk', tier: 2 },
  { slot: 'whatsonstage', outletId: 'whatsonstage', ids: ['whatsonstage'], domain: 'whatsonstage.com', tier: 2 },
  { slot: 'timeout', outletId: 'timeout-london', ids: ['timeout-london'], domain: 'timeout.com', tier: 2 },
  { slot: 'independent', outletId: 'independent', ids: ['independent'], domain: 'independent.co.uk', tier: 2 },
  { slot: 'observer', outletId: 'observer', ids: ['observer'], domain: 'theguardian.com', tier: 2, serp: false },
  { slot: 'artsdesk', outletId: 'artsdesk', ids: ['artsdesk'], domain: 'theartsdesk.com', tier: 3 },
  { slot: 'daily-mail', outletId: 'daily-mail', ids: ['daily-mail', 'mail-on-sunday'], domain: 'dailymail.co.uk', tier: 3 },
];
const BY_SLOT = new Map(MAJOR.map(m => [m.slot, m]));
const SLOT_OF = new Map(MAJOR.flatMap(m => m.ids.map(i => [i, m.slot])));

const isScored = r => typeof r.assignedScore === 'number' && Number.isFinite(r.assignedScore);
const startYear = s => +((String(s).match(/^(\d{4})/) || [])[1] || 0);

/** One row per we-historical show in [from, to] season start years. */
function buildSlots(shows, reviews, from = 2016, to = 2020) {
  const by = new Map();
  for (const r of reviews) {
    if (!isScored(r)) continue;
    if (!by.has(r.showId)) by.set(r.showId, []);
    by.get(r.showId).push(r);
  }
  const rows = [];
  for (const s of shows) {
    if (!WE_HISTORICAL_DISCOVERY_SOURCES.has(s.discoverySource)) continue;
    const y = startYear(s.season);
    if (y < from || y > to) continue;
    const rs = by.get(s.id) || [];
    const have = new Set(rs.map(r => SLOT_OF.get(r.outletId)).filter(Boolean));
    rows.push({
      id: s.id, title: s.title, season: s.season, counted: rs.length, majorHeld: have.size,
      missing: MAJOR.map(m => m.slot).filter(x => !have.has(x)),
    });
  }
  return rows;
}

function summarize(rows) {
  const out = {};
  for (const r of rows) {
    const o = (out[r.season] = out[r.season] || { shows: 0, major: 0, counted: 0, slots: 0 });
    o.shows++; o.major += r.majorHeld; o.counted += r.counted; o.slots += r.missing.length;
  }
  return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, {
    shows: v.shows, avgMajor: +(v.major / v.shows).toFixed(2),
    avgCounted: +(v.counted / v.shows).toFixed(2), missingSlots: v.slots,
  }]));
}

/**
 * Work queue, highest value first: T1 outlets, then T2, then T3; inside a tier
 * the shows with the fewest counted reviews (nearest the 5-review display
 * threshold) go first.
 */
function orderQueue(rows, { slots = null } = {}) {
  const q = [];
  for (const r of rows) {
    for (const slot of r.missing) {
      if (slots && !slots.has(slot)) continue;
      q.push({ showId: r.id, title: r.title, season: r.season, slot, tier: BY_SLOT.get(slot).tier, counted: r.counted });
    }
  }
  return q.sort((a, b) => a.tier - b.tier || a.counted - b.counted || a.showId.localeCompare(b.showId) || a.slot.localeCompare(b.slot));
}

// ---- date window (same rule as the rebuild's date flagger) ----------------

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

/** [start, end] YYYY-MM-DD a review of this show may be dated in, or null when the show has no usable date. */
function showWindow(show, outletId) {
  const earliest = earliestShowDate(show);
  if (!earliest) return null;
  const trusted = new Set(['thestage', 'financialtimes', 'guardian', 'times-uk', 'telegraph', 'standard', 'whatsonstage', 'independent']);
  const before = trusted.has(outletId) ? UK_DAYS_BEFORE_PREVIEW : DAYS_BEFORE_PREVIEW;
  // An open-ended run is capped a year after opening: a review a year on is another production.
  const end = show.closingDate ? addDays(show.closingDate, DAYS_AFTER_CLOSE) : addDays(show.openingDate || earliest, 365);
  return { start: addDays(earliest, -before), end };
}

// ---- WhatsOnStage review posts (free WP REST) -> missing slots -------------

const { foldDiacritics } = require('./title-match');
const norm = s => foldDiacritics(String(s || '')).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/^(the|a|an) /, '').replace(/ the musical$| a new musical$| the play$/, '').trim();
const venueNorm = t => norm(t).replace(/\btheatre\b/g, '').replace(/\s+/g, ' ').trim();
const venueAgrees = (a, b) => { const x = venueNorm(a), y = venueNorm(b); return !!x && !!y && x === y; };

/**
 * Posts for a show's missing WhatsOnStage slot: same title, dated in [opening-14d, opening+60d],
 * and the venue named in the post equals the show's (a post naming another venue is another
 * production). A post naming no venue counts only as the single title+date hit.
 */
function matchWosPosts(rows, shows, posts) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const out = [];
  for (const r of rows) {
    if (!r.missing.includes('whatsonstage')) continue;
    const s = byId.get(r.id);
    if (!s || !s.openingDate) continue;
    const lo = addDays(s.openingDate, -14), hi = addDays(s.openingDate, 60);
    let hits = posts.filter(p => p.date >= lo && p.date <= hi && norm(p.title) === norm(s.title));
    const n = hits.length;
    hits = hits.filter(p => (p.venue ? venueAgrees(p.venue, s.venue) : n === 1));
    if (hits.length) out.push({ showId: r.id, slot: 'whatsonstage', posts: hits.map(h => ({ url: h.url, date: h.date })) });
  }
  return out;
}


// ---- Guardian Content API search results -> missing guardian slots --------

/**
 * Candidates for a show's missing Guardian slot from Content API search results
 * (section=stage, queried over the show's opening window). A result counts when it is a
 * review (star rating, "review" in the headline, or a /stage/ review URL), its headline names
 * the show title, and it is dated in [opening-14d, opening+60d]. Two or more distinct results
 * after that are kept (ingest's date window and body-names-the-show guards pick), capped at 3.
 */
function matchGuardianResults(show, results) {
  if (!show || !show.openingDate) return [];
  const lo = addDays(show.openingDate, -14), hi = addDays(show.openingDate, 60);
  const t = norm(show.title);
  if (!t || t.length < 4) return [];
  const hits = results.filter(r => {
    const date = String(r.webPublicationDate || '').slice(0, 10);
    if (date < lo || date > hi) return false;
    const head = norm(r.fields && r.fields.headline || r.webTitle);
    const isReview = r.fields && r.fields.starRating || /\breview\b/.test(head) || /-review\b/.test(r.webUrl || '');
    return isReview && new RegExp(`(^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(head);
  });
  return hits.slice(0, 3).map(r => ({ url: r.webUrl, date: String(r.webPublicationDate).slice(0, 10) }));
}

// ---- spend tally ----------------------------------------------------------

/**
 * Dollars for scraper-spend-ledger rows. Scrapingdog is priced at the PAYG add-on
 * rate (the highest it can bill), so the tally is an upper bound. Bright Data rows
 * carry credits 0 and are one request each. Rows with no price (browserbase, memo
 * skips, breaker rows) add nothing.
 */
function ledgerUsd(rows, pricing, sinceIso = null) {
  if (sinceIso) rows = rows.filter(r => r.ts >= sinceIso);
  let usd = 0;
  const byProvider = {};
  for (const r of rows) {
    let u = 0;
    if (r.provider === 'scrapingdog') u = (r.credits || 0) * (pricing.scrapingdog.paygUsdPerUnit ?? pricing.scrapingdog.usdPerUnit);
    else if (r.provider === 'scrapingbee') u = (r.credits || 0) * pricing.scrapingbee.usdPerUnit;
    else if (r.provider === 'brightdata' && /^(web-unlocker|serp-unlocker|serp-api|collector-tier3)$/.test(r.fn || '') && r.success !== false) u = pricing.brightdata.usdPerUnit;
    usd += u;
    byProvider[r.provider] = (byProvider[r.provider] || 0) + u;
  }
  return { usd, byProvider };
}

/**
 * Running cost against a hard cap. Spend is the measured scraper dollars plus the
 * LLM scoring dollars already incurred and projected for the files this run wrote.
 */
class CostTally {
  constructor({ capUsd, scoringUsdPerReview = 0.04, reserveUsd = 0, priorScraperUsd = 0, priorWritten = 0 }) {
    this.capUsd = capUsd;
    this.scoringUsdPerReview = scoringUsdPerReview;
    this.reserveUsd = reserveUsd; // held back for work that follows (scoring of what is already written)
    this.priorScraperUsd = priorScraperUsd; // earlier runs of this campaign
    this.priorWritten = priorWritten;
    this.runScraperUsd = 0;
    this.written = 0;
  }
  get scraperUsd() { return this.priorScraperUsd + this.runScraperUsd; }
  setScraperUsd(usd) { this.runScraperUsd = usd; }
  recordWritten(n = 1) { this.written += n; }
  get projectedScoringUsd() { return (this.priorWritten + this.written) * this.scoringUsdPerReview; }
  get projectedTotalUsd() { return this.scraperUsd + this.projectedScoringUsd + this.reserveUsd; }
  /** True when one more slot (a search, plus a fetch and its scoring if it hits) could cross the cap. */
  wouldExceed(nextCallUsd) {
    return this.projectedTotalUsd + nextCallUsd + this.scoringUsdPerReview > this.capUsd;
  }
  line() {
    return `COST TALLY scraper=$${this.scraperUsd.toFixed(3)} scoring(proj ${this.priorWritten + this.written} files)=$${this.projectedScoringUsd.toFixed(3)} total=$${this.projectedTotalUsd.toFixed(3)} cap=$${this.capUsd}`;
  }
}

/** True when host belongs to the slot's outlet (bare host compare, www stripped). */
function hostMatchesSlot(m, host) {
  const h = String(host).replace(/^www\./, '');
  return (m.hosts || [m.domain]).some(d => h === d || h.endsWith('.' + d));
}

module.exports = {
  hostMatchesSlot, MAJOR, BY_SLOT, SLOT_OF, buildSlots, summarize, orderQueue, showWindow,
  norm, venueAgrees, matchWosPosts, matchGuardianResults, ledgerUsd, CostTally, addDays,
};
