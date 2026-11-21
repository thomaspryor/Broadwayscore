'use strict';

/**
 * outlet-name-shape.js — does a normalized name string read as an OUTLET or
 * as a PERSON? Shared by critic-display-name.js (which of a registry's
 * aliases are placeholder evidence; which person-named blogs are their own
 * critic) and critic-alias-picker.js (which outlet display names the weekly
 * typo picker must never write as a critic). One vocabulary, two callers
 * (audit S7-T1/T5, BRO-4204).
 *
 * outlet-registry.json carries critic names as outlet aliases for legacy
 * "outlet-critic" routing ("mark-kennedy" under ap, "michael-musto" under
 * village-voice, "dan dwyer" under off-script-with-dan-dwyer) and has
 * person-named outlets ("Matt Trueman", "Jonathan Baz", "Carole Di Tosti"),
 * so "is it in the registry" alone cannot separate placeholders from people.
 *
 * Input is the normalizeForCompare() form: lowercase, diacritics folded,
 * punctuation collapsed to single spaces, parentheticals removed.
 */

// Tokens that mark a name as a publication, section, desk or blog.
const OUTLET_WORDS = new Set([
  'time', 'out', 'times', 'post', 'news', 'daily', 'weekly', 'journal', 'magazine',
  'review', 'reviews', 'theatre', 'theater', 'stage', 'broadway', 'london', 'york',
  'guide', 'hub', 'blog', 'press', 'media', 'tribune', 'herald', 'gazette',
  'observer', 'standard', 'telegraph', 'guardian', 'mail', 'sun', 'star', 'express',
  'mirror', 'chronicle', 'examiner', 'record', 'dispatch', 'bulletin', 'ledger',
  'courier', 'sentinel', 'inquirer', 'voice', 'variety', 'playbill', 'world', 'scene',
  'notes', 'notices', 'notebook', 'capital', 'cultural', 'culture', 'arts',
  'productions', 'company', 'group', 'radio', 'tv', 'network', 'com', 'co', 'uk',
  'online', 'digital', 'entertainment', 'lifestyle', 'city', 'metro', 'evening',
  'morning', 'sunday', 'financial', 'business', 'independent', 'american', 'national',
  'international', 'global', 'associated', 'wall', 'street', 'hollywood', 'reporter',
  'deadline', 'wrap', 'vulture', 'stalls', 'spy', 'junkies', 'mezz', 'front', 'row',
  'center', 'centre', 'critics', 'critic', 'circle', 'talkin', 'curtain', 'up',
  'mania', 'scorecard', 'box', 'office', 'ticket', 'tickets', 'seat', 'seats',
  'aisle', 'dazzles', 'boards', 'footlights', 'spotlight', 'limelight', 'stagedoor',
  'door', 'west', 'end', 'off', 'show', 'shows', 'score', 'backstage', 'onstage',
  'the', 'and', 'of', 'in', 'at', 'with', 'for', 'on', 'a', 'an', 'my', 'your',
  'we', 'our', 'about', 'life', 'living', 'style', 'buzz', 'insider', 'central',
  'nation', 'america', 'britain', 'british', 'england', 'scotland', 'ireland',
  'wales', 'edinburgh', 'manchester', 'chicago', 'boston', 'philadelphia',
  'washington', 'los', 'angeles', 'francisco', 'jersey', 'brooklyn', 'manhattan',
  'village', 'town', 'county', 'state', 'square', 'district', 'quarter', 'people',
  'mag', 'monthly', 'quarterly', 'tonight', 'today', 'now', 'live', 'week', 'days',
  'reader', 'readers', 'edition', 'section', 'desk', 'team', 'staff',
  'plays', 'play', 'see', 'seen', 'matinee', 'sauce', 'thoughts', 'talks', 'chat',
  'diary', 'diaries', 'musings', 'ramblings', 'corner', 'lounge', 'club', 'society',
  'collective', 'project', 'zone', 'space', 'room', 'house', 'spot', 'nerd', 'geek',
  'fan', 'fans', 'lover', 'lovers', 'addict', 'junkie', 'goer', 'goers', 'critique',
  'critiques', 'verdict', 'verdicts', 'rating', 'ratings', 'reviewer', 'inc', 'llc',
  'ltd', 'limited', 'corp', 'corporation', 'plc', 'publishing', 'publications',
  'dc', 'nyc', 'ny', 'la', 'sf', 'us', 'usa', 'bww', 'nyt', 'wet', 'dtli', 'lbo',
]);

/** Corporate / publisher forms are never a person ("PLASA Media Inc"). */
const CORPORATE_RE = /\b(?:inc|llc|ltd|limited|corp|corporation|plc|gmbh|publishing|publications|productions|media|holdings|enterprises|associates)\b/;

/**
 * True when a normalized string reads as an outlet: a single token
 * ("bww", "variety", "thestage"), any digit, a corporate form, or any token
 * from OUTLET_WORDS.
 */
function isOutletishName(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  const tokens = k.split(' ').filter(Boolean);
  if (tokens.length <= 1) return true;
  if (/\d/.test(k)) return true;
  if (CORPORATE_RE.test(k)) return true;
  return tokens.some((t) => OUTLET_WORDS.has(t));
}

/**
 * True when a normalized string has the shape of a person's name: two to
 * four alphabetic tokens and nothing that reads as an outlet.
 */
function isPersonShapedName(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  const tokens = k.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (!tokens.every((t) => /^[a-z]+$/.test(t))) return false;
  return !isOutletishName(k);
}

module.exports = { OUTLET_WORDS, CORPORATE_RE, isOutletishName, isPersonShapedName };
