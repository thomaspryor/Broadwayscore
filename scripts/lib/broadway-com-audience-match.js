'use strict';

// Broadway.com listings have titles but no venue. Keep source-specific matches here.
const { isBroadwayCategory } = require('./venue-classification');
const { isBroadwayComMarket } = require('./audience-weighting');

// ---- Title matching ----

function normalize(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/g, '')
    .trim();
}

// Manual overrides: Broadway.com title → our show ID
const BROADWAY_COM_OVERRIDES = {
  // BRO-5950: the live listing uses "860" for the press title "Billy Crystal 860".
  '860': 'billy-crystal-860-2026',
  'Sunset Blvd.': 'sunset-boulevard-2024',
  'BOOP! The Betty Boop Musical': 'boop-2025',
  'A Wonderful World': 'a-wonderful-world-the-louis-armstrong-musical-2024',
  'Buena Vista Social Club™': 'buena-vista-social-club-2025',
  'MJ': 'mj-2022',
  'SIX: The Musical': 'six-2021',
  'Joe Turner\'s Come and Gone': 'joe-turners-come-and-gone-2009',
  'Beaches': 'beaches-2026',
};

function matchBroadwayComToShows(bcShows, ourShows) {
  const matches = [];
  const today = new Date().toISOString().split('T')[0];

  // Build lookup by normalized title
  const ourByNorm = new Map();
  for (const show of ourShows) {
    const norm = normalize(show.title);
    if (!ourByNorm.has(norm)) ourByNorm.set(norm, []);
    ourByNorm.get(norm).push(show);
  }

  for (const bc of bcShows) {
    // Check manual override first
    if (BROADWAY_COM_OVERRIDES[bc.title]) {
      const overrideId = BROADWAY_COM_OVERRIDES[bc.title];
      const show = ourShows.find(s => s.id === overrideId);
      if (show) {
        matches.push({ bc, show, confidence: 'override' });
        continue;
      }
    }

    const bcNorm = normalize(bc.title);

    // Broadway.com only lists Broadway shows — treat all as Broadway category
    const isBroadway = true;

    // Exact normalized title match
    const candidates = ourByNorm.get(bcNorm);
    if (candidates && candidates.length > 0) {
      // Filter to productions that have started (date-only, no status shortcut)
      const started = candidates.filter(s => {
        const start = s.previewsStartDate || s.openingDate;
        return !start || start <= today;
      });
      // Prefer same-category matches, fall back to any non-London
      const sameCategory = started.filter(s => {
        if (isBroadway) return isBroadwayCategory(s);
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : started.filter(s => isBroadwayComMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ bc, show: best, confidence: 'exact' });
        continue;
      }
    }

    // Prefix matching (handles subtitle differences)
    const prefixCandidates = [];
    for (const show of ourShows) {
      const showNorm = normalize(show.title);
      const shorter = bcNorm.length <= showNorm.length ? bcNorm : showNorm;
      const longer = bcNorm.length <= showNorm.length ? showNorm : bcNorm;

      if (shorter.length >= 8 && longer.startsWith(shorter + ' ')) {
        const ratio = shorter.length / longer.length;
        if (ratio >= 0.3) {
          const start = show.previewsStartDate || show.openingDate;
          if (!start || start <= today) {
            prefixCandidates.push(show);
          }
        }
      }
    }
    if (prefixCandidates.length > 0) {
      // Apply same category/recency filtering as exact matches
      const sameCategory = prefixCandidates.filter(s => {
        if (isBroadway) return isBroadwayCategory(s);
        return s.category === 'off-broadway';
      });
      const eligible = sameCategory.length > 0 ? sameCategory : prefixCandidates.filter(s => isBroadwayComMarket(s.category));
      const best = eligible.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''))[0];
      if (best) {
        matches.push({ bc, show: best, confidence: 'prefix' });
      }
    }
  }

  return matches;
}

module.exports = { matchBroadwayComToShows };
