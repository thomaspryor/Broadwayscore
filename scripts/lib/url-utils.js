/**
 * Shared URL utility functions
 *
 * Centralizes URL helpers that were previously duplicated across 4+ ticket scripts.
 * Import from here instead of reimplementing.
 */

/**
 * Extract domain from URL, stripping www. prefix
 * @param {string} url
 * @returns {string|null} domain or null if URL is invalid
 */
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Zero-width spaces, LTR/RTL marks, BOM -- some sites (e.g. theatre.reviews) inject
// these into canonical URLs invisibly, breaking byte-for-byte comparison (see #702).
const INVISIBLE_UNICODE_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

function stripInvisibleUnicode(url) {
  return url.normalize('NFC').replace(INVISIBLE_UNICODE_RE, '');
}

/**
 * Normalize a URL for comparison: strip invisible Unicode, query params, lowercase, remove trailing slash
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    return stripInvisibleUnicode(url).split('?')[0].toLowerCase().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Normalize a show name for fuzzy comparison
 * @param {string} name
 * @returns {string}
 */
function normalizeShowName(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a TodayTix URL from an ID and slug
 * @param {number|string} id
 * @param {string} slug
 * @param {string} [city='nyc'] - 'nyc' or 'london'
 * @returns {string}
 */
function buildTodayTixUrl(id, slug, city = 'nyc') {
  return `https://www.todaytix.com/${city}/shows/${id}-${slug}`;
}

/**
 * Known title→slug exceptions for Telecharge where standard construction doesn't match
 */
const TELECHARGE_EXCEPTIONS = {
  'Chicago': 'Chicago-The-Musical',
};

/**
 * Build a deterministic Telecharge URL from show title.
 * Used as fallback when SERP discovery fails (Telecharge blocks HTTP via Akamai).
 * @param {string} showTitle
 * @returns {string}
 */
function buildTelechargeUrl(showTitle) {
  if (TELECHARGE_EXCEPTIONS[showTitle]) {
    return 'https://www.telecharge.com/Broadway/' + TELECHARGE_EXCEPTIONS[showTitle];
  }
  const slug = showTitle
    .replace(/&/g, 'And')
    .replace(/[''!,.:;?"()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return 'https://www.telecharge.com/Broadway/' + slug;
}

module.exports = {
  getDomain,
  normalizeUrl,
  normalizeShowName,
  buildTodayTixUrl,
  buildTelechargeUrl,
  TELECHARGE_EXCEPTIONS,
  stripInvisibleUnicode,
};
