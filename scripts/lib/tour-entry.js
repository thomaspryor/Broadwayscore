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

// How a tour's launch was confirmed (decideTourDates launchSource) and what
// the entry records for it. One row per source so a new source cannot fall
// through to another's label (BRO-4601: a ternary called everything not a
// roundup "Wikipedia").
const LAUNCH_SOURCES = {
  wikipedia: { evidence: 'launch confirmed by Wikipedia', openingDateSource: 'tourstoyou+wikipedia', closingDateSource: 'tourstoyou+wikipedia' },
  'bww-roundup': { evidence: 'launch confirmed by BroadwayWorld roundup', openingDateSource: 'tourstoyou+bww-roundup', closingDateSource: 'tourstoyou' },
  'tourstoyou-fresh': { evidence: 'launch is the first listed engagement of a tour launching now', openingDateSource: 'tourstoyou-first-engagement', closingDateSource: 'tourstoyou' },
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
 * @param {Date} [args.now]
 * @returns {{entry: object} | {skip: string}}
 */
function buildTourEntry({ parent, shows, decision, roundupUrl, scheduleUrl, retiredIds = null, now = new Date() }) {
  if (!parent || (parent.category || 'broadway') !== 'broadway') return { skip: 'parent is not a Broadway show' };
  if (!roundupUrl && !scheduleUrl) return { skip: 'no evidence URL (roundup or schedule)' };
  if (!decision || decision.problem) return { skip: `dates: ${(decision && decision.problem) || 'no decision'}` };
  const launch = decision.write && decision.write.openingDate;
  if (!launch) return { skip: 'no launch date confirmed (by Wikipedia, a BWW roundup, or a fresh Tours To You launch)' };
  const source = LAUNCH_SOURCES[decision.launchSource] || LAUNCH_SOURCES.wikipedia;
  const today = now.toISOString().slice(0, 10);
  if (launch > today) return { skip: `launch ${launch} is in the future` };

  // A second tour must start after every earlier tour of the title has closed.
  const earlier = toursOfTitle(parent.title, shows);
  const stillOpen = earlier.find(t => !t.closingDate || t.closingDate >= launch);
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
    status: close && close < today ? 'closed' : 'open',
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
      : { discoverySource: 'tour-schedule:tourstoyou', tourLaunchEvidence: `Tours To You schedule ${scheduleUrl}, ${source.evidence}` }),
    statusSource: `auto-created ${today} (BRO-4262): ${scheduleUrl || 'Tours To You'}, ${source.evidence}; ${decision.notes.join('; ')}`,
    openingDateSource: source.openingDateSource,
    // The page the dates came from: numbered pages (the-book-of-mormon-1) are
    // other tours, so the daily date job must not guess from the title.
    ...(scheduleSlugOf(scheduleUrl) ? { tourScheduleSlug: scheduleSlugOf(scheduleUrl) } : {}),
    ...(close ? { closingDateSource: source.closingDateSource, closingDateUpdatedAt: today } : {}),
    images: { hero: null, thumbnail: null, poster: null },
  };
  Object.assign(entry, tourInheritance(entry, parent) || {});
  const imageProblems = tourImageProblems(entry, shows);
  if (imageProblems.length) return { skip: `images: ${imageProblems.join('; ')}` };
  return { entry };
}

module.exports = { buildTourEntry, baseSlug, scheduleSlugOf, LAUNCH_SOURCES };
