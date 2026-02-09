#!/usr/bin/env node
/**
 * detect-show-changes.js
 *
 * Detects meaningful changes in show data by comparing current state
 * against the previous digest's currentState. Outputs a digest with
 * changes and current state for the notification sender.
 *
 * Opening-night changes are enriched with critic score, review breakdown,
 * and consensus text for the rich email template.
 *
 * Undelivered changes from the previous digest are carried forward so
 * notifications are never permanently lost if budget is exceeded.
 *
 * Usage: node scripts/detect-show-changes.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIGEST_PATH = path.join(__dirname, '..', 'data', 'audit', 'show-changes-digest.json');

// Thresholds for change detection — only report high-signal changes
const THRESHOLDS = {
  minNewReviews: 3,        // 3+ new reviews to report
  minScoreChange: 3,       // 3+ point critic score change to report
  minAudienceChange: 5,    // 5+ point audience score change to report
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

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z'); // avoid timezone shift
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildCurrentState(shows, reviews, lotteryRush, commercial, audienceBuzz) {
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

  // Build audience buzz map
  const audienceMap = {};
  if (audienceBuzz) {
    const buzzShows = audienceBuzz.shows || {};
    for (const [showId, data] of Object.entries(buzzShows)) {
      if (data.combinedScore != null) {
        audienceMap[showId] = Math.round(data.combinedScore * 10) / 10;
      }
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
      audienceScore: audienceMap[id] || null,
    };
  }

  return state;
}

function detectChanges(currentState, previousState, extras) {
  const changes = {};
  const reviews = extras?.reviews;
  const consensus = extras?.consensus;
  const showsMap = extras?.showsMap || {};

  // Build reviews array for opening-night enrichment
  const allReviews = [];
  if (reviews) {
    const reviewsList = reviews.reviews || reviews;
    const reviewsArr = Array.isArray(reviewsList) ? reviewsList : Object.values(reviewsList);
    allReviews.push(...reviewsArr);
  }

  for (const [showId, current] of Object.entries(currentState)) {
    const prev = previousState[showId];
    if (!prev) continue; // New show — don't report (no baseline)

    const showChanges = [];

    // Status change
    if (current.status !== prev.status) {
      if (prev.status === 'previews' && current.status === 'open') {
        // Opening night — enriched payload for rich email template
        const showReviews = allReviews.filter(r => r.showId === showId && r.adjustedScore != null);
        const positive = showReviews.filter(r => r.adjustedScore >= 65).length;
        const mixed = showReviews.filter(r => r.adjustedScore >= 55 && r.adjustedScore < 65).length;
        const negative = showReviews.filter(r => r.adjustedScore < 55).length;

        // Get consensus (null-safe — may not exist yet for just-opened shows)
        const consensusData = consensus?.shows?.[showId];
        const consensusText = consensusData?.text || null;

        // Get show metadata
        const show = showsMap[showId];

        showChanges.push({
          type: 'opening-night',
          message: 'Show has officially opened on Broadway',
          score: current.score,
          reviewCount: current.reviewCount,
          positive,
          mixed,
          negative,
          consensusText,
          showType: show?.type || null,
          venue: show?.venue || null,
        });
      } else {
        showChanges.push({
          type: 'status-change',
          message: `Status changed: ${prev.status} → ${current.status}`,
        });
      }
    }

    // Opening date change (always report)
    if (current.openingDate !== prev.openingDate && current.openingDate) {
      showChanges.push({
        type: 'date-change',
        message: `Opening date updated to ${formatDate(current.openingDate)}`,
      });
    }

    // Closing date change — split into subtypes
    if (current.closingDate !== prev.closingDate) {
      if (!prev.closingDate && current.closingDate) {
        showChanges.push({
          type: 'closing-announced',
          message: `Closing date announced: ${formatDate(current.closingDate)}`,
        });
      } else if (prev.closingDate && current.closingDate) {
        const prevDate = new Date(prev.closingDate);
        const currDate = new Date(current.closingDate);
        if (currDate > prevDate) {
          showChanges.push({
            type: 'closing-extended',
            message: `Run extended through ${formatDate(current.closingDate)}`,
          });
        } else if (currDate < prevDate) {
          showChanges.push({
            type: 'closing-shortened',
            message: `Closing date moved up to ${formatDate(current.closingDate)}`,
          });
        }
      }
    }

    // New reviews (threshold: 3+)
    const newReviews = current.reviewCount - prev.reviewCount;
    if (newReviews >= THRESHOLDS.minNewReviews) {
      showChanges.push({
        type: 'new-reviews',
        message: `${newReviews} new reviews added`,
      });
    }

    // Critic score shift (threshold: 3+)
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

    // Audience score shift (threshold: 5+)
    if (current.audienceScore != null && prev.audienceScore != null) {
      const audienceDiff = Math.round((current.audienceScore - prev.audienceScore) * 10) / 10;
      if (Math.abs(audienceDiff) >= THRESHOLDS.minAudienceChange) {
        const direction = audienceDiff > 0 ? '+' : '';
        showChanges.push({
          type: 'audience-change',
          message: `Audience score changed: ${prev.audienceScore} → ${current.audienceScore} (${direction}${audienceDiff})`,
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
  const audienceBuzz = loadJSON(path.join(dataDir, 'audience-buzz.json'));
  const consensus = loadJSON(path.join(dataDir, 'critic-consensus.json'));

  if (!shows) {
    console.error('ERROR: Could not load shows.json — cannot detect changes');
    process.exit(1);
  }

  // Build shows map for enrichment
  const showsList = shows.shows || shows;
  const showsArr = Array.isArray(showsList) ? showsList : Object.values(showsList);
  const showsMap = {};
  for (const s of showsArr) {
    if (s.id || s.slug) showsMap[s.id || s.slug] = s;
  }

  // Build current state
  const currentState = buildCurrentState(shows, reviews, lotteryRush, commercial, audienceBuzz);
  console.log(`Built current state for ${Object.keys(currentState).length} shows`);

  // Load previous digest
  let previousState = {};
  let prevPendingChanges = {};
  try {
    const prevDigest = JSON.parse(fs.readFileSync(DIGEST_PATH, 'utf8'));
    previousState = prevDigest.currentState || {};
    // Carry forward any undelivered changes from previous run
    prevPendingChanges = prevDigest.changes || {};
    console.log(`Loaded previous state with ${Object.keys(previousState).length} shows`);
    const pendingCount = Object.keys(prevPendingChanges).length;
    if (pendingCount > 0) {
      console.log(`  (${pendingCount} shows have pending undelivered changes)`);
    }
  } catch {
    console.log('No previous digest found — first run, establishing baseline');
  }

  // Detect new changes
  const newChanges = detectChanges(currentState, previousState, { reviews, consensus, showsMap });

  // Merge: pending undelivered changes + newly detected
  // New detections take priority (fresher data)
  const changes = {};
  for (const [showId, pendingChanges] of Object.entries(prevPendingChanges)) {
    changes[showId] = pendingChanges;
  }
  for (const [showId, newShowChanges] of Object.entries(newChanges)) {
    changes[showId] = newShowChanges; // fresher data wins
  }

  const changedShowCount = Object.keys(changes).length;
  const totalChanges = Object.values(changes).reduce((sum, arr) => sum + arr.length, 0);

  console.log(`\nDetected ${Object.keys(newChanges).length} newly changed shows`);
  console.log(`Total pending: ${totalChanges} changes across ${changedShowCount} shows`);
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
