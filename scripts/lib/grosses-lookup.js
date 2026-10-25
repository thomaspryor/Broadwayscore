'use strict';

/**
 * grosses-lookup.js — show -> grosses rows, the one slug resolution
 * calculate-recoupment.js, merge-model-recoupment.js and the BRO-4989 shadow
 * model share. Pure: callers pass the loaded files.
 *
 * Exact keys only (BRO-5016). grosses-history.json and grosses.json are keyed
 * by shows.json slug, one key per production (the history writers re-key rows
 * to the run that holds their week; validate-data.js flags non-slug keys). The
 * old fallbacks (strip the year, then any key with that prefix) handed one
 * production another's figures: cabaret-2024 read cabaret-2014's 24 years of
 * Cabaret weeks, doubt read doubt-2005, ragtime-2009 read the 2025 revival's
 * all-time row. A show with no key of its own has no grosses.
 */

function makeGrossesLookup(grosses, grossesHistory) {
  const weeks = grossesHistory?.weeks || {};
  const slugs = new Set();
  for (const shows of Object.values(weeks)) for (const s of Object.keys(shows)) slugs.add(s);

  // showId is accepted for callers that hold one; a few legacy rows were keyed by id.
  function resolveWeeklySlug(showSlug, showId) {
    if (slugs.has(showSlug)) return showSlug;
    if (showId && slugs.has(showId)) return showId;
    return null;
  }

  function getWeeklyData(slug, showId) {
    const resolved = resolveWeeklySlug(slug, showId);
    if (!resolved) return null;
    const weekly = {};
    for (const [date, shows] of Object.entries(weeks)) if (shows[resolved]) weekly[date] = shows[resolved];
    return Object.keys(weekly).length ? weekly : null;
  }

  // A production with weekly rows but no all-time row (The Music Man 2022,
  // Take Me Out 2022: grosses.json never got one) gets the sum of its own
  // weeks, so the model's tier gate does not skip a show it can run (BRO-5647).
  function sumOfWeeks(slug, showId) {
    const weekly = getWeeklyData(slug, showId);
    if (!weekly) return null;
    const total = { gross: 0, performances: 0, attendance: 0, fromWeekly: true };
    for (const row of Object.values(weekly)) {
      total.gross += row.gross || 0;
      total.performances += row.performances || 0;
      total.attendance += row.attendance || 0;
    }
    return total.gross > 0 ? total : null;
  }

  function getGrossesAllTime(slug, showId) {
    return grosses?.shows?.[slug]?.allTime || (showId && grosses?.shows?.[showId]?.allTime) || sumOfWeeks(slug, showId);
  }

  return { resolveWeeklySlug, getWeeklyData, getGrossesAllTime };
}

module.exports = { makeGrossesLookup };
