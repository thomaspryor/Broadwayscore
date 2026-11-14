'use strict';

/**
 * Script-side reader for src/config/markets.json (BRO-4211): the one table of
 * show categories. Scripts read NEXT_PUBLIC_FEATURES themselves (they run in
 * prebuild, outside Next's featureFlags), so the gate takes the env string.
 */

const { categories: MARKETS } = require('../../src/config/markets.json');

const VALID_CATEGORIES = Object.keys(MARKETS);

function enabledFeatures(featuresEnv = process.env.NEXT_PUBLIC_FEATURES) {
  return new Set(String(featuresEnv || '').split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * True when a show of this category may appear on public surfaces (pages,
 * sitemap, search). Unknown categories are allowed: the gate only hides
 * categories that explicitly declare a feature flag.
 */
function isCategoryEnabled(category, featuresEnv) {
  const row = MARKETS[category];
  const flag = row?.featureFlag;
  return !flag || row.launched === true || enabledFeatures(featuresEnv).has(flag);
}

/** True when this category must be withheld from public/data (the iOS app feed). */
function isHiddenFromAppFeed(category, featuresEnv) {
  // Env flag only, never `launched`: launching a category on the website must
  // not push it into the iOS app before the app can show it (BRO-4254).
  const row = MARKETS[category];
  if (!row?.hideFromAppFeed) return false;
  return !(row.featureFlag && enabledFeatures(featuresEnv).has(row.featureFlag));
}

/**
 * True when a category gets its public/data per-show file and show-lookup row.
 * Everything the app feed carries (regional included, flag or not), plus a
 * category the website shows but the app withholds (tour, launched in code).
 * Gating these on isCategoryEnabled alone dropped the 30 regional detail files
 * whenever CI ran without NEXT_PUBLIC_FEATURES (ship-check, BRO-4262).
 */
function isPublishedShowFile(category, featuresEnv) {
  return !isHiddenFromAppFeed(category, featuresEnv) || isCategoryEnabled(category, featuresEnv);
}

module.exports = { MARKETS, VALID_CATEGORIES, isCategoryEnabled, isHiddenFromAppFeed, isPublishedShowFile };
