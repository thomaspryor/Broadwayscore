/**
 * Market Routing Classifier
 *
 * Single decision function for "which show directory should this review land in?"
 *
 * Extracted from scripts/lib/review-file-writer.js Guard A + Guard H so that
 * gather-reviews.js (SERP discovery path) and the historical migration script
 * (scripts/audit-we-market-misroutes.js) use the same rules. Thresholds are
 * preserved verbatim — this is a refactor + wiring expansion, not a policy change.
 *
 * Rules (in order):
 *   1. allowCrossMarket opt-in → accept (E2E tests, manual ingestion, transfers)
 *   2. Sibling date reroute (Tier 1, full date): sibling opened ≤30 days (same
 *      market pool) or ≤60 days (cross-market pool) from publishDate AND current
 *      show's opening is >90 days from publishDate → reroute to sibling.
 *   3. Sibling year reroute (Tier 2, fallback for shows without opening dates):
 *      pickRerouteTarget by ID year.
 *   4. WE shows only: URL has explicit Broadway marker or outlet is US-only →
 *      reject (no plausible target).
 *   5. Accept.
 *
 * Pure: no filesystem I/O. Callers pass in shows list (or sibling index).
 */

const { parseDate } = require('./date-utils');
const { pickRerouteTarget, urlYearFromPath } = require('./review-guards');
const { isBroadwayUrl, isLondonMarket, getMarketPool, GENERIC_VENUE_SLUGS } = require('./venue-classification');
const { VENUE_STOPWORDS } = require('./production-match-gate');

const DAY = 86400000;
const SIBLING_CLOSE_DAYS = 30;         // same-market: sibling opening this close to review → candidate
const CROSS_MARKET_SIBLING_CLOSE_DAYS = 60; // cross-market: wider window (e.g. oh-mary BW→WE at 32d)
const CURRENT_FAR_DAYS = 90;           // current show's opening this far from review → eligible

/**
 * Normalize a title for sibling grouping (same rules as review-file-writer.js).
 */
const { foldDiacritics } = require('./title-match');

function normalizeTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
}

/**
 * Build a sibling index from a shows array. For each show, record its
 * openingDate / ID year plus the list of other shows that share its title.
 *
 * @param {Array<object>} shows
 * @returns {Map<string, { showYear: number|null, openingDate: Date|null, siblings: Array }>}
 */
function buildSiblingIndex(shows) {
  const map = new Map();
  if (!Array.isArray(shows) || shows.length === 0) return map;
  const byTitle = new Map();
  for (const s of shows) {
    const t = normalizeTitle(s.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }
  for (const s of shows) {
    const t = normalizeTitle(s.title);
    const group = byTitle.get(t) || [];
    const sibs = group.filter(x => x.id !== s.id);
    if (sibs.length === 0) continue;
    const yearMatch = String(s.id || '').match(/-(\d{4})$/);
    const showYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const opening = s.openingDate ? new Date(s.openingDate) : null;
    const closing = s.closingDate ? new Date(s.closingDate) : null;
    map.set(s.id, {
      showYear,
      openingDate: opening && !isNaN(opening.getTime()) ? opening : null,
      closingDate: closing && !isNaN(closing.getTime()) ? closing : null,
      title: s.title || null,
      category: s.category || null,
      venue: s.venue || null,
      siblings: sibs.map(x => {
        const ym = String(x.id || '').match(/-(\d{4})$/);
        const sibOpening = x.openingDate ? new Date(x.openingDate) : null;
        const sibClosing = x.closingDate ? new Date(x.closingDate) : null;
        return {
          id: x.id,
          year: ym ? parseInt(ym[1], 10) : null,
          openingDate: sibOpening && !isNaN(sibOpening.getTime()) ? sibOpening : null,
          closingDate: sibClosing && !isNaN(sibClosing.getTime()) ? sibClosing : null,
          category: x.category || null,
          venue: x.venue || null,
          title: x.title || null,
        };
      }).filter(x => x.year || x.openingDate),
    });
  }
  return map;
}

/**
 * Same-market same-title signal collector. Returns the list of signal names
 * (url-year, publish-date, venue-substring) that fire for `candidate` given
 * the review's URL/publishDate.
 *
 * Used by the same-market disambiguation branch in classifyMarketRouting.
 * Each signal independently links the review to a specific production:
 *   - url-year: URL contains /YYYY/ matching the candidate's opening year
 *     (or ±1 yr for late-year reviews of previous-year openings).
 *   - publish-date: review publishDate falls inside the production window
 *     [openingDate − 60d, closingDate + 30d]. Open run with no closingDate →
 *     extends to "now" (1y window cap to avoid catching long-runner reviews).
 *   - venue-substring: candidate's venue token (e.g. "lortel", "criterion")
 *     appears as a normalized substring in the URL path.
 *
 * Pure: no I/O, no globals.
 *
 * @param {object} candidate — { openingDate, closingDate, venue }
 * @param {object} ctx — { url, publishDate }
 * @returns {Array<string>} matched signal names
 */
function collectSameTitleSignals(candidate, ctx) {
  const signals = [];
  const url = ctx && ctx.url ? String(ctx.url) : '';
  const pubStr = ctx && ctx.publishDate ? ctx.publishDate : null;
  const reviewDate = parseDate(typeof pubStr === 'string' ? pubStr : null);

  // Signal 1: URL year matches opening year (or one year either side).
  if (url && candidate.openingDate) {
    const urlYear = urlYearFromPath(url);
    if (urlYear) {
      const openYear = candidate.openingDate.getFullYear();
      if (urlYear >= openYear - 1 && urlYear <= openYear + 1) {
        signals.push('url-year');
      }
    }
  }

  // Signal 2: publishDate inside production window.
  if (reviewDate && candidate.openingDate) {
    const windowStart = new Date(candidate.openingDate.getTime() - 60 * DAY);
    // closingDate when known, else openingDate + 365d cap (long-runner safety).
    const windowEnd = candidate.closingDate
      ? new Date(candidate.closingDate.getTime() + 30 * DAY)
      : new Date(candidate.openingDate.getTime() + 365 * DAY);
    if (reviewDate >= windowStart && reviewDate <= windowEnd) {
      signals.push('publish-date');
    }
  }

  // Signal 3: venue substring in URL. Normalize venue to a single token like
  // "lortel" / "barrymore" — first significant word, lowercased. Skip tokens
  // that are in GENERIC_VENUE_SLUGS (e.g. "broadway", "lyceum", "apollo",
  // "criterion") — these overmatch unrelated URLs and would falsely link a
  // review to the wrong production. Shared with audit-cross-production.js.
  //
  // Whole-venue generic check (task #787), gated BEFORE the per-word split:
  // 5 GENERIC_VENUE_SLUGS entries are hyphenated multi-word slugs
  // ("studio-54", "circle-in-the-square", "duke-of-yorks", "music-box",
  // "victoria-palace") that can never equal a single whitespace-split token,
  // so they were silently dead here. A venue whose FULL canonical slug
  // matches one of these is entirely generic (e.g. "Victoria Palace Theatre"
  // -> "victoria-palace") and contributes no tokens. canonicalSlug below
  // mirors audit-cross-production.js's own (not-yet-shared — task #783 is
  // still in flight, unify there once it lands) venueSlug(): lowercase, strip
  // "theatre"/"theater", hyphen-join. Deliberately NOT done by flattening
  // each hyphenated entry into standalone words ("victoria", "palace",
  // "circle", "square", "studio", "music") and denylisting those globally —
  // that would also suppress "victoria" for "Apollo Victoria Theatre", a
  // real, DISTINCT West End venue (wicked-west-end-2021) whose own canonical
  // slug ("apollo-victoria") is not generic. Per-word denylisting below stays
  // scoped to GENERIC_VENUE_SLUGS's genuinely standalone single-word entries.
  //
  // Beyond that whole-venue gate, this signal still isn't a single-slug
  // match: it tests each significant WORD of the venue name as an
  // independent substring of a URL path — a deliberately looser, per-word
  // match tuned for how outlets slug review URLs — and additionally strips
  // "playhouse"/"the" (the canonicalSlug check above only strips
  // "theatre"/"theater", matching how GENERIC_VENUE_SLUGS entries are built).
  //
  // canonicalSlug also strips a LEADING "the " and apostrophes before
  // hyphenating (adversarial ship-check catch): without these, "The Circle
  // in the Square Theatre" or "Duke of York's Theatre" wouldn't collapse
  // onto their GENERIC_VENUE_SLUGS entries ("circle-in-the-square",
  // "duke-of-yorks") even though they denote the same generic venue. Only
  // the LEADING "the" is stripped — not every occurrence — so the internal
  // "the" that "circle-in-the-square" itself requires survives.
  if (url && candidate.venue) {
    const venueNorm = foldDiacritics(String(candidate.venue)).toLowerCase();
    const canonicalSlug = venueNorm
      .replace(/^the\s+/, '')
      .replace(/[‘’′']/g, '')
      .replace(/\btheatre\b|\btheater\b/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!GENERIC_VENUE_SLUGS.has(canonicalSlug)) {
      // Strip generic suffixes that match many URLs.
      const stripped = venueNorm
        .replace(/\b(theatre|theater|playhouse|the)\b/g, '')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .trim();
      // Also drop generic venue-descriptor words ("center", "hall", "studio",
      // "arts"...) that aren't in GENERIC_VENUE_SLUGS (a whole-venue-name set,
      // not a per-word one) but are common enough to false-match unrelated
      // URLs/outlet names by pure substring — e.g. "A.R.T.'s Loeb Drama
      // Center" contributing the token "center", which then matches
      // thefrontrowcenter.com (the OUTLET's own name, "Front Row Center") and
      // wrongly signals that a Broadway review names the regional venue.
      // Found 2026-08-14 auditing two-strangers-carry-a-cake-across-new-york's
      // regional/Broadway sibling pair. Shared with production-match-gate.js's
      // VENUE_STOPWORDS so both venue-token filters stay in sync.
      const tokens = stripped.split(/\s+/).filter(t => t.length >= 5 && !GENERIC_VENUE_SLUGS.has(t) && !VENUE_STOPWORDS.has(t));
      const urlLower = url.toLowerCase();
      for (const tok of tokens) {
        if (urlLower.includes(tok)) {
          signals.push('venue-substring');
          break;
        }
      }
    }
  }

  return signals;
}

/**
 * Classify the market routing for a prospective write.
 *
 * @param {object} args
 * @param {string} args.showId — destination show directory candidate
 * @param {string} [args.url]
 * @param {string} [args.outletId]
 * @param {string|Date} [args.publishDate]
 * @param {string} [args.category] — current show's category (west-end/off-west-end/etc.)
 * @param {boolean} [args.allowCrossMarket=false]
 * @param {Set<string>} [args.visited] — already-visited show IDs (prevent cycles)
 * @param {Map} args.siblingIndex — pre-built sibling index (buildSiblingIndex)
 * @returns {{ action: 'accept' | 'reject' | 'reroute', targetShowId?: string, reason?: string, flag?: string, signalsByCandidate?: Array }}
 */
function classifyMarketRouting(args) {
  const {
    showId,
    url,
    outletId,
    publishDate,
    category,
    allowCrossMarket = false,
    visited,
    siblingIndex,
  } = args;

  if (allowCrossMarket) {
    return { action: 'accept', reason: 'allowCrossMarket opt-in' };
  }

  const visitedSet = visited || new Set();
  visitedSet.add(showId);

  // --- Sibling date/year reroute (Guard A) ---
  const sibData = siblingIndex && siblingIndex.get(showId);
  if (sibData && sibData.siblings.length) {
    const pubStr = typeof publishDate === 'string' ? publishDate : null;
    const reviewDate = parseDate(pubStr);

    // Tier 1: full-date comparison. Authoritative when the current show has an
    // openingDate — many long-runner WE shows have an ID-year suffix (e.g. "-2024")
    // that diverges from the actual first-opening year (1986, 2013), so year-based
    // Tier 2 misfires. If current has an openingDate, skip Tier 2 entirely.
    if (reviewDate && sibData.openingDate) {
      const distToCurrent = Math.abs(reviewDate - sibData.openingDate) / DAY;
      let best = null;
      const currentPool = getMarketPool(sibData.category || '');
      for (const sib of sibData.siblings) {
        if (!sib.openingDate || visitedSet.has(sib.id)) continue;
        const distToSib = Math.abs(reviewDate - sib.openingDate) / DAY;
        const isCrossMarketSib = sibData.category != null && sib.category != null
          && getMarketPool(sib.category) !== currentPool;
        const threshold = isCrossMarketSib ? CROSS_MARKET_SIBLING_CLOSE_DAYS : SIBLING_CLOSE_DAYS;
        if (distToSib <= threshold && distToCurrent > CURRENT_FAR_DAYS) {
          if (!best || distToSib < best.dist) {
            best = { id: sib.id, dist: distToSib, currentDist: distToCurrent };
          }
        }
      }
      if (best) {
        return {
          action: 'reroute',
          targetShowId: best.id,
          reason: `sibling opening ${Math.round(best.dist)}d from publishDate vs current ${Math.round(best.currentDist)}d`,
        };
      }
    } else if (reviewDate && sibData.showYear) {
      // Tier 2: year-level fallback ONLY when the current show has no openingDate.
      // Additionally require the routing to be same-market (or the URL to carry an
      // explicit Broadway marker) — otherwise ID-year proximity alone misroutes
      // legitimate UK reviews of earlier UK productions to a Broadway sibling.
      // Example: a-dolls-house-off-west-end-2026 (null openingDate) with 2022 UK
      // reviews of the Jessica Chastain West End run — nearest sibling by year
      // is a-dolls-house-2023 (BW) but the reviews are NOT about that production.
      const reviewYear = reviewDate.getFullYear();
      const reroute = pickRerouteTarget(sibData.showYear, sibData.siblings, reviewYear);
      if (reroute.action === 'reroute' && !visitedSet.has(reroute.targetShowId)) {
        const target = sibData.siblings.find(s => s.id === reroute.targetShowId);
        const targetIsLondon = target && isLondonMarket(target.category);
        const currentIsLondon = isLondonMarket(category);
        const sameMarket = target && (targetIsLondon === currentIsLondon);
        const hasBroadwayUrlMarker = isBroadwayUrl(url, outletId) !== null;
        if (sameMarket || hasBroadwayUrlMarker) {
          return {
            action: 'reroute',
            targetShowId: reroute.targetShowId,
            reason: `year-level sibling match (review year ${reviewYear} vs current show year ${sibData.showYear})`,
          };
        }
      }
    }
  }

  // --- Same-market same-title disambiguation (added 2026-05-17 per same-title-disambig plan) ---
  // When the sibling index returns ≥1 sibling sharing the *same market pool*
  // (broadway/off-broadway = nyc; west-end/off-west-end = london) and matching
  // normalized title, run a signal cascade to decide which production this
  // review actually covers. Cross-market siblings were already handled by the
  // Tier 1 / Tier 2 reroute block above — this branch only fires for the
  // genuinely ambiguous same-market case (e.g. titanique-2026 vs
  // titanique-off-broadway-2022; the-rocky-horror-show-2026 vs 1975/2000).
  //
  // Signals (collectSameTitleSignals): url-year, publish-date, venue-substring.
  // Require ≥2 corroborating signals before rerouting; with <2 signals on the
  // current show AND ≥1 sibling outscoring it, flag wrongProduction so the
  // existing manual-clear flow can resolve it.
  //
  // Escape hatch: `DISABLE_PRODUCTION_DISAMBIG=true` short-circuits ONLY this
  // same-market branch and falls through to plain `{action:'accept'}` (pre-
  // 2026-05-17 behavior). Cross-market Tier 1/Tier 2 reroute and Guard H
  // above are unaffected.
  // Null category means the show hasn't been categorized yet (e.g. pre-opening
  // WE shows with null category — Schmigadoon 2026-04-22 postmortem). Per
  // venue-classification.js:38, getMarketPool(null) falls back to 'nyc' (the
  // Broadway pool), which would silently collapse a WE show into the same
  // bucket as a Broadway sibling. Skip the same-market disambiguation branch
  // when EITHER the current show OR any sibling has null category — wait for
  // categorization before applying same-market rules. Guard H (cross-market
  // rejection) below still runs so clearly-Broadway URLs land correctly.
  const categoryUnknown = sibData
    && (sibData.category == null || (sibData.siblings || []).some(s => s.category == null));

  if (process.env.DISABLE_PRODUCTION_DISAMBIG !== 'true' && !categoryUnknown
      && sibData && sibData.siblings.length && sibData.title) {
    const currentTitleNorm = normalizeTitle(sibData.title);
    const currentPool = getMarketPool(sibData.category);
    const sameMarketSiblings = sibData.siblings.filter(s =>
      normalizeTitle(s.title) === currentTitleNorm &&
      getMarketPool(s.category) === currentPool &&
      !visitedSet.has(s.id)
    );
    if (sameMarketSiblings.length >= 1) {
      const ctx = { url, publishDate };
      const currentSignals = collectSameTitleSignals(
        { openingDate: sibData.openingDate, closingDate: sibData.closingDate, venue: sibData.venue },
        ctx
      );
      const scored = sameMarketSiblings.map(s => ({
        id: s.id,
        signals: collectSameTitleSignals(s, ctx),
      }));
      // Pick the candidate with the most signals across {current ∪ siblings}.
      const allScored = [{ id: showId, signals: currentSignals, isCurrent: true }, ...scored];
      allScored.sort((a, b) => b.signals.length - a.signals.length);
      const top = allScored[0];
      if (top && !top.isCurrent && top.signals.length >= 2 && top.signals.length > currentSignals.length) {
        return {
          action: 'reroute',
          targetShowId: top.id,
          reason: `same-title-sibling: ${top.signals.join(', ')}`,
        };
      }
      // No strong reroute target — but if the current show has zero signals
      // AND ANY sibling has ≥1 signal, mark ambiguous so manual review handles it.
      if (currentSignals.length === 0 && scored.some(s => s.signals.length > 0)) {
        return {
          action: 'accept',
          flag: 'wrongProduction',
          reason: 'ambiguous-production',
          signalsByCandidate: allScored.map(s => ({ id: s.id, signals: s.signals })),
        };
      }
    }
  }

  // --- Guard H: Broadway URL/outlet rejection for WE shows (no routable target) ---
  // This runs when the sibling reroute didn't fire either because there is no
  // sibling Broadway show in shows.json or dates don't line up. The review is
  // still clearly a Broadway review landing in a WE dir, so reject — avoids
  // polluting the WE dir with a file that CV will flag anyway.
  if (category && isLondonMarket(category)) {
    const crossMarketReason = isBroadwayUrl(url, outletId);
    if (crossMarketReason) {
      return { action: 'reject', reason: `cross-market: ${crossMarketReason}` };
    }
  }

  return { action: 'accept' };
}

module.exports = {
  classifyMarketRouting,
  buildSiblingIndex,
  normalizeTitle,
  collectSameTitleSignals,
  SIBLING_CLOSE_DAYS,
  CROSS_MARKET_SIBLING_CLOSE_DAYS,
  CURRENT_FAR_DAYS,
};
