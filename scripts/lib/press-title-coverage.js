'use strict';
/**
 * BRO-7778: can the matchers find a review that names a show by its short title? Critics drop subtitles ("It's A
 * Wonderful Life: A Live Radio Play" is reviewed as "Review: It's a Wonderful Life"). For a show whose billed title
 * has a subtitle, this builds the headline forms critics use for the short title and asks every matcher path
 * (opening-night lane, old poller, URL slug) and the near-miss alert whether it would catch them.
 * Shared by check-opening-night-readiness.js and the generated table test (rule 15).
 */
const { titleMatchesShow, urlSlugMatchesShow } = require('./rss-discovery');
const { mainTitleSplit, sigWords } = require('./show-names');
const { nearMissSignals } = require('./opening-night-lane/near-miss');

/**
 * The short title before a quoted/colon/dash subtitle, whatever its length ("Dolly" for "Dolly: A True Original
 * Musical"). Null when the billed title has no subtitle, or the part before it is an author credit.
 */
function subtitleLead(title) {
  const split = mainTitleSplit(title);
  if (split) return split.main;
  const t = String(title || '').trim();
  const m = t.match(/^(.+?)\s+[“]([^“”]+)[”]\s*$/) || t.match(/^(.+?):\s+(.+)$/) || t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return null;
  const lead = m[1].trim();
  if (/['‘’]s?$/.test(lead) || sigWords(lead).length === 0) return null;
  return lead;
}

function slugOf(t) {
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['‘’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The headline forms critics use for a short title, plus a TheaterMania-style review URL. */
function shortTitleHeadlines(lead) {
  return {
    // Critics type a straight apostrophe where the billing has a curly one ("It’s" -> "It's"); test both.
    headlines: [...new Set([lead, lead.replace(/[\u2018\u2019]/g, "'")])].flatMap((l) => [`Review: ${l}`, `${l} review`, `'${l}' on Broadway, reviewed`]),
    url: `https://www.theatermania.com/news/review-${slugOf(lead)}-on-stage_1234567/`,
  };
}

/**
 * @param {{title: string, akaTitles?: string[]}} show
 * @param {string[]} allShowTitles every billed title, closed shows too
 * @returns {{lead: string|null, status: 'no-subtitle'|'matched'|'near-miss'|'gap', missed: string[]}}
 *   matched: every headline form matches on the lane and the poller paths, and the slug matches;
 *   near-miss: some form fails to match but every form raises the near-miss alert; gap: neither.
 */
function shortTitleCoverage(show, allShowTitles) {
  const lead = show && subtitleLead(show.title);
  if (!lead) return { lead: null, status: 'no-subtitle', missed: [] };
  const aka = Array.isArray(show.akaTitles) ? { akaTitles: show.akaTitles } : {};
  const lane = { fuzzy: true, mainTitle: true, allShowTitles, ...aka };
  const poller = { mainTitle: true, allShowTitles, ...aka };
  const { headlines, url } = shortTitleHeadlines(lead);
  const missed = [];
  for (const h of headlines) {
    if (!titleMatchesShow(h, show.title, lane)) missed.push(`lane: ${h}`);
    if (!titleMatchesShow(h, show.title, poller)) missed.push(`poller: ${h}`);
  }
  if (!urlSlugMatchesShow(url, show.title, aka) && !titleMatchesShow(url.split('/news/')[1].replace(/[-_/]/g, ' '), show.title, poller)) {
    missed.push(`slug: ${url}`);
  }
  if (!missed.length) return { lead, status: 'matched', missed };
  const allNear = headlines.every((h) => nearMissSignals({ title: h, url: 'https://example.com/x' }, show).length > 0);
  return { lead, status: allNear ? 'near-miss' : 'gap', missed };
}

module.exports = { subtitleLead, shortTitleHeadlines, shortTitleCoverage };
