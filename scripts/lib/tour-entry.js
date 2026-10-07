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

const { tourInheritance, toursOfTitle, tourImageProblems } = require('./tour-family');
const { distinctWorksOfTitle } = require('./tour-history');

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

/** Parent id without its year: beetlejuice-2019 -> beetlejuice. */
function baseSlug(parentId) {
  return String(parentId || '').replace(/-\d{4}$/, '');
}

/**
 * @param {object} args
 * @param {object} args.parent Broadway show the roundup matched
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
function buildTourEntry({ parent, shows, decision, roundupUrl, scheduleUrl, retiredIds = null, knownEnds = null, now = new Date() }) {
  if (!parent || (parent.category || 'broadway') !== 'broadway') return { skip: 'parent is not a Broadway show' };
  // Two different works share the title (A Christmas Carol: Jack Thorne's
  // play and the Dickens solo shows): the title alone can't say which one
  // tours, and a wrong parent hands the tour the wrong cast and images.
  // Only works of the parent's kind compete: the Frozen musical is not mistaken
  // for the 2004 play (BRO-4724 ship-check).
  const works = distinctWorksOfTitle(parent.title, shows, parent.type);
  if (works.length > 1) return { skip: `"${parent.title}" names ${works.length} different Broadway works (${works.map(g => g.join('+')).join(' / ')}); which one tours is not clear` };
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
  const earlier = toursOfTitle(parent.title, shows);
  const endOf = t => t.closingDate || (knownEnds && knownEnds[t.id]) || null;
  const stillOpen = earlier.find(t => !endOf(t) || endOf(t) >= launch);
  if (stillOpen) return { skip: `tour ${stillOpen.id} is still open or overlaps ${launch}` };

  const id = `${baseSlug(parent.id)}-tour-${launch.slice(0, 4)}`;
  if ((shows || []).some(s => s.id === id || s.slug === id)) return { skip: `id ${id} already exists` };
  if (retiredIds && retiredIds.has(id)) return { skip: `id ${id} is retired` };

  const close = decision.write.closingDate || null;
  const entry = {
    id,
    title: parent.title,
    slug: id,
    venue: 'North American Tour',
    openingDate: launch,
    closingDate: close,
    status: upcoming ? 'upcoming' : close && close < today ? 'closed' : 'open',
    type: parent.type || 'musical',
    isRevival: false,
    category: 'tour',
    market: 'tour',
    tourOf: parent.id,
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
  Object.assign(entry, tourInheritance(entry, parent, shows) || {});
  const imageProblems = tourImageProblems(entry, shows);
  if (imageProblems.length) return { skip: `images: ${imageProblems.join('; ')}` };
  return { entry };
}

module.exports = { buildTourEntry, baseSlug, scheduleSlugOf, LAUNCH_SOURCES };
