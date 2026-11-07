'use strict';
// BRO-6211: does the recoupment poller watch the outlets our commercial data cites?
// Playbill (113 shows) and Broadway News (58) were cited for months while the poller
// watched only Variety, Deadline, THR and Broadway Journal. Pure functions so tests
// require() the real code; the CLI is scripts/audit-commercial-source-coverage.js.

// A host cited by at least this many shows must be tracked or exempt (with a reason).
const FAIL_AT_SHOWS = 10;
// Hosts approaching the bar are reported so a new outlet is seen before it fails.
const WARN_AT_SHOWS = 5;

// Per-show URL fields that count as a citation. costHistory[].sourceUrl is left out
// on purpose: ~1,400 per-year cost rows would drown the per-show signal. Free-text
// fields (notes) are not parsed.
function citationUrls(show) {
  const urls = [];
  for (const s of (show && show.sources) || []) if (s && s.url) urls.push(s.url);
  if (show && show.analystRecoupUrl) urls.push(show.analystRecoupUrl);
  if (show && show.commercialConversion && show.commercialConversion.sourceUrl) urls.push(show.commercialConversion.sourceUrl);
  if (show && typeof show.recoupedSource === 'string' && /^https?:\/\//.test(show.recoupedSource.trim())) urls.push(show.recoupedSource.trim());
  return urls;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** @returns {Map<string, number>} host -> number of distinct shows citing it */
function countCitedHosts(commercialShows) {
  const counts = new Map();
  for (const show of Object.values(commercialShows || {})) {
    const hosts = new Set(citationUrls(show).map(hostOf).filter(Boolean));
    for (const h of hosts) counts.set(h, (counts.get(h) || 0) + 1);
  }
  return counts;
}

/** Hosts of feeds the hourly recoupment poller reads. */
function trackedHosts(trackFeeds) {
  return new Set(trackFeeds.map(f => hostOf(f.url)).filter(Boolean));
}

/**
 * @param {Map<string,number>} counts
 * @param {Set<string>} tracked
 * @param {Record<string,string>} exempt host -> reason
 */
function evaluateCoverage(counts, tracked, exempt, { failAt = FAIL_AT_SHOWS, warnAt = WARN_AT_SHOWS } = {}) {
  const uncovered = [];
  const warnings = [];
  const staleExemptions = [];
  const emptyReasons = [];
  for (const [host, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (tracked.has(host) || Object.prototype.hasOwnProperty.call(exempt, host)) continue;
    if (n >= failAt) uncovered.push({ host, shows: n });
    else if (n >= warnAt) warnings.push({ host, shows: n });
  }
  for (const [host, reason] of Object.entries(exempt)) {
    if (!String(reason || '').trim()) emptyReasons.push(host);
    // Nothing cites it any more, or it is now tracked: the exemption is dead weight.
    if (!counts.has(host) || tracked.has(host)) staleExemptions.push(host);
  }
  return { uncovered, warnings, staleExemptions, emptyReasons };
}

// Cited hosts the poller cannot watch, each with the reason (verified 2026-10-25).
const EXEMPT_HOSTS = {
  'sec.gov': 'Form D filings; covered by the SEC Form D tooling, not news.',
  'reddit.com': 'Community posts and AMAs; a forum, not a news feed.',
  'forum.broadwayworld.com': 'Forum threads; not a news feed.',
  'ibdb.com': 'Reference database; no news feed.',
  'broadwayworld.com': 'No usable feed: /rss/news.xml is 404 and /rss/ is an HTML page (2026-10-25).',
  'theatermania.com': 'Feed URLs return an empty 1KB body with no items (2026-10-25).',
  'forbes.com': 'Feed URLs return 404 (2026-10-25); Forbes cites are one-off features.',
  'broadway.com': 'Ticketing site; /feed/ and /rss/ return 404 (2026-10-25).',
  'manhattantheatreclub.com': 'Nonprofit self-reports (company pages); its /feed/ has no items.',
  'roundabouttheatre.org': 'Nonprofit self-reports (annual reports); no news feed.',
  'investmentbroadway.com': 'Investor newsletter; /feed/ returns 404 (2026-10-25).',
  'lct.org': 'Nonprofit self-reports (company pages); no news feed.',
  'nytimes.com': 'NYT Theater RSS answers 403 to the poller\'s Node client (curl gets 200) as of 2026-10-25; tracking it would raise a dead-feed alert every run. Recoupment news there relies on the Friday SERP scraper.',
  'archive.nytimes.com': 'Archived NYT articles; same outlet as nytimes.com above.',
};

module.exports = { FAIL_AT_SHOWS, WARN_AT_SHOWS, EXEMPT_HOSTS, citationUrls, hostOf, countCitedHosts, trackedHosts, evaluateCoverage };
