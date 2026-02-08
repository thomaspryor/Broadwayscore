#!/usr/bin/env node
/**
 * detect-show-changes.js
 *
 * Detects meaningful changes in show data by comparing current state
 * against the previous digest's currentState. Outputs a digest with
 * changes and current state for the notification sender.
 *
 * Usage: node scripts/detect-show-changes.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIGEST_PATH = path.join(__dirname, '..', 'data', 'audit', 'show-changes-digest.json');

// Thresholds for change detection — only report high-signal changes
const THRESHOLDS = {
  minNewReviews: 3,      // 3+ new reviews to report
  minScoreChange: 5,     // 5+ point score change to report
};

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`  Warning: Could not load ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

function hashCreativeTeam(creativeTeam) {
  if (!creativeTeam || !Array.isArray(creativeTeam)) return '';
  const sorted = creativeTeam
    .map(c => `${c.name || ''}:${c.role || ''}`)
    .sort()
    .join('|');
  return crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
}

function buildCurrentState(shows, reviews, lotteryRush, commercial) {
  const state = {};

  if (!shows) return state;
  const showsList = shows.shows || shows;
  const showsArr = Array.isArray(showsList) ? showsList : Object.values(showsList);

  // Build review counts and scores per show from reviews
  const reviewsByShow = {};
  if (reviews) {
    const reviewsList = reviews.reviews || reviews;
    const reviewsArr = Array.isArray(reviewsList) ? reviewsList : Object.values(reviewsList);
    for (const review of reviewsArr) {
      const sid = review.showId;
      if (!sid) continue;
      if (!reviewsByShow[sid]) reviewsByShow[sid] = { count: 0, scores: [] };
      reviewsByShow[sid].count++;
      if (review.adjustedScore != null) {
        reviewsByShow[sid].scores.push(review.adjustedScore);
      }
    }
  }

  // Build lottery/rush map
  const lotteryMap = {};
  if (lotteryRush) {
    const lrShows = lotteryRush.shows || {};
    for (const [showId, data] of Object.entries(lrShows)) {
      const types = [];
      if (data.lottery) types.push('lottery');
      if (data.rush) types.push('rush');
      if (data.sro) types.push('sro');
      if (types.length) lotteryMap[showId] = types.join(',');
    }
  }

  // Build commercial map
  const commercialMap = {};
  if (commercial) {
    const commShows = commercial.shows || {};
    for (const [showId, data] of Object.entries(commShows)) {
      commercialMap[showId] = !!data.recouped;
    }
  }

  for (const show of showsArr) {
    const id = show.id || show.slug;
    if (!id) continue;

    // Only track open and previews shows (closed shows don't change)
    if (show.status === 'closed') continue;

    const reviewData = reviewsByShow[id] || { count: 0, scores: [] };
    const avgScore = reviewData.scores.length > 0
      ? Math.round(reviewData.scores.reduce((a, b) => a + b, 0) / reviewData.scores.length * 10) / 10
      : null;

    state[id] = {
      status: show.status || 'unknown',
      reviewCount: reviewData.count,
      score: avgScore,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      crewHash: hashCreativeTeam(show.creativeTeam),
      lotteryTypes: lotteryMap[id] || null,
      recouped: commercialMap[id] || false,
    };
  }

  return state;
}

function detectChanges(currentState, previousState) {
  const changes = {};

  for (const [showId, current] of Object.entries(currentState)) {
    const prev = previousState[showId];
    if (!prev) continue; // New show — don't report (no baseline)

    const showChanges = [];

    // Status change (always report)
    if (current.status !== prev.status) {
      showChanges.push({
        type: 'status-change',
        message: `Status changed: ${prev.status} → ${current.status}`,
      });
    }

    // Opening/closing date change (always report)
    if (current.openingDate !== prev.openingDate && current.openingDate) {
      showChanges.push({
        type: 'date-change',
        message: `Opening date updated to ${current.openingDate}`,
      });
    }
    if (current.closingDate !== prev.closingDate && current.closingDate) {
      showChanges.push({
        type: 'date-change',
        message: `Closing date set: ${current.closingDate}`,
      });
    }

    // New reviews (threshold: 3+)
    const newReviews = current.reviewCount - prev.reviewCount;
    if (newReviews >= THRESHOLDS.minNewReviews) {
      showChanges.push({
        type: 'new-reviews',
        message: `${newReviews} new reviews added`,
      });
    }

    // Score shift (threshold: 5+)
    if (current.score != null && prev.score != null) {
      const scoreDiff = Math.round((current.score - prev.score) * 10) / 10;
      if (Math.abs(scoreDiff) >= THRESHOLDS.minScoreChange) {
        const direction = scoreDiff > 0 ? '+' : '';
        showChanges.push({
          type: 'score-change',
          message: `Score changed: ${prev.score} → ${current.score} (${direction}${scoreDiff})`,
        });
      }
    }

    // Cast/creative team change (always report)
    if (current.crewHash !== prev.crewHash && current.crewHash && prev.crewHash) {
      showChanges.push({
        type: 'cast-change',
        message: 'Creative team updated',
      });
    }

    // Lottery/rush added (always report)
    if (current.lotteryTypes && current.lotteryTypes !== prev.lotteryTypes) {
      const newTypes = current.lotteryTypes.split(',')
        .filter(t => !prev.lotteryTypes || !prev.lotteryTypes.includes(t));
      if (newTypes.length) {
        showChanges.push({
          type: 'lottery-added',
          message: `New discount ticket option: ${newTypes.join(', ')}`,
        });
      }
    }

    // Recoupment milestone (always report)
    if (current.recouped && !prev.recouped) {
      showChanges.push({
        type: 'recoupment',
        message: 'Show has recouped its investment',
      });
    }

    if (showChanges.length > 0) {
      changes[showId] = showChanges;
    }
  }

  return changes;
}

function main() {
  console.log('Detecting show changes...\n');

  const dataDir = path.join(__dirname, '..', 'data');

  // Load current data
  const shows = loadJSON(path.join(dataDir, 'shows.json'));
  const reviews = loadJSON(path.join(dataDir, 'reviews.json'));
  const lotteryRush = loadJSON(path.join(dataDir, 'lottery-rush.json'));
  const commercial = loadJSON(path.join(dataDir, 'commercial.json'));

  if (!shows) {
    console.error('ERROR: Could not load shows.json — cannot detect changes');
    process.exit(1);
  }

  // Build current state
  const currentState = buildCurrentState(shows, reviews, lotteryRush, commercial);
  console.log(`Built current state for ${Object.keys(currentState).length} shows`);

  // Load previous digest
  let previousState = {};
  try {
    const prevDigest = JSON.parse(fs.readFileSync(DIGEST_PATH, 'utf8'));
    previousState = prevDigest.currentState || {};
    console.log(`Loaded previous state with ${Object.keys(previousState).length} shows`);
  } catch {
    console.log('No previous digest found — first run, establishing baseline');
  }

  // Detect changes
  const changes = detectChanges(currentState, previousState);
  const changedShowCount = Object.keys(changes).length;
  const totalChanges = Object.values(changes).reduce((sum, arr) => sum + arr.length, 0);

  console.log(`\nDetected ${totalChanges} changes across ${changedShowCount} shows`);
  for (const [showId, showChanges] of Object.entries(changes)) {
    console.log(`  ${showId}:`);
    for (const change of showChanges) {
      console.log(`    - [${change.type}] ${change.message}`);
    }
  }

  // Write digest
  const digest = {
    generatedAt: new Date().toISOString(),
    currentState,
    changes,
  };

  fs.mkdirSync(path.dirname(DIGEST_PATH), { recursive: true });
  fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2));
  console.log(`\nDigest written to ${DIGEST_PATH}`);
}

main();
