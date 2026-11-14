/**
 * Which of the week's openings subscribers already heard about, and which
 * Off-Broadway openings are notable on name alone. Both feed the weekly
 * newsletter's week voice (scripts/newsletter/week-voice.mjs).
 *
 * Owner, 2026-11-02: every Broadway opening gets its own opening-night email
 * the next morning, so a Sunday round-up that leads with "A Few Good Men opens
 * on Broadway" reads as a duplicate. The weekly leads with Off Broadway when
 * every Broadway opening was already announced.
 */
const fs = require('fs');
const path = require('path');
const { findSentRecord } = require('./missed-broadcasts');
const { isBroadwayCategory } = require('./venue-classification');
const { foldDiacritics } = require('./url-slug');

/**
 * Ids (from `ids`) whose opening-night broadcast was actually SENT. A draft
 * still waiting in Resend does not count: if the owner never sent it, the
 * weekly is where subscribers first hear the news.
 */
function announcedShowIds(sentShows, ids, market = 'broadway') {
  if (!sentShows || typeof sentShows !== 'object') return new Set();
  return new Set(ids.filter(id => findSentRecord(sentShows, id, market)));
}

/** Reads data/opening-night-sent.json. Fails open (empty object) when absent. */
function loadSentShows(repoRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'opening-night-sent.json'), 'utf8'));
    return raw && typeof raw.shows === 'object' && raw.shows ? raw.shows : {};
  } catch {
    return {};
  }
}

const normTitle = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * An Off-Broadway revival whose title has played Broadway (In the Heights at
 * City Center): readers know the name, so it earns a mention even when it is
 * neither the most-reviewed nor the best-reviewed opening.
 */
function isNotableRevival(show, allShows) {
  if (!show || !show.isRevival) return false;
  const t = normTitle(show.title);
  if (!t) return false;
  return allShows.some(s => s && s.id !== show.id && isBroadwayCategory(s) && normTitle(s.title) === t);
}

module.exports = { announcedShowIds, loadSentShows, isNotableRevival };
