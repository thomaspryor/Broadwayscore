'use strict';

const fs = require('fs');
const path = require('path');
const { hasSameMarketTitleMatch, countRevivalMentions } = require('../opening-night-completeness.js');

const name = 'revival-unverified';
const description = 'Show shares a canonical title with an earlier production (or review text repeatedly says "revival") but isRevival is not set';

const REVIVAL_MENTION_THRESHOLD = 3;
const SKIP_STATUSES = new Set(['closed']);

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context - expects context.shows (full shows.json array)
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (SKIP_STATUSES.has(show.status)) {
    return { ok: true, severity: 'ok', message: `Status is ${show.status} — revival check not needed` };
  }

  if (show.isRevival === true) {
    return { ok: true, severity: 'ok', message: `isRevival already set for ${show.id}` };
  }

  const shows = context.shows || [];
  const titleMatch = hasSameMarketTitleMatch(show, shows);

  let mentionCount = 0;
  if (!titleMatch) {
    const showDir = path.join(context.reviewTextsRoot, show.id);
    if (fs.existsSync(showDir)) {
      try {
        const texts = fs.readdirSync(showDir)
          .filter(f => f.endsWith('.json'))
          .map(f => {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
              return data.fullText || '';
            } catch {
              return '';
            }
          });
        mentionCount = countRevivalMentions(texts);
      } catch {
        mentionCount = 0;
      }
    }
  }

  if (!titleMatch && mentionCount < REVIVAL_MENTION_THRESHOLD) {
    return { ok: true, severity: 'ok', message: `No revival signal for ${show.id}` };
  }

  const signal = titleMatch
    ? `shares canonical title with another show in the same market`
    : `review text mentions "revival" ${mentionCount}x`;

  return {
    ok: false,
    severity: 'warning',
    message: `${show.id} ${signal} but isRevival is not true — verify and set isRevival if this is a revival`,
    details: { showId: show.id, titleMatch, mentionCount },
  };
}

module.exports = { name, description, run, REVIVAL_MENTION_THRESHOLD };
