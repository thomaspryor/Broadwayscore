'use strict';
/**
 * Normalized titles of every show in data/shows.json, loaded once.
 *
 * BRO-5223: the star fallthrough in score-extractors.js only treats a star
 * group as another show's rating when its label IS a known show title, never
 * merely because the label does not match this show. shows.json missing (a
 * fresh checkout, some CI jobs) gives an empty set, so that rule abstains.
 */
const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./title-match');

let cached = null;
let byId = null;

/** @returns {Set<string>} normalizeTitle() of each shows.json title */
function knownShowTitles() {
  if (cached) return cached;
  cached = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
    for (const s of (raw.shows || raw)) {
      const t = s && normalizeTitle(s.title || '');
      if (t) cached.add(t);
    }
  } catch { /* shows.json unavailable: no known titles */ }
  return cached;
}

/** shows.json title for a show id, or '' when unknown. */
function showTitleForId(showId) {
  if (!byId) {
    byId = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
      for (const s of (raw.shows || raw)) if (s && s.id) byId.set(s.id, s.title || '');
    } catch { /* shows.json unavailable */ }
  }
  return (showId && byId.get(showId)) || '';
}

/** Tests: replace the set with these titles (normalized here); null reloads from disk. */
function setKnownShowTitlesForTest(titles) {
  cached = titles ? new Set(titles.map(normalizeTitle).filter(Boolean)) : null;
}

module.exports = { knownShowTitles, showTitleForId, setKnownShowTitlesForTest };
