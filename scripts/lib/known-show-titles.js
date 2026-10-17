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

/**
 * normalizeTitle() with "+" read as "and", so "Romeo + Juliet" and "Romeo and
 * Juliet" compare equal here. Kept local: the shared normalizeTitle keeps them
 * apart on purpose for scrapers matching distinct productions.
 */
function normalizeShowLabel(s) {
  return normalizeTitle(String(s || '').replace(/\+/g, ' and '));
}

let titles = null; // Set of normalized titles
let byId = null;   // Map showId -> title

function load() {
  if (titles && byId) return;
  const t = new Set();
  const m = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
    for (const s of (raw.shows || raw)) {
      if (!s) continue;
      if (s.id) m.set(s.id, s.title || '');
      const n = normalizeShowLabel(s.title);
      if (n) t.add(n);
    }
  } catch { /* shows.json unavailable: no known titles */ }
  if (!titles) titles = t;
  if (!byId) byId = m;
}

/** @returns {Set<string>} normalizeShowLabel() of each shows.json title */
function knownShowTitles() {
  load();
  return titles;
}

/** shows.json title for a show id, or '' when unknown. */
function showTitleForId(showId) {
  load();
  return (showId && byId.get(showId)) || '';
}

/**
 * Tests: replace the known-title set with these titles (normalized here),
 * leaving the id lookup alone; null drops both caches so they reload from disk.
 */
function setKnownShowTitlesForTest(list) {
  if (list) {
    titles = new Set(list.map(normalizeShowLabel).filter(Boolean));
  } else {
    titles = null;
    byId = null;
  }
}

module.exports = { knownShowTitles, showTitleForId, normalizeShowLabel, setKnownShowTitlesForTest };
