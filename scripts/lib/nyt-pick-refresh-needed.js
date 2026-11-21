'use strict';
/**
 * Decides whether the opening-night poller should re-check the NYT Critic's
 * Picks spotlight page before its fast_path rebuild.
 *
 * Why: data/nyt-critics-picks.json is otherwise refreshed only Mon/Wed/Fri
 * (weekly-nyt-critics-picks.yml), so a pick published on opening night went
 * without its badge for up to two days (School Girls 2026, Helen Shaw).
 *
 * The check fires only for RECENT, UNFLAGGED NYT reviews of the polled shows
 * whose URL is not already a pick. Most NYT reviews never become picks, so a
 * negative cache (minIntervalMin) caps the proxied fetch to one per window
 * instead of one per poll.
 */

const fs = require('fs');
const path = require('path');

// Must match rebuild-all-reviews.js canonicalPickUrl (origin + pathname, no
// trailing slash). Deliberately NOT nyt-pick-coverage.js canonicalUrl, which
// also rewrites host/protocol and could call a URL covered that the rebuild
// would still treat as not a pick.
function canonicalPickUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return String(u);
  }
}

function isFlagged(data) {
  const cv = data.contentVerification || {};
  return Boolean(
    data.wrongProduction || data.wrongShow || data.isRoundupArticle ||
    cv.wrongProduction || cv.wrongShow || cv.isRoundupArticle
  );
}

function isNytReview(data) {
  return String(data.outletId || '').startsWith('nytimes');
}

/**
 * @param {object} args
 * @param {Array<{showId: string, reviews: object[]}>} args.shows
 * @param {string[]} args.pickUrls - URLs from data/nyt-critics-picks.json
 * @param {Date} args.now
 * @param {number} [args.maxAgeDays=3] - only reviews published this recently
 * @returns {string[]} canonical NYT review URLs that are not yet picks
 */
function findUnpickedNytUrls({ shows, pickUrls, now, maxAgeDays = 3 }) {
  const picks = new Set((pickUrls || []).map(canonicalPickUrl));
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const out = new Set();
  for (const { reviews } of shows) {
    for (const r of reviews) {
      if (!r || !isNytReview(r) || isFlagged(r) || !r.url) continue;
      // Fresh opening-night stubs can lack publishDate; firstSeenAt is when we found it.
      const published = require('./date-utils').toDateMs(r.publishDate || r.firstSeenAt);
      if (!Number.isFinite(published) || published < cutoff) continue;
      const canon = canonicalPickUrl(r.url);
      if (!picks.has(canon)) out.add(canon);
    }
  }
  return [...out].sort();
}

/** True when the last spotlight check is older than minIntervalMin (or absent/unreadable). */
function checkIsDue({ lastCheckedAt, now, minIntervalMin }) {
  const last = Date.parse(lastCheckedAt || '');
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= minIntervalMin * 60 * 1000;
}

function readShowReviews(reviewTextsDir, showId) {
  const dir = path.join(reviewTextsDir, showId);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const reviews = [];
  for (const f of files) {
    try { reviews.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip unreadable */ }
  }
  return reviews;
}

module.exports = { canonicalPickUrl, findUnpickedNytUrls, checkIsDue, isFlagged };

// CLI: node scripts/lib/nyt-pick-refresh-needed.js --shows=a,b [--min-interval-min=30] [--mark-checked]
// Prints `refresh_needed=true|false` (GITHUB_OUTPUT format) and the reason. Always exits 0.
if (require.main === module) {
  const root = path.join(__dirname, '..', '..');
  const arg = (name) => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
  const statePath = path.join(root, 'data', 'audit', 'nyt-spotlight-check.json');
  const now = new Date();

  if (process.argv.includes('--mark-checked')) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2) + '\n');
    console.log(`marked spotlight checked at ${now.toISOString()}`);
    process.exit(0);
  }

  const showIds = arg('shows').split(',').map(s => s.trim()).filter(Boolean);
  const minIntervalMin = Number(arg('min-interval-min') || 30);
  let pickUrls = [];
  try { pickUrls = JSON.parse(fs.readFileSync(path.join(root, 'data', 'nyt-critics-picks.json'), 'utf8')).urls || []; } catch { /* treat as empty */ }
  const reviewTextsDir = path.join(root, 'data', 'review-texts');
  const shows = showIds.map(showId => ({ showId, reviews: readShowReviews(reviewTextsDir, showId) }));
  const unpicked = findUnpickedNytUrls({ shows, pickUrls, now });
  let lastCheckedAt = null;
  try { lastCheckedAt = JSON.parse(fs.readFileSync(statePath, 'utf8')).lastCheckedAt; } catch { /* never checked */ }
  const due = checkIsDue({ lastCheckedAt, now, minIntervalMin });

  const needed = unpicked.length > 0 && due;
  console.log(`refresh_needed=${needed}`);
  console.error(`[nyt-pick-refresh-needed] ${unpicked.length} recent NYT review(s) not yet picks; last spotlight check ${lastCheckedAt || 'never'}; due=${due}`);
  unpicked.forEach(u => console.error(`  ${u}`));
  process.exit(0);
}
