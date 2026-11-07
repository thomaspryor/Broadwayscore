/**
 * Known syndication pairs — shared across rebuild + gather-reviews.
 *
 * Same critic publishes at a primary outlet + one or more secondary outlets
 * simultaneously (wire service, content-sharing agreement). Secondary copies
 * are skipped at rebuild time even without an isSyndicatedDuplicate flag on file,
 * and gather-reviews uses this map to avoid creating duplicate files.
 *
 * Keys are lowercase critic names. Values are { primary, secondary[] } where
 * each entry is the outletId used in the review-texts filenames.
 *
 * Extracted per CLAUDE.md §15 so tests can require() the real data without
 * copying it. Added via Pattern Card #6.
 */
const { foldDiacritics } = require('./title-match');

const KNOWN_SYNDICATION_PAIRS = {
  'chris jones': { primary: 'chicagotribune', secondary: ['nydailynews'] },
  'kathleen campion': { primary: 'nytg', secondary: ['front-row-center'] },
  'tulis mccall': { primary: 'nytg', secondary: ['front-row-center'] },
  'stanford friedman': { primary: 'nytg', secondary: ['front-row-center'] },
  'david rooney': { primary: 'hollywood-reporter', secondary: ['reuters'] },
  'alexandra lipari': { primary: 'newsday', secondary: ['entertainmenthour'] },
  'zachary stewart': { primary: 'theatermania', secondary: ['whatsonstage'] },
  'david gordon': { primary: 'theatermania', secondary: ['whatsonstage'] },
  'mark kennedy': { primary: 'ap', secondary: ['abc-news', 'collider', 'washington-times', 'minneapolis-star-tribune',
    // BRO-6054: AP wire reprints filed under the subscriber's outlet id
    'washpost', 'sfgate', 'huffpost', 'seattle-post-intelligencer', 'news-tribune', 'npr', 'boston-com', 'abscbnnewscom'] },
  'jennifer farrar': { primary: 'ap', secondary: ['abc-news', 'minneapolis-star-tribune'] },
  'jocelyn noveck': { primary: 'ap', secondary: ['seattle-post-intelligencer'] },
  // BRO-6054: critics who repost their own review at a second outlet.
  // Mandell's New York Theater blog runs first; DC Theatre Scene and The Faster Times reprint it.
  'jonathan mandell': { primary: 'nyt-theater', secondary: ['dctheatrescene', 'faster-times'] },
  'simon jenner': { primary: 'fringereview', secondary: ['viewfromthegods'] },
  'samantha genzer': { primary: 'boston-com', secondary: ['newsbreak'] },
  'thom geier': { primary: 'thewrap', secondary: ['culturesauce'] },
  // NY1 aired a broadcast version of Cote's Time Out New York review ("Contributing critic David Cote of Time Out New York").
  'david cote': { primary: 'timeout', secondary: ['ny1'] },
};

/**
 * Returns the syndication config for a critic, or null if not a known syndicated critic.
 * @param {string} criticName - Lowercased critic name
 */
function getSyndicationConfig(criticName) {
  if (!criticName) return null;
  return KNOWN_SYNDICATION_PAIRS[criticName.toLowerCase().trim()] || null;
}

/**
 * Returns true if outletId is a secondary (syndicated copy) outlet for this critic.
 * @param {string} criticName
 * @param {string} outletId
 */
function isSecondaryOutlet(criticName, outletId) {
  const config = getSyndicationConfig(criticName);
  if (!config) return false;
  return config.secondary.includes(outletId);
}

/**
 * Publishing groups (BRO-2406): outlets under common ownership that reprint a
 * staff critic's review. Order = primacy (first = original publisher). Applies
 * to ANY critic with a real byline, not only critics hand-listed in
 * KNOWN_SYNDICATION_PAIRS — the third Chris Jones/Chicago Tribune recurrence
 * was a sibling of the same class (Tribune-group reprint) the per-critic map
 * could not anticipate.
 *
 * Observer/Guardian (BRO-6046): The Observer prints on theguardian.com, so the
 * Guardian API and web search file the Observer's weekly theatre column as
 * "guardian" while Theatre Record files the same column as "observer". The
 * observer copy holds the per-show section and is the primary; a same-critic
 * guardian copy of the same show is the reprint. Known limit: Broadway files
 * also use outletId "observer" for the New York Observer (observer.com), which
 * is not Guardian-owned. A critic who reviewed one show for both the NY
 * Observer and the Guardian would lose the guardian copy here; none existed
 * when this group was added (47 same-critic pairs checked, BRO-6046).
 */
const PUBLISHING_GROUPS = [
  ['chicagotribune', 'nydailynews', 'baltimoresun', 'hartford-courant', 'orlando-sentinel', 'south-florida-sun-sentinel'],
  ['observer', 'guardian'],
  // BRO-6054: SFGate is the San Francisco Chronicle's free site and reprints Chronicle reviews.
  ['san-francisco-chronicle', 'sfgate'],
  // BRO-6054: content partnership; the i newspaper printed theartsdesk reviews (often cut down) in 2019.
  ['artsdesk', 'i-paper'],
];

function _isRealByline(criticName) {
  const c = String(criticName || '').toLowerCase().trim();
  return !!c && !/^(unknown|staff|n\/a|none|anonymous)$/.test(c);
}

/**
 * Outlet ids that, for this critic, are the primary publisher of a review that
 * `outletId` would merely be reprinting. Empty array = outletId is not a
 * syndicated secondary. Union of the per-critic map and publishing groups.
 */
function getSyndicationPrimaries(criticName, outletId) {
  if (!_isRealByline(criticName) || !outletId) return [];
  const out = new Set();
  const cfg = getSyndicationConfig(criticName);
  if (cfg && cfg.secondary.includes(outletId)) out.add(cfg.primary);
  for (const group of PUBLISHING_GROUPS) {
    const i = group.indexOf(outletId);
    if (i > 0) group.slice(0, i).forEach(o => out.add(o));
  }
  return [...out];
}

/**
 * True when two review records are the same critic's article published at two
 * different outlets under a known syndication relationship (per-critic pair,
 * shared publishing group) or explicitly declared so by a human
 * (duplicateReason /syndicat/). Their URLs differ BY DEFINITION, so a
 * duplicateOf pointer between them must never be judged stale on URL mismatch.
 * @param {{criticName?:string,outletId?:string,duplicateReason?:string}} a record holding the pointer
 * @param {{criticName?:string,outletId?:string}} b pointer target
 * @param {(o:string)=>string} [normalize] outlet normalizer
 */
function isCrossOutletSyndicationPair(a, b, normalize = (o) => o) {
  if (!a || !b) return false;
  const oa = normalize(a.outletId || a.outlet || '');
  const ob = normalize(b.outletId || b.outlet || '');
  if (!oa || !ob || oa === ob) return false;
  const ca = String(a.criticName || '').toLowerCase().trim();
  const cb = String(b.criticName || '').toLowerCase().trim();
  if (!_isRealByline(ca) || ca !== cb) return false;
  if (/(^|[^a-z])(syndicated|reprint(ed)?|repost(ed)?)([^a-z]|$)/i.test(String(a.duplicateReason || ''))
      && !/\bnot\s+(syndicated|reprint|repost)/i.test(String(a.duplicateReason || ''))) return true;
  return getSyndicationPrimaries(ca, oa).includes(ob) || getSyndicationPrimaries(ca, ob).includes(oa);
}

/**
 * A rename-collision pair (BRO-5274): collect-review-texts renames a web-search file
 * when its criticName is overridden (variety--aramide-tinubu.json -> the real critic).
 * If the target filename already exists (an aggregator filed the same article under
 * another url form) it stamps duplicateOf + duplicateReason 'criticName-override-
 * collided-at-rename'. The write guard then cleared that pointer because the two url
 * forms differ, leaving two live copies of one article (53 key duplicates, 2026-10-13).
 * Same outlet, same real critic, same opening text = the same review: keep the pointer.
 *
 * @param {object} a the file carrying duplicateOf
 * @param {object} b the pointer target
 * @returns {boolean}
 */
function isRenameCollisionPair(a, b) {
  if (!a || !b || a.duplicateReason !== 'criticName-override-collided-at-rename') return false;
  // Same outlet, and the target must not point back (a mutual pair would loop).
  if (String(a.outletId || a.outlet || '').toLowerCase() !== String(b.outletId || b.outlet || '').toLowerCase()) return false;
  if (b.duplicateOf) return false;
  const ca = String(a.criticName || '').toLowerCase().trim();
  if (!_isRealByline(ca) || ca !== String(b.criticName || '').toLowerCase().trim()) return false;
  const head = (d) => foldDiacritics(String(d.fullText || d.text || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 240);
  const ha = head(a);
  return ha.length >= 120 && ha === head(b);
}

/** Filename slug for a critic, matching review-texts naming (punctuation -> '-'). */
function criticFileSlug(criticName) {
  return foldDiacritics(String(criticName || '')).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * True when `fileName` is a primary-outlet file for this critic:
 * `<primary>--<criticSlug>.json` (optionally `-<n>` collision suffix). Anchored,
 * so `rob-weinert` never matches `rob-weinert-kendt`.
 */
function isPrimaryFileFor(fileName, primaries, criticName) {
  const slug = criticFileSlug(criticName);
  if (!slug) return false;
  return primaries.some(p => fileName === `${p}--${slug}.json` || new RegExp(`^${p}--${slug}-\\d+\\.json$`).test(fileName));
}

/**
 * A primary only shields its secondary if the primary will itself be scored.
 * Otherwise (crossOutletDuplicate, isNonReview, invalid tier, ...) BOTH copies
 * would be dropped and the critic's review vanishes from reviews.json.
 */
function isLiveSyndicationPrimary(d) {
  if (!d) return false;
  // BRO-5245: a wrongShow file a person cleared in the rebuild gate ships, so it can be a primary.
  const { wrongShowExplicitlyCleared } = require('./review-guards');
  const wrongShowActive = d.wrongShow && !wrongShowExplicitlyCleared(d);
  return !(d.wrongProduction || wrongShowActive || d.crossOutletDuplicate || d.isSyndicatedDuplicate
    || d.isNonReview || d.nonReviewFlag || d.nonReviewContent || d.duplicateOf
    || d.contentTier === 'invalid');
}

/**
 * True when showDir holds a live primary file for this critic (the sibling
 * scan every syndication-dedup site repeats, BRO-5352). Callers compute
 * `primaries` themselves (getSyndicationPrimaries) so each keeps its own outlet
 * normalisation. `fileNames` reuses a listing the caller already has;
 * otherwise showDir is read, and an unreadable dir throws (callers decide).
 * `extraCheck(parsedPrimary, fullPath)` adds a caller-specific condition.
 * The match is by filename, so a primary file whose own byline names a
 * different critic (a misnamed file, e.g. observer--jesse-green.json holding
 * David Cote) never shields (BRO-6046).
 */
function hasLiveSyndicationPrimary(showDir, primaries, criticName, { fileNames, extraCheck } = {}) {
  const fs = require('fs');
  const path = require('path');
  const names = fileNames || fs.readdirSync(showDir);
  return names.some((f) => {
    if (!isPrimaryFileFor(f, primaries, criticName)) return false;
    try {
      const pPath = path.join(showDir, f);
      const p = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      if (p.criticName && criticFileSlug(p.criticName) !== criticFileSlug(criticName)) return false;
      return isLiveSyndicationPrimary(p) && (!extraCheck || !!extraCheck(p, pPath));
    } catch { return false; }
  });
}

module.exports = {
  criticFileSlug, isPrimaryFileFor, isLiveSyndicationPrimary, hasLiveSyndicationPrimary,
  KNOWN_SYNDICATION_PAIRS, PUBLISHING_GROUPS, getSyndicationConfig, isSecondaryOutlet,
  getSyndicationPrimaries, isCrossOutletSyndicationPair, isRenameCollisionPair,
};
