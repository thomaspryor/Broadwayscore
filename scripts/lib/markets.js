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
  const flag = MARKETS[category]?.featureFlag;
  return !flag || enabledFeatures(featuresEnv).has(flag);
}

/** True when this category must be withheld from public/data (the iOS app feed). */
function isHiddenFromAppFeed(category, featuresEnv) {
  return Boolean(MARKETS[category]?.hideFromAppFeed) && !isCategoryEnabled(category, featuresEnv);
}

module.exports = { MARKETS, VALID_CATEGORIES, isCategoryEnabled, isHiddenFromAppFeed };
