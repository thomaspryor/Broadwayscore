/**
 * creator-partnerships.js
 *
 * BRO-59: distribution pivot away from direct owner self-promotion on
 * r/Broadway (see the promo-phase cap in reddit-engagement-digest.js) toward
 * partnerships with the VideoScore creators (data/video-creators.json) —
 * they already have their own Reddit/TikTok/YouTube audiences and organic
 * credibility a brand account posting links doesn't.
 *
 * data/creator-partnerships.json tracks partnership status only. It joins
 * against data/video-creators.json by `creatorId` rather than duplicating
 * name/platform/subscriber fields, so the two files can't drift out of sync.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

const VALID_STATUSES = ['prospect', 'contacted', 'active', 'declined', 'inactive'];

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadPartnerships(dataDir = DEFAULT_DATA_DIR) {
  const data = loadJSON(path.join(dataDir, 'creator-partnerships.json'));
  return data.partnerships || [];
}

function loadCreators(dataDir = DEFAULT_DATA_DIR) {
  const data = loadJSON(path.join(dataDir, 'video-creators.json'));
  return data.creators || [];
}

/**
 * Pure join: partnership tracking fields + creator identity/platform fields.
 * Partnerships referencing an unknown creatorId are dropped (data/video-creators.json
 * is the source of truth for identity — a dangling partnership row is a bug, not a
 * partner to display).
 */
function joinPartnershipsWithCreators(partnerships, creators) {
  const creatorById = new Map(creators.map(c => [c.id, c]));
  return partnerships
    .map(p => {
      const creator = creatorById.get(p.creatorId);
      if (!creator) return null;
      return {
        creatorId: p.creatorId,
        name: creator.name,
        primaryPlatform: creator.primaryPlatform,
        subscribers: creator.subscribers,
        status: p.status,
        notes: p.notes || null,
        lastContactedAt: p.lastContactedAt || null,
      };
    })
    .filter(Boolean);
}

function summarizeByStatus(partnerships) {
  const summary = Object.fromEntries(VALID_STATUSES.map(s => [s, 0]));
  for (const p of partnerships) {
    if (Object.prototype.hasOwnProperty.call(summary, p.status)) {
      summary[p.status]++;
    }
  }
  return summary;
}

module.exports = {
  VALID_STATUSES,
  loadPartnerships,
  loadCreators,
  joinPartnershipsWithCreators,
  summarizeByStatus,
};
