'use strict';
const trust = require('./trust-model');

/** Persist the scorer's complete record in its own lane slot, using the shared write guards. */
function createLaneReviewWriter({ reviewTextsDir, show, night } = {}) {
  if (!reviewTextsDir || !show || !show.id || !night) throw new Error('lane writer: reviewTextsDir, show and night are required');
  const fs = require('fs');
  const path = require('path');
  const { safeWriteReview } = require('../review-write-guard');
  const { stampFirstSeen } = require('../review-file-writer');
  const { isShowDirHiddenBySparseCheckout } = require('../sparse-checkout-guard');
  const root = path.resolve(reviewTextsDir);
  const dir = path.resolve(root, show.id);
  if (path.dirname(dir) !== root) throw new Error('lane writer: show id must name one directory');
  return (row) => {
    if (!row || row.showId !== show.id || row.openingNightLane?.night !== night
        || !trust.isLaneReview(row, { openingDate: show.openingDate })
        || !Number.isFinite(row.assignedScore) || row.assignedScore < 0 || row.assignedScore > 100) {
      throw new Error('lane writer: expected a scored lane review for this show and night');
    }
    if (isShowDirHiddenBySparseCheckout(root, show.id)) throw new Error('lane writer: show is outside the sparse checkout');
    const existing = new Map();
    if (fs.existsSync(dir)) {
      for (const filename of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        // Fail closed on a torn/corrupt file rather than treating its occupied slot as empty.
        existing.set(filename, JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')));
      }
    }
    const { filename } = trust.laneReviewFilename({ outletId: row.outletId, criticName: row.criticName, night, url: row.url, existing });
    const file = path.resolve(dir, filename);
    if (path.dirname(file) !== dir) throw new Error('lane writer: filename must stay in the show directory');
    fs.mkdirSync(dir, { recursive: true });
    // firstSeenAt is the retrieval clock the press-night same-night gate reads (review-file-writer.stampFirstSeen):
    // stamped once, when the lane creates the file, from the pass that saw the review. Never on a merge.
    const out = { ...row };
    if (!fs.existsSync(file)) stampFirstSeen(out, row.openingNightLane.seenAt);
    const result = safeWriteReview(file, out);
    if (!result.wrote) throw new Error(`lane writer: write refused (${result.skipped || 'unknown'})`);
    return { file, row: JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
}


module.exports = { createLaneReviewWriter };
