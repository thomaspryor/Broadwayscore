'use strict';

/**
 * Build a shows.json entry for a newly found national tour (BRO-4262).
 * Pure: the caller fetches the schedule and Wikipedia text and decides dates
 * with tour-schedule.js decideTourDates; this only shapes the entry and says
 * no when the evidence is short.
 *
 * Shape matches the hand-built tours (life-of-pi-tour-2024): provisional,
 * discoverySource 'aggregator-roundup:bww-tour-roundup' (validate-show-venue's
 * tour roundup exemption), the roundup as tourLaunchEvidence. A tour found
 * running on Tours To You (BRO-4325) has no roundup: 'tour-schedule:tourstoyou'
 * and the schedule page as evidence.
 */

const { tourInheritance, toursOfTitle, tourImageProblems, productionsOfTitle, tourParentCategory } = require('./tour-family');
const { distinctWorksOfTitle } = require('./tour-history');
const { foldDiacritics } = require('./title-match');

// A standalone tour (no parent) must say what it is: the type decides which
// shows it can be confused with and how the page describes it.
const STANDALONE_TYPES = ['musical', 'play', 'special', 'opera'];

// How a tour's launch was confirmed (decideTourDates launchSource) and what
// the entry records for it. One row per source so a new source cannot fall
// through to another's label (BRO-4601: a ternary called everything not a
// roundup "Wikipedia").
const LAUNCH_SOURCES = {
  wikipedia: { evidence: 'launch confirmed by Wikipedia', openingDateSource: 'tourstoyou+wikipedia', closingDateSource: 'tourstoyou+wikipedia' },
  'bww-roundup': { evidence: 'launch confirmed by BroadwayWorld roundup', openingDateSource: 'tourstoyou+bww-roundup', closingDateSource: 'tourstoyou' },
  'tourstoyou-fresh': { evidence: 'launch is the first listed engagement of a tour launching now', openingDateSource: 'tourstoyou-first-engagement', closingDateSource: 'tourstoyou' },
  // Found before it opens (tour-discovery.js upcomingSegments): created
  // 'upcoming', opened on its date by update-show-status.js.
  'tourstoyou-upcoming': { evidence: 'launch is the first listed engagement of a tour booked ahead', openingDateSource: 'tourstoyou-first-engagement', closingDateSource: 'tourstoyou' },
  // A current-era launch checked by hand against two sources (BRO-4601):
  // long-running tours whose Tours To You page keeps only recent rows.
  'hand-verified': { evidence: 'current-era launch verified by hand', openingDateSource: 'hand-verified', closingDateSource: 'hand-verified' },
};

/** The Tours To You slug in a schedule URL, or null. */
function scheduleSlugOf(url) {
  const m = String(url || '').match(/tourstoyou\.org\/shows\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

// The market a parent id may carry before its year: mexodus-off-broadway-2026,
// mystic-pizza-regional-2025. A tour id never does (add-show-action.js and
// validate-data.js refuse it), and review-guards.js isLikelyTourReview keys on
// the plain <base>-tour-<year> shape.
const MARKET_TOKEN_RE = /^(.+?)-(?:on-broadway|off-broadway|off-west-end|west-end|regional)$/;

/** Parent id without its year or market: beetlejuice-2019 -> beetlejuice, mexodus-off-broadway-2026 -> mexodus. */
function baseSlug(parentId) {
  const noYear = String(parentId || '').replace(/-\d{4}$/, '');
  const m = MARKET_TOKEN_RE.exec(noYear);
  return m ? m[1] : noYear;
}

/** Kebab-case of a title, for a standalone tour that has no parent id to start from. */
function titleSlug(title) {
  return foldDiacritics(String(title || '')).toLowerCase()
    .replace(/&/g, 'and').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * @param {object} args
 * @param {object|null} args.parent production the tour descends from (any TOUR_PARENT_CATEGORIES category),
 *   or null for a standalone tour (BRO-4931), which also needs title, type and a Tours To You scheduleUrl
 * @param {string} [args.title] standalone tour only
 * @param {string} [args.type] standalone tour only (musical, play, special, opera)
 * @param {boolean} [args.allowStandaloneOverExisting] a standalone tour is refused when a same-title
 *   non-tour production exists (it is probably that production's tour); set only when a person decided it is not
 * @param {Array} args.shows all shows (collision and sibling-tour checks)
 * @param {{write:{openingDate?,closingDate?}, notes:string[], problem?:string}} args.decision decideTourDates result for a blank tour
 * @param {string} [args.roundupUrl] BWW national-tour roundup (none for a tour found running on Tours To You)
 * @param {string} [args.scheduleUrl] Tours To You page used
 * @param {Set<string>} [args.retiredIds] ids from data/retired-show-ids.json
 * @param {Object<string,string>} [args.knownEnds] running tours' last engagement, by id, where
 *   the schedule page shows them ending before this one (tour-discovery.js lifecyclePlan)
 * @param {Date} [args.now]
 * @returns {{entry: object} | {skip: string}}
 */
function buildTourEntry({ parent = null, title: standaloneTitle = null, type: standaloneType = null, allowStandaloneOverExisting = false, shows, decision, roundupUrl, scheduleUrl, retiredIds = null, knownEnds = null, now = new Date() }) {
  let title;
  let type;
  if (parent) {
    if (!tourParentCategory(parent)) return { skip: `parent ${parent.id} is category ${parent.category}, not a production a tour can descend from` };
    title = parent.title;
    type = parent.type || 'musical';
    // Two different works share the title (A Christmas Carol: Jack Thorne's
    // play and the Dickens solo shows): the title alone can't say which one
    // tours, and a wrong parent hands the tour the wrong cast and images.
    // Only works of the parent's kind compete: the Frozen musical is not mistaken
    // for the 2004 play (BRO-4724 ship-check).
    const works = distinctWorksOfTitle(parent.title, shows, parent.type);
    if (works.length > 1) return { skip: `"${parent.title}" names ${works.length} different Broadway works (${works.map(g => g.join('+')).join(' / ')}); which one tours is not clear` };
  } else {
    // A standalone tour (BRO-4931): no tracked production to inherit from, so
    // the caller must name it, and the schedule page is its only anchor.
    title = String(standaloneTitle || '').trim();
    if (!title) return { skip: 'standalone tour needs a title' };
    if (!STANDALONE_TYPES.includes(standaloneType)) return { skip: `standalone tour needs a known type (${STANDALONE_TYPES.join(', ')}), got ${standaloneType}` };
    type = standaloneType;
    if (!scheduleSlugOf(scheduleUrl)) return { skip: 'standalone tour needs a Tours To You schedule URL (its tourScheduleSlug)' };
    const same = productionsOfTitle(title, shows);
    if (same.length && !allowStandaloneOverExisting) return { skip: `"${title}" already has non-tour production(s) (${same.map(s => s.id).slice(0, 3).join(', ')}); the tour probably descends from one of them` };
  }
  if (!roundupUrl && !scheduleUrl) return { skip: 'no evidence URL (roundup or schedule)' };
  if (!decision || decision.problem) return { skip: `dates: ${(decision && decision.problem) || 'no decision'}` };
  const launch = decision.write && decision.write.openingDate;
  if (!launch) return { skip: 'no launch date confirmed (by Wikipedia, a BWW roundup, or a fresh Tours To You launch)' };
  // An unknown source never borrows another's label (the Wikipedia one carries
  // validate-show-venue's two-source exemption).
  const source = LAUNCH_SOURCES[decision.launchSource];
  if (!source) return { skip: `unknown launch source ${decision.launchSource}` };
  if (decision.launchSource === 'hand-verified' && !((decision.evidenceUrls || []).length >= 2)) return { skip: 'hand-verified launch needs two source URLs' };
  const today = now.toISOString().slice(0, 10);
  // A launch still ahead makes an 'upcoming' tour, opened on its date by
  // update-show-status.js like any other show (it used to be refused, so a
  // tour arrived only after it opened).
  const upcoming = launch > today;

  // A second tour must start after every earlier tour of the title has
  // closed, or is shown by its schedule ending first (a tour booked after a
  // layoff, BRO-4724).
  const earlier = toursOfTitle(title, shows);
  const endOf = t => t.closingDate || (knownEnds && knownEnds[t.id]) || null;
  const stillOpen = earlier.find(t => !endOf(t) || endOf(t) >= launch);
  if (stillOpen) return { skip: `tour ${stillOpen.id} is still open or overlaps ${launch}` };

  const id = `${parent ? baseSlug(parent.id) : titleSlug(title)}-tour-${launch.slice(0, 4)}`;
  if ((shows || []).some(s => s.id === id || s.slug === id)) return { skip: `id ${id} already exists` };
  if (retiredIds && retiredIds.has(id)) return { skip: `id ${id} is retired` };

  const close = decision.write.closingDate || null;
  const entry = {
    id,
    title,
    slug: id,
    venue: 'North American Tour',
    openingDate: launch,
    closingDate: close,
    status: upcoming ? 'upcoming' : close && close < today ? 'closed' : 'open',
    type,
    isRevival: false,
    category: 'tour',
    market: 'tour',
    // A standalone tour omits tourOf (never null): validators read an absent field as 'no parent'.
    ...(parent ? { tourOf: parent.id } : {}),
    tags: ['tour'],
    provisional: true,
    ...(roundupUrl
      ? { discoverySource: 'aggregator-roundup:bww-tour-roundup', tourLaunchEvidence: `BroadwayWorld national-tour roundup ${roundupUrl}` }
      // Found running on Tours To You (tour-discovery.js, BRO-4325).
      : { discoverySource: 'tour-schedule:tourstoyou', tourLaunchEvidence: `Tours To You schedule ${scheduleUrl}, ${source.evidence}${decision.evidenceUrls && decision.evidenceUrls.length ? `: ${decision.evidenceUrls.join(' ; ')}` : ''}` }),
    statusSource: `auto-created ${today} (BRO-4262): ${scheduleUrl || 'Tours To You'}, ${source.evidence}; ${decision.notes.join('; ')}`,
    openingDateSource: source.openingDateSource,
    // The page the dates came from: numbered pages (the-book-of-mormon-1) are
    // other tours, so the daily date job must not guess from the title.
    ...(scheduleSlugOf(scheduleUrl) ? { tourScheduleSlug: scheduleSlugOf(scheduleUrl) } : {}),
    ...(close ? { closingDateSource: source.closingDateSource, closingDateUpdatedAt: today } : {}),
    images: { hero: null, thumbnail: null, poster: null },
  };
  if (parent) Object.assign(entry, tourInheritance(entry, parent, shows) || {});
  const imageProblems = tourImageProblems(entry, shows);
  if (imageProblems.length) return { skip: `images: ${imageProblems.join('; ')}` };
  return { entry };
}

module.exports = { buildTourEntry, baseSlug, titleSlug, STANDALONE_TYPES, scheduleSlugOf, LAUNCH_SOURCES };
