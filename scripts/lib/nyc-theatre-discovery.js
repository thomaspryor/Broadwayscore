'use strict';

const fs = require('fs');
const path = require('path');
const { newestOpeningFirst } = require('./discovery-eligibility');
const { isLondonMarket } = require('./venue-classification');

const DAY_MS = 86400000;

function queryForShow(show) {
  const category = isLondonMarket(show.category) ? 'west end'
    : show.category === 'off-broadway' ? 'off-broadway' : 'broadway';
  const year = show.openingDate ? new Date(show.openingDate).getUTCFullYear() : '';
  return `site:newyorkcitytheatre.com/news/reviews/ "${show.title}" ${category}${year ? ` ${year}` : ''}`;
}

// A daily retry around opening; weekly for the long tail. A future show's
// weekly miss expires by the start of its opening window, even between runs.
function retryAfter(show, now) {
  const opening = Date.parse(show.openingDate);
  const windowStart = opening - 7 * DAY_MS;
  if (now < windowStart) return Math.min(now + 7 * DAY_MS, windowStart);
  return now + (now <= opening + 14 * DAY_MS ? DAY_MS : 7 * DAY_MS);
}

/**
 * BRO-7546: per-show files survive the existing private archive checkout/push
 * and avoid concurrent targeted runs overwriting a batch's whole state map.
 * `search` is serpQuery: null is unavailable, [] is a successful empty answer.
 */
function createNycTheatreDiscovery({ archiveDir, search, now = Date.now }) {
  const stateDir = path.join(archiveDir, '_discovery');
  const statePath = show => path.join(stateDir, `${show.id}.json`);
  // Status/date changes must reopen discovery even when the search query is
  // unchanged, e.g. previews becoming open after a pre-opening miss.
  const identity = show => JSON.stringify([queryForShow(show), show.openingDate, show.status]);

  function read(show) {
    try {
      const entry = JSON.parse(fs.readFileSync(statePath(show), 'utf8'));
      if (entry.identity !== identity(show) || !Number.isFinite(entry.checkedAt)) return null;
      return entry;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[NYC discovery] Ignoring unreadable state for ${show.id}: ${err.message}`);
      return null;
    }
  }

  function record(show, outcome, checkedAt = now()) {
    const entry = { identity: identity(show), checkedAt, outcome };
    if (outcome === 'not-found') entry.retryAfter = retryAfter(show, checkedAt);
    fs.mkdirSync(stateDir, { recursive: true });
    const file = statePath(show);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry) + '\n');
    fs.renameSync(`${file}.tmp`, file);
    return entry;
  }

  return {
    orderShows(shows) {
      // Persist when each show entered the queue, including deferred work.
      // New arrivals must not jump ahead of old, unvisited shows forever.
      const queuedAt = now();
      const entries = new Map(shows.map(show => [show.id, read(show) || record(show, 'pending', queuedAt)]));
      return newestOpeningFirst(shows).sort((a, b) => {
        const left = entries.get(a.id); const right = entries.get(b.id);
        return left.checkedAt - right.checkedAt || Number(right.outcome === 'pending') - Number(left.outcome === 'pending');
      });
    },

    isDeferred(show) {
      const entry = read(show);
      return entry?.outcome === 'not-found' && Number.isFinite(entry.retryAfter) && entry.retryAfter > now();
    },

    recordArchiveHit(show) { record(show, 'found'); },

    async searchForShow(show) {
      let results;
      try {
        results = await search(queryForShow(show), { nbResults: 5 });
      } catch (err) {
        record(show, 'unavailable');
        throw err;
      }
      if (!Array.isArray(results)) {
        record(show, 'unavailable');
        return { url: null, outcome: 'unavailable' };
      }
      const url = results.map(r => r.url).find(url => url && url.includes('newyorkcitytheatre.com') && /\/news\/reviews\/\d+/.test(url)) || null;
      const outcome = url ? 'found' : 'not-found';
      record(show, outcome);
      return { url, outcome };
    },
  };
}

module.exports = { createNycTheatreDiscovery };
