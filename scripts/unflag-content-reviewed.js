#!/usr/bin/env node
/**
 * unflag-content-reviewed.js — Unflag 8 content-verified false positive wrongProduction reviews
 * Phase 3 of the March 2026 cross-revival review recovery.
 *
 * These files were individually reviewed by reading fullText/wrongFullText content
 * and checking venue, cast, director, and date evidence.
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'data', 'review-texts');

const manifest = [
  // Content confirms 2008 production (Cedric the Entertainer, Leguizamo, Osment, dir. Falls). Preview-period review.
  { showId: 'american-buffalo-2008', file: 'variety--david-rooney.json', action: 'unflag', allowEarlyDate: true },

  // Content IS the OB production at PAC NYC. LLM verifier confused OB venue with wrong-production.
  { showId: 'cats-the-jellicle-ball-off-broadway-2024', file: 'nypost--johnny-oleksinski.json', action: 'unflagRestore' },

  // Content confirms 2015 revival (Vanessa Hudgens). Internal showId was gigi-1973.
  { showId: 'gigi-2015', file: 'dctheatrescene--jonathan-mandell.json', action: 'fixShowId', newShowId: 'gigi-2015' },

  // Content confirms Winter Garden Theatre Broadway return. Critic's "touring production" was dismissive rhetoric.
  { showId: 'mamma-mia-2025', file: 'observer--david-cote.json', action: 'unflagRestore' },

  // Content confirms 2016 Broadway return at Nederlander Theatre (Chester Gregory as Berry Gordy).
  { showId: 'motown-the-musical-2016', file: 'nyt-theater--jonathan-mandell.json', action: 'unflag' },

  // URL contains "off-broadway-review", dated Feb 8 2024 = OB run. Note claiming Broadway was incorrect.
  { showId: 'oh-mary-off-broadway-2024', file: 'culturesauce--thom-geier.json', action: 'unflag' },

  // URL and content confirm John Golden Theatre Broadway production (Cumming, Hall, Hodgson, Malone, Roberts).
  { showId: 'operation-mincemeat-2025', file: 'theatre-reviews-limited--joseph-verlezza.json', action: 'unflagRestore' },

  // Content IS the OB production at Westside Theater (Groff, Borle, Blanchard). LLM verifier confused OB with wrong-production.
  { showId: 'little-shop-of-horrors-off-broadway-2019', file: 'vulture--helen-shaw.json', action: 'unflagRestore' },
];

let unflagged = 0, errors = 0;

for (const entry of manifest) {
  const filePath = path.join(BASE, entry.showId, entry.file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${entry.showId}/${entry.file}`);
    errors++;
    continue;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Common: clear wrongProduction flags
  delete data.wrongProduction;
  delete data.wrongShow;
  delete data.wrongProductionNote;

  // Set date bypass flags to prevent rebuild guards from re-flagging
  if (entry.allowEarlyDate) data.allowEarlyDate = true;
  if (entry.allowLateDate) data.allowLateDate = true;

  if (entry.action === 'unflag' || entry.action === 'unflagRestore') {
    // Fix contentTier if it was set to invalid due to wrongProduction
    if (data.contentTier === 'invalid' && data.incompleteReason === 'wrong_content') {
      data.contentTier = data.fullText ? 'complete' : (data.showScoreExcerpt || data.bwwExcerpt || data.dtliExcerpt ? 'excerpt' : 'stub');
      delete data.incompleteReason;
    }
  }

  if (entry.action === 'unflagRestore') {
    // Restore wrongFullText → fullText
    delete data.contentVerification;
    if (data.wrongFullText && !data.fullText) {
      data.fullText = data.wrongFullText;
      delete data.wrongFullText;
    }
    if (data.contentTier === 'invalid') {
      data.contentTier = data.fullText ? 'complete' : (data.showScoreExcerpt || data.bwwExcerpt || data.dtliExcerpt ? 'excerpt' : 'stub');
    }
    if (data.incompleteReason === 'wrong_content') {
      delete data.incompleteReason;
    }
  }

  if (entry.action === 'fixShowId') {
    data.showId = entry.newShowId;
    if (data.contentTier === 'invalid' && data.incompleteReason === 'wrong_content') {
      data.contentTier = data.fullText ? 'complete' : (data.showScoreExcerpt || data.bwwExcerpt || data.dtliExcerpt ? 'excerpt' : 'stub');
      delete data.incompleteReason;
    }
  }

  // Audit trail
  data.contentReviewedAt = new Date().toISOString().split('T')[0];
  data.contentReviewReason = 'LLM content review: venue/cast/date evidence confirms correct production';

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  unflagged++;
  console.log(`✓ ${entry.action} ${entry.showId}/${entry.file}`);
}

console.log(`\n=== SUMMARY ===`);
console.log(`Unflagged: ${unflagged} | Errors: ${errors}`);
