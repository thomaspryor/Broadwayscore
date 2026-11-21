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
// Names a house went by when older reviews were written, so a 2011 review naming the
// Cottesloe still agrees with a row stored under the Dorfman (BRO-6503).
const FORMER_VENUE_NAMES = { dorfman: ['cottesloe'], 'harold pinter': ['comedy'], sondheim: ['queen s'], 'trafalgar': ['trafalgar studios'] };
// "Theatre Royal Haymarket" is "Haymarket" in a review's place line; same for Drury Lane.
// Only a "Theatre Royal X" name loses its "royal" ("Royal Court" must not become "court").
// `alt` names are ordinary words ("comedy", "haymarket"), so in free text they count only
// as a place: "Comedy, London" or "Comedy Theatre", never "a black comedy".
const venueNames = t => {
  const v = venueNorm(t);
  if (!v) return { main: null, alt: [] };
  const n = norm(t);
  const alt = [];
  if (/(^| )theatre royal /.test(n) || /haymarket theatre royal|drury lane theatre royal/.test(n)) alt.push(v.replace(/^royal /, '').replace(/ royal$/, ''));
  for (const [k, names] of Object.entries(FORMER_VENUE_NAMES)) if (` ${v} `.includes(` ${k} `)) alt.push(...names);
  return { main: v, alt: [...new Set(alt)].filter(x => x && x !== v) };
};
const venueVariants = t => { const { main, alt } = venueNames(t); return main ? [main, ...alt] : []; };
const venueInText = (venue, text) => {
  const { main, alt } = venueNames(venue);
  if (!main) return true;
  return text.includes(` ${main} `) || alt.some(a => text.includes(` ${a} london `) || text.includes(` ${a} theatre `) || text.includes(` ${a} studios `));
};
const venueAgrees = (a, b) => { const x = venueVariants(a), y = venueVariants(b); return x.some(n => y.includes(n)); };

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


// ---- Guardian Content API search results -> missing guardian slots ---------

/**
 * Candidates for a show's missing Guardian slot from Content API search results (section=stage,
 * queried over the show's opening window with show-tags=tone and show-fields=headline,publication,bodyText).
 * A result counts when it is tagged tone/reviews, published by The Guardian (not The Observer, which shares
 * theguardian.com/stage and is filed under another outlet), its headline names the show title, it is dated in
 * [opening-14d, opening+60d], and its text names the show's venue (a same-titled regional or Broadway
 * production is another production). More than one such result means the title is ambiguous, so none is kept.
 */
// Pre-2013 news and blog pieces also carry tone/reviews (a Pulitzer story, a
// casting item, a theatreblog essay), so a review needs a star rating or
// "review" in its headline, and theatreblog posts never count (BRO-6503).
// outlet-census.js uses this too.
function guardianItemIsReview(r) {
  if (/\/theatreblog\//.test(r.webUrl || '')) return false;
  const f = r.fields || {};
  const headline = f.headline || r.webTitle || '';
  if (/\b(round ?up|readers?'? reviews?)\b/i.test(headline)) return false;
  return /\breview\b/i.test(headline) || /^[1-5]$/.test(String(f.starRating || '').trim());
}
// BRO-7998: the same Content API search also yields The Observer's reviews (publication "The Observer",
// filed under outletId observer). `slot` picks which publication a result must carry.
const PUBLICATION_OF = {
  guardian: /^(the guardian|theguardian\.com|guardian\.co\.uk)$/i,
  observer: /^the observer$/i,
};
function matchGuardianResults(show, results, slot = 'guardian') {
  const pubRe = PUBLICATION_OF[slot];
  if (!pubRe) throw new Error(`matchGuardianResults: unknown slot ${slot}`);
  if (!show || !show.openingDate) return [];
  const lo = addDays(show.openingDate, -14), hi = addDays(show.openingDate, 60);
  const t = norm(show.title);
  if (!t || t.length < 4) return [];
  const hits = results.filter(r => {
    const date = String(r.webPublicationDate || '').slice(0, 10);
    if (date < lo || date > hi) return false;
    // Web-first pieces before the July 2013 domain move carry 'guardian.co.uk' (BRO-6503).
    if (!pubRe.test((r.fields && r.fields.publication) || '')) return false;
    if (!(r.tags || []).some(x => x.id === 'tone/reviews')) return false;
    if (!guardianItemIsReview(r)) return false;
    const f = r.fields || {};
    const headline = f.headline || r.webTitle || '';
    if (!` ${norm(headline)} `.includes(` ${t} `)) return false;
    const text = ` ${norm([f.standfirst, f.trailText, f.bodyText].filter(Boolean).join(' '))} `;
    return venueInText(show.venue, text);
  });
  return hits.length === 1 ? [{ url: hits[0].webUrl, date: String(hits[0].webPublicationDate).slice(0, 10) }] : [];
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

/**
 * True when the last URL path segment names THIS production of the show. The Stage puts the title in the headline
 * and URL, not in the review body, so the body-names-title guard cannot clear a real Stage review. Rules:
 * roundup slugs never match; the title tokens must appear in order (or, for a title of 9+ letters, squeezed
 * together, e.g. "Wonder.land" in damon-albarns-wonderland); a venue named after "-at-" must share a significant
 * word with the show's venue (a same-titled production elsewhere is another production); a slug with no venue
 * may carry at most two words beyond the title (and "review").
 */
function urlSlugNamesTitle(url, title, venue) {
  let slug = '';
  try { slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return false; }
  const toks = (x) => String(x || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const t = toks(title);
  const head = toks(slug.split('--')[0]);
  if (!t.length || !head.length) return false;
  if (/round-?up/.test(slug.toLowerCase()) || head.includes('roundup') || (head.includes('round') && head.includes('up'))) return false;
  const named = ` ${head.join(' ')} `.includes(` ${t.join(' ')} `)
    || (t.join('').length >= 9 && head.join('').includes(t.join('')));
  if (!named) return false;
  // Look for "-at-<venue>" only after the title, so a title containing "at" (Taken at Midnight) is not read as a venue.
  let titleEnd = 0;
  for (let i = 0; i + t.length <= head.length; i++) if (t.every((w, k) => head[i + k] === w)) { titleEnd = i + t.length; break; }
  const atAt = head.indexOf('at', titleEnd);
  if (atAt > 0 && atAt < head.length - 1) {
    const SKIP = new Set(['theatre', 'theater', 'london', 'royal', 'the', 'national', 'west', 'end']);
    const vt = toks(venue);
    let sig = vt.filter((w) => w.length >= 3 && !SKIP.has(w));
    // A venue made only of generic words ("National Theatre") must still be named: drop just the/theatre, and let
    // the National's three houses count for it.
    if (!sig.length) sig = vt.filter((w) => !['the', 'theatre', 'theater'].includes(w)).concat(vt.includes('national') ? ['olivier', 'lyttelton', 'dorfman', 'cottesloe'] : []);
    const slugVenue = head.slice(atAt + 1);
    return !sig.length || sig.some((w) => slugVenue.includes(w));
  }
  const extra = head.filter((w) => w !== 'review' && !t.includes(w)).length;
  return extra <= 2;
}

module.exports = {
  urlSlugNamesTitle,
  hostMatchesSlot, MAJOR, BY_SLOT, SLOT_OF, buildSlots, summarize, orderQueue, showWindow,
  norm, venueAgrees, matchWosPosts, matchGuardianResults, guardianItemIsReview, ledgerUsd, CostTally, addDays,
};
