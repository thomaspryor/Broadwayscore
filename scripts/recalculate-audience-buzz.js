#!/usr/bin/env node
/**
 * Recalculate all Audience Buzz scores with dynamic weighting
 *
 * Run this after changing the weighting algorithm to update all existing scores.
 */

const fs = require('fs');
const path = require('path');

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore?.score != null;
  const hasMezzanine = sources.mezzanine?.score != null;
  const hasReddit = sources.reddit?.score != null;

  if (!hasShowScore && !hasMezzanine && !hasReddit) {
    return { score: null, weights: null };
  }

  const redditWeight = hasReddit ? 0.20 : 0;
  const remainingWeight = 1 - redditWeight;

  let showScoreWeight = 0;
  let mezzanineWeight = 0;

  if (hasShowScore && hasMezzanine) {
    const ssCount = sources.showScore.reviewCount || 1;
    const mezzCount = sources.mezzanine.reviewCount || 1;
    const totalCount = ssCount + mezzCount;

    showScoreWeight = (ssCount / totalCount) * remainingWeight;
    mezzanineWeight = (mezzCount / totalCount) * remainingWeight;
  } else if (hasShowScore) {
    showScoreWeight = remainingWeight;
  } else if (hasMezzanine) {
    mezzanineWeight = remainingWeight;
  }

  let weightedSum = 0;
  if (hasShowScore) weightedSum += sources.showScore.score * showScoreWeight;
  if (hasMezzanine) weightedSum += sources.mezzanine.score * mezzanineWeight;
  if (hasReddit) weightedSum += sources.reddit.score * redditWeight;

  return {
    score: Math.round(weightedSum),
    weights: {
      showScore: Math.round(showScoreWeight * 100),
      mezzanine: Math.round(mezzanineWeight * 100),
      reddit: Math.round(redditWeight * 100),
    }
  };
}

console.log('Recalculating all Audience Buzz scores with dynamic weighting...\n');

let updated = 0;
for (const [showId, show] of Object.entries(audienceBuzz.shows)) {
  const oldScore = show.combinedScore;
  const { score, weights } = calculateCombinedScore(show.sources);

  if (score !== null) {
    show.combinedScore = score;

    if (score >= 88) show.designation = 'Loving';
    else if (score >= 78) show.designation = 'Liking';
    else if (score >= 68) show.designation = 'Shrugging';
    else show.designation = 'Loathing';

    if (oldScore !== score) {
      console.log(`${show.title}: ${oldScore} → ${score} (SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%)`);
      updated++;
    }
  }
}

audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
audienceBuzz._meta.designationThresholds = {
  'Loving': '88-100',
  'Liking': '78-87',
  'Shrugging': '68-77',
  'Loathing': '0-67'
};
audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20%, Show Score & Mezzanine split remaining 80% by sample size';

fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
console.log(`\nUpdated ${updated} shows. Saved to audience-buzz.json`);
