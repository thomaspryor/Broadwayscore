'use strict';

/**
 * One tour candidate -> create or stay a suggestion (BRO-4262, BRO-4931).
 * The evidence rules create-tour-entries.js applies to every candidate, pulled
 * out so check-tour-sweep.js can run exactly the same decision without
 * writing anything (CLAUDE.md section 15: tests and checks call the real
 * function). Pure: the caller fetched the schedule page and the Wikipedia text.
 *
 * Evidence rules, unchanged: decideTourDates (Wikipedia, a BWW roundup, a
 * launch within FRESH_LAUNCH_DAYS or booked within UPCOMING_DAYS), no copy of
 * another tour's table (duplicateScheduleOf), at least MIN_TOUR_STOPS
 * engagements (tooFewStops), no earlier tour of the title still open
 * (buildTourEntry). Since BRO-4931 the parent may be in any market or absent
 * (a standalone tour, which also needs title, type and an anchor page).
 */

const { decideTourDates, duplicateScheduleOf, tooFewStops, parseTourSchedule } = require('./tour-schedule');
const { buildTourEntry } = require('./tour-entry');
const { roundupDateFromSlug } = require('./tour-roundup-candidate');
const { classifyTourPage, PRODUCTION_TYPES } = require('./tour-page-class');
const { UPCOMING_DAYS, roundupRowFor } = require('./tour-discovery');

// A Tours To You tour whose first engagement is this close to today is
// launching now, so that engagement is its launch (decideTourDates option).
// 30, not 60: Harry Potter's page starts at Seattle on Aug 22 (43 days before
// this was written) though the tour opened in Denver in May; a wider window
// would have created it with that date (BRO-4601 report run).
const FRESH_LAUNCH_DAYS = 30;

/** The BWW roundup that backs a candidate, or null: its own, or one paired by title (BRO-4931). */
function candidateRoundupUrl(candidate, ledgerRows = []) {
  if (candidate.source !== 'tourstoyou') return candidate.url;
  if (candidate.roundupUrl) return candidate.roundupUrl;
  const paired = roundupRowFor(candidate, ledgerRows);
  return paired ? paired.roundupUrl : null;
}

/**
 * Outcome classes, also what check-tour-sweep.js compares:
 *   create | suggest | skip-too-few-stops | skip-duplicate-schedule | needs-classification
 * (skip-event / -aggregator / -template / -company / -nothing-running come
 * from the page, before a candidate exists: tour-discovery.js runningTourCandidate.)
 */
function decideTourCreation({
  candidate: c, parent = null, shows, scheduleUrl, html, wikiText = '', roundupUrl = null,
  retiredIds = null, tourSchedules = {}, now = new Date(), overrides = {}, allowStandaloneOverExisting = false,
}) {
  let cand = c;
  // A page discovery could not classify gets Wikipedia's infobox now (step 7 of
  // tour-page-class.js). Still unclassified: it stays a candidate, never created.
  if (!parent && c.needsClassification) {
    const cls = classifyTourPage({ slug: c.tourScheduleSlug, pageTitle: c.title, rows: parseTourSchedule(html), shows, overrides, wikiText });
    if (cls.class !== 'production') {
      return { outcome: cls.class === 'unclassified' ? 'needs-classification' : `skip-${cls.class}`, reason: cls.reason, pageClass: cls, decision: null, built: { skip: cls.reason } };
    }
    cand = { ...c, pageClass: 'production', type: cls.type };
    delete cand.needsClassification;
  }
  const title = parent ? parent.title : cand.title;
  const probe = { id: null, title, tourScheduleSlug: cand.tourScheduleSlug, openingDate: null, closingDate: null };
  const found = cand.source === 'tourstoyou';
  // Only the publication date in the slug: when the job first saw a roundup
  // says nothing about when the tour launched (a backfilled old roundup).
  const roundupDate = roundupUrl ? roundupDateFromSlug(roundupUrl) : null;
  const decision = scheduleUrl
    // splitAt: where discovery cut the page because a closed tour's rows
    // are followed by a new tour's (BRO-4724).
    ? decideTourDates(probe, html, wikiText, now, found ? { segmentStart: cand.segmentStart, roundupDate, freshLaunchDays: FRESH_LAUNCH_DAYS, upcomingDays: UPCOMING_DAYS, cuts: cand.splitAt } : { seenAt: cand.firstSeen || cand.lastSeen, roundupDate })
    : { write: {}, notes: [], problem: 'no Tours To You page found for this title' };
  let kind = null;
  // A page can carry another show's table (the Come From Away page showed
  // Operation Mincemeat's 2026 tour, BRO-4601): never create a tour whose
  // engagements are another tour's.
  const copyOf = !decision.problem && duplicateScheduleOf(decision.segmentRows, tourSchedules);
  if (copyOf) { decision.problem = `schedule duplicates ${copyOf}'s engagements (wrong table on the Tours To You page?)`; kind = 'skip-duplicate-schedule'; }
  if (!decision.problem && tooFewStops(decision.segmentRows)) { decision.problem = `only ${decision.segmentRows.length} engagements: a regional co-production or a limited run, not a national tour`; kind = 'skip-too-few-stops'; }
  const knownEnds = found ? (cand.predecessorEnds || null) : null;
  const standalone = parent ? {} : { title: cand.title, type: PRODUCTION_TYPES.includes(cand.type) ? cand.type : null };
  const built = buildTourEntry({ parent, ...standalone, allowStandaloneOverExisting, shows, decision, roundupUrl, scheduleUrl, retiredIds, knownEnds, now });
  return {
    outcome: built.entry ? 'create' : (kind || 'suggest'),
    reason: built.skip || '',
    decision, built, knownEnds, candidate: cand,
  };
}

module.exports = { FRESH_LAUNCH_DAYS, candidateRoundupUrl, decideTourCreation };
