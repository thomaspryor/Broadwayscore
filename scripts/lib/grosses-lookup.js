'use strict';

/**
 * grosses-lookup.js — show -> grosses rows, the slug resolution
 * merge-model-recoupment.js and calculate-recoupment.js use, as a reusable
 * module for the BRO-4989 shadow model. Pure: callers pass the loaded files.
 */

function makeGrossesLookup(grosses, grossesHistory) {
  const weeks = grossesHistory?.weeks || {};
  const slugs = new Set();
  for (const shows of Object.values(weeks)) for (const s of Object.keys(shows)) slugs.add(s);

  function resolveWeeklySlug(showSlug, showId) {
    if (slugs.has(showSlug)) return showSlug;
    if (showId && slugs.has(showId)) return showId;
    const base = showSlug.replace(/-\d{4}$/, '');
    if (slugs.has(base)) return base;
    if (showId) {
      const baseId = showId.replace(/-\d{4}$/, '');
      if (slugs.has(baseId)) return baseId;
    }
    for (const s of slugs) if (s.startsWith(base + '-') || s === base) return s;
    return null;
  }

  function getWeeklyData(slug, showId) {
    const resolved = resolveWeeklySlug(slug, showId);
    if (!resolved) return null;
    const weekly = {};
    for (const [date, shows] of Object.entries(weeks)) if (shows[resolved]) weekly[date] = shows[resolved];
    return Object.keys(weekly).length ? weekly : null;
  }

  function getGrossesAllTime(slug, showId) {
    const base = slug.replace(/-\d{4}$/, '');
    return grosses?.shows?.[slug]?.allTime || grosses?.shows?.[showId]?.allTime || grosses?.shows?.[base]?.allTime || null;
  }

  return { resolveWeeklySlug, getWeeklyData, getGrossesAllTime };
}

module.exports = { makeGrossesLookup };
