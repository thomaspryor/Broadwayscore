'use strict';
const { maxPlausibleYear } = require('./date-utils');
// venue-write-guard-ok: `expected: { venue: show.venue }` builds a mismatch report for an archive page; nothing here writes shows.json (moved from scripts/validate-archive-productions.js, BRO-2507).

/**
 * Pure decision logic for scripts/validate-archive-productions.js (BRO-2507).
 *
 * Extracted (CLAUDE.md §15, BRO-31 pattern: mobile-shows-validator.js) so each
 * archive check can be unit-tested from HTML string fixtures without the
 * private aggregator-archive checkout. No fs, console or process.exit here.
 *
 * Each validate*Archive(showId, show, html, file) returns an outcome:
 *   { checked: bool, valid: bool, mismatches: [entry], warnings: [entry] }
 * which the script folds into its running totals. `show` is the shows.json
 * entry (undefined when the archive's showId is unknown); `file` is the
 * archive's basename, echoed into mismatch entries.
 */

const { pageTitleConfirmsShow } = require('./show-matching');

// Stale archives accumulate naturally; the gate only fails above this.
const MISMATCH_THRESHOLD = 80;

const REVIVAL_NOTE = ' (title confirms show — likely a different DTLI-covered revival, not a wrong page)';

function emptyOutcome() {
  return { checked: false, valid: false, mismatches: [], warnings: [] };
}

function notFound(showId, source) {
  const out = emptyOutcome();
  out.warnings.push({ showId, source, issue: 'Show not found in shows.json' });
  return out;
}

/** Extract year from show ID (e.g., "our-town-2024" -> 2024). */
function getYearFromId(showId) {
  const match = showId.match(/-(\d{4})$/);
  return match ? parseInt(match[1]) : null;
}

/**
 * DTLI: opening-night year and theater must match the production.
 * DTLI publishes one page per SHOW TITLE, not per revival (#1763: re-fetching
 * all 90 flagged shows changed nothing), so a year/venue difference on a page
 * whose <title> still confirms the show is downgraded to a warning; it only
 * blocks when the title doesn't corroborate the show at all.
 */
function validateDtliArchive(showId, show, html, file) {
  if (!show) return notFound(showId, 'dtli');
  const out = emptyOutcome();

  const expectedYear = getYearFromId(showId);
  const expectedVenue = show.venue?.toLowerCase() || '';

  // DTLI format: "Opening Night:&nbsp;<span...>December 4, 2002</span>"
  // and "Theater: <a...>Booth Theatre</a>"
  const openingMatch = html.match(/Opening Night[:\s]*(?:&nbsp;)?(?:<[^>]+>)?([A-Za-z]+\s+\d+,?\s+\d{4})/i);
  const theaterMatch = html.match(/Theater[:\s]*(?:<a[^>]+>)?([^<\n]+)/i);

  let pageYear = null;
  let pageTheater = null;
  if (openingMatch) {
    const yearMatch = openingMatch[1].match(/\d{4}/);
    if (yearMatch) pageYear = parseInt(yearMatch[0]);
  }
  if (theaterMatch) pageTheater = theaterMatch[1].trim().toLowerCase();

  out.checked = true;

  const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
  const titleConfirmsShow = pageTitleConfirmsShow(titleTagMatch ? titleTagMatch[1] : '', show.title);

  const flag = (issue) => {
    const entry = {
      showId,
      source: 'dtli',
      file,
      expected: { year: expectedYear, venue: show.venue },
      found: { year: pageYear, theater: pageTheater },
      issue,
    };
    if (titleConfirmsShow) {
      entry.issue += REVIVAL_NOTE;
      out.warnings.push(entry);
    } else {
      out.mismatches.push(entry);
    }
    return out;
  };

  // Year mismatch (1970 is the Unix-epoch placeholder for missing data)
  if (pageYear && pageYear !== 1970 && expectedYear && Math.abs(pageYear - expectedYear) > 1) {
    return flag(`Year mismatch: expected ${expectedYear}, found ${pageYear}`);
  }

  // Obvious venue mismatch, only when the years also differ
  if (pageTheater && expectedVenue &&
      !pageTheater.includes(expectedVenue.split(' ')[0].toLowerCase()) &&
      !expectedVenue.includes(pageTheater.split(' ')[0])) {
    if (pageYear && expectedYear && pageYear !== expectedYear) {
      return flag(`Venue mismatch: expected ${show.venue}, found ${pageTheater}`);
    }
  }

  out.valid = true;
  return out;
}

/**
 * BWW roundups: flag a <title> naming a different production year, or a
 * Kennedy Center tour/tryout page (title/h1 only; sidebar ads are ignored).
 */
function validateBwwArchive(showId, show, html, file) {
  if (!show) return notFound(showId, 'bww');
  const out = emptyOutcome();
  const expectedYear = getYearFromId(showId);
  out.checked = true;

  const yearRegex = /\b(19\d{2}|20\d{2})\b/g;
  const yearsFound = new Set();
  let match;
  while ((match = yearRegex.exec(html)) !== null) {
    yearsFound.add(parseInt(match[1]));
  }

  if (expectedYear && yearsFound.size > 0 && !yearsFound.has(expectedYear)) {
    const otherProductionYears = [...yearsFound].filter(y =>
      y !== expectedYear &&
      y > 1990 && y <= maxPlausibleYear({ atLeast: 2029 }) &&
      Math.abs(y - expectedYear) > 1
    );
    if (otherProductionYears.length > 0) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : '';
      for (const wrongYear of otherProductionYears) {
        if (title.includes(wrongYear.toString()) && !title.includes(expectedYear?.toString())) {
          out.mismatches.push({
            showId,
            source: 'bww',
            file,
            expected: { year: expectedYear },
            found: { yearsInPage: [...yearsFound], titleYear: wrongYear },
            issue: `Possible wrong production: title mentions ${wrongYear}, expected ${expectedYear}`,
          });
          return out;
        }
      }
    }
  }

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].toLowerCase() : '';
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const pageH1 = h1Match ? h1Match[1].toLowerCase() : '';

  if ((pageTitle.includes('kennedy center') || pageH1.includes('kennedy center')) &&
      !show.venue?.toLowerCase().includes('kennedy')) {
    out.mismatches.push({
      showId,
      source: 'bww',
      file,
      expected: { venue: show.venue || 'Broadway' },
      found: { title: pageTitle.trim() },
      issue: 'Page TITLE references Kennedy Center - this is a tour/tryout page, not Broadway',
    });
    return out;
  }

  out.valid = true;
  return out;
}

/**
 * Show Score: canonical URL category must match the show's market. A page
 * that merely mentions "off-broadway" is a warning AND still counts as valid.
 */
function validateShowScoreArchive(showId, show, html, file) {
  if (!show) return notFound(showId, 'show-score');
  const out = emptyOutcome();
  out.checked = true;

  // shows.json stores lowercase categories ('off-broadway'); compare
  // case-insensitively (the original exact 'Off-Broadway' match never fired,
  // so OB shows without an -off-broadway id suffix were treated as Broadway).
  const category = String(show.category || '').toLowerCase();
  const isOffBroadway = category === 'off-broadway' || category === 'off-off-broadway' ||
    showId.includes('-off-broadway-') || showId.endsWith('-off-broadway');
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canonicalMatch) {
    const canonical = canonicalMatch[1];
    const isOffBroadwayUrl = canonical.includes('/off-broadway-shows/') || canonical.includes('/off-off-broadway-shows/');
    if (isOffBroadwayUrl && !isOffBroadway) {
      out.mismatches.push({
        showId,
        source: 'show-score',
        file,
        expected: { type: 'Broadway' },
        found: { canonical },
        issue: 'Canonical URL is off-Broadway/off-off-Broadway, but show is Broadway',
      });
      return out;
    }
    if (!isOffBroadwayUrl && isOffBroadway && canonical.includes('/broadway-shows/')) {
      out.mismatches.push({
        showId,
        source: 'show-score',
        file,
        expected: { type: 'Off-Broadway' },
        found: { canonical },
        issue: 'Canonical URL is Broadway, but show is Off-Broadway',
      });
      return out;
    }
  }

  // Only a Broadway show's page mentioning Off-Broadway is suspicious; an OB
  // show's page saying so is expected (BRO-5261 retro-review).
  if (!isOffBroadway && html.toLowerCase().includes('off-broadway') && !html.toLowerCase().includes('broadway-shows')) {
    out.warnings.push({
      showId,
      source: 'show-score',
      issue: 'Page mentions "off-broadway" - verify this is correct production',
    });
  }

  out.valid = true;
  return out;
}

/** Fold one outcome into the running results object. */
function applyOutcome(results, outcome) {
  if (outcome.checked) results.checked++;
  if (outcome.valid) results.valid++;
  results.mismatches.push(...outcome.mismatches);
  results.warnings.push(...outcome.warnings);
  return results;
}

/** Gate verdict: fail only above the threshold. */
function exceedsMismatchThreshold(mismatchCount, threshold = MISMATCH_THRESHOLD) {
  return mismatchCount > threshold;
}

module.exports = {
  MISMATCH_THRESHOLD,
  getYearFromId,
  validateDtliArchive,
  validateBwwArchive,
  validateShowScoreArchive,
  applyOutcome,
  exceedsMismatchThreshold,
};
