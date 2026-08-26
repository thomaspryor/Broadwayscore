/**
 * enrich-todaytix-press-nights.js
 *
 * BRO-626: West End shows whose openingDate is still collapsed onto
 * previewsStartDate with openingDateSource 'todaytix' — TodayTix only records
 * first performance, not press night, so the two dates being equal is a
 * known-bug signature, not a real "no preview period" show.
 *
 * enrich-west-end-dates.js --fix-unconfirmed already runs on a cron and
 * corrects most of this class via Theatremonkey/Playbill scraping plus
 * scripts/lib/infer-press-night-from-reviews.js's review-cluster inference —
 * that's why most of the 25 shows named in the original BRO-626 ticket
 * (2026-03-31) already show openingDateSource: 'inferred-from-reviews' or
 * 'theatremonkey' by the time this script runs (verified: 19 remained
 * collapsed as of 2026-08-21, 16 of which were actually researched — the
 * other 3 (dirty-dancing-the-classic-story-on-stage-west-end-2026,
 * bill-bailey-vaudevillean-west-end-2026, the-snowman-west-end-2026) hadn't
 * opened yet at research time, so there was no press night to look up; they
 * fall through to the generic not-yet-opened reason below). This module
 * handles that residual cohort: shows too small/obscure for Theatremonkey to
 * list, plus one blind spot in
 * the review-inference heuristic worth noting here — that heuristic only
 * looks at review publish dates AFTER the stored openingDate (it assumes
 * TodayTix's date is too EARLY). The Hunger Games On Stage is the opposite
 * case in this cohort: the stored date (2025-11-28) is LATER than the real
 * press night (2025-11-12), with the review cluster arriving before the
 * stored date, so the shared heuristic silently skips it. Rather than widen
 * that shared heuristic on a single instance, this module carries a
 * manually-verified corrections map (each entry backed by a citable source
 * gathered for BRO-626) and applies it directly.
 *
 * Never fabricates a date: a collapsed show with no reliable independent
 * source, or one where research surfaced a DIFFERENT unresolved data problem
 * (see im-every-woman-the-chaka-khan-musical-west-end-2026 below — wrong
 * venue, not just a wrong date), stays untouched and is reported as
 * unresolved with a reason, not silently skipped.
 */

'use strict';

/**
 * @param {Array<object>} shows - shows.json `.shows` array
 * @returns {Array<object>} WE/OWE shows with openingDate === previewsStartDate
 *   and openingDateSource === 'todaytix'
 */
function findTodaytixCollapsedShows(shows) {
  if (!Array.isArray(shows)) return [];
  return shows.filter((s) =>
    (s.category === 'west-end' || s.category === 'off-west-end') &&
    s.openingDateSource === 'todaytix' &&
    !!s.openingDate &&
    !!s.previewsStartDate &&
    s.openingDate === s.previewsStartDate
  );
}

// Manually verified corrections and confirmations for the BRO-626 residual
// cohort (shows not covered by Theatremonkey/Playbill and too sparse for the
// review-cluster heuristic). Gathered 2026-08-21 by cross-referencing
// production announcements, independent review outlets, and (where
// available) this repo's own reviews.json publish-date cluster.
//
// `pressNight` is only present when the real value differs from the stored
// todaytix date — those are corrections. `confirmOnly: true` entries mean
// independent sources corroborate the stored date; no date change, only the
// source label is upgraded (todaytix -> manual, so the show is no longer
// treated as unconfirmed / untrusted-for-pre-open-polling).
const VERIFIED_PRESS_NIGHTS = {
  'the-hunger-games-on-stage-west-end-2025': {
    pressNight: '2025-11-12',
    previewsStartDate: '2025-10-20',
    confidence: 'high',
    citation: 'Wikipedia (The Hunger Games: On Stage) + theatrevibe.co.uk "Reviewed ... on 12th November 2025": previews from 20 Oct 2025, press night 12 Nov 2025 — corroborated by an 18-outlet review cluster on 2025-11-12/11-13 in reviews.json',
  },
  'anansi-the-spider-west-end-2026': {
    pressNight: '2026-08-18',
    previewsStartDate: '2026-08-15',
    confidence: 'high',
    citation: 'LondonBoxOffice.co.uk: "press performance on Tuesday 18 August, 2pm" — corroborated by review cluster on 2026-08-18/08-19 in reviews.json',
  },
  'i-was-a-teenage-shedevil-west-end-2026': {
    pressNight: '2026-04-08',
    previewsStartDate: '2026-04-02',
    confidence: 'medium-high',
    citation: 'thespyinthestalls.com: "Reviewed on 8th April 2026" — corroborated by a review cluster 2026-04-09/04-10',
  },
  'the-karate-kid-the-musical-west-end-2026': {
    pressNight: '2026-04-30',
    previewsStartDate: '2026-04-28',
    confidence: 'medium',
    citation: 'theatreexpress.co.uk VIP-exclusive (gala/press) booking listed for Thu 30 Apr 2026 7:30pm; BroadwayWorld production photos published 2026-05-01 (day-after-press-night pattern); no source uses the literal words "press night"',
  },
  'garry-starr-classic-penguins-garrick-west-end-2026': {
    pressNight: '2026-02-01',
    previewsStartDate: '2026-02-01',
    confidence: 'high',
    note: 'confidence is for the corrected DATE only — no press night exists for this format at all (see citation)',
    citation: 'BroadwayWorld + theatrevibe.co.uk: this was a 4-date novelty transfer (Sundays 1/8/15/22 Feb 2026) tied to a Guinness World Record attempt — the stored 2026-01-01 does not match ANY actual performance date. No distinct press night was held; 2026-02-01 (first actual performance) replaces a flatly wrong date rather than supplying a press night that does not exist.',
  },
  'murder-she-didnt-write-west-end-2025': {
    confirmOnly: true,
    confidence: 'high',
    citation: 'londontheatre1.com explicitly names the reviewed performance "press night" and thereviewshub.com: "Reviewed on 24 March 2025" — both match the stored date',
  },
  'black-is-the-color-of-my-voice-west-end-2026': {
    confirmOnly: true,
    confidence: 'medium',
    citation: 'westendwilma.com review (published 13 Jan 2026) implies the reviewed performance was Monday 12 Jan 2026 — matches stored date; no source uses the literal words "press night"',
  },
  'broken-glass-west-end-2026': {
    confirmOnly: true,
    confidence: 'high',
    citation: 'ATV Today + BroadwayWorld: "opening night on 3 March" — matches stored date; corroborated by review cluster from 2026-03-04',
  },
  'the-guy-who-didnt-like-musicals-west-end-2026': {
    confirmOnly: true,
    confidence: 'high',
    citation: 'WhatsOnStage press-night review (published 18 May, describing the prior Thursday-evening press night) — 14 May 2026 is a Thursday, matches stored date',
  },
};

/**
 * Shows researched for BRO-626 where NO date change was warranted, but the
 * reason is worth recording explicitly (surfaced a different bug, or the
 * source material genuinely doesn't distinguish a press night from the
 * recorded date) rather than lumping in with generic "no source found".
 */
const KNOWN_UNRESOLVED_REASONS = {
  'im-every-woman-the-chaka-khan-musical-west-end-2026':
    'DIFFERENT BUG FOUND, NOT A DATE FIX: the announced Peacock Theatre run (opening 11 Mar 2026) was cancelled due to building works; production relocated to Hackney Empire for a shortened 20-25 Mar 2026 run. shows.json venue field ("Peacock Theatre") is wrong for this run — that is the higher-priority fix. No press night was publicized for the relocated run, so openingDate is left untouched here.',
  'the-enormous-crocodile-west-end-2026':
    'Confirmed NOT a wrong-reviews bug: this is one continuous touring production (Leeds Playhouse 2023 -> Regent\'s Park 2024/2025 -> Lyric Hammersmith 2026); family/children\'s touring shows do not get a fresh press night at every tour stop, so the 2023/2024 reviews already in reviews.json are genuinely this production\'s, not a mismatch. No distinct Lyric Hammersmith press night exists to substitute.',
  'austentatious-an-improvised-jane-austen-novel-west-end-2025':
    'Weekly improv residency with no traditional press-night cycle; all reviews found are from months after the recorded date, none contradicting it. Left unchanged per the exception the ticket itself calls out.',
  'as-you-like-it-globe-west-end-2026':
    'Run began 2026-08-14 (7 days before this research, 2026-08-21); no review of the 2026 production is indexed anywhere yet. Revisit once reviews land.',
  'alice-in-wonderland-west-end-2026':
    'This title had three separate Riverside Studios engagements in 2025-2026; every indexed review belongs to one of the OTHER two runs, none to this 27 Mar - 12 Apr 2026 run specifically. No date substituted from an unrelated run.',
  'midnight-in-the-toyshop-west-end-2026': 'No professional critic reviews indexed for this 6-day Easter engagement.',
  'the-boy-at-the-back-of-the-class-west-end-2026': 'No review indexed for this specific tour stop (Southbank Centre, 7-12 Apr 2026); all found reviews are for other tour venues/dates.',
};

/**
 * Compute the shows.json field changes for the verified cohort.
 *
 * @param {Array<object>} shows - shows.json `.shows` array
 * @param {object} [verified] - defaults to VERIFIED_PRESS_NIGHTS (injectable for tests)
 * @param {string} [sourceLabel] - openingDateSource value to stamp on applied changes
 * @returns {{applied: Array<object>, unresolved: Array<object>}}
 *   applied: shows with a computed changes[] (correction or source-only confirmation)
 *   unresolved: collapsed shows with no entry in `verified` — left untouched,
 *     reported with a reason so nothing silently vanishes.
 */
function computeTodaytixPressNightChanges(shows, verified = VERIFIED_PRESS_NIGHTS, sourceLabel = 'manual:bro-626-2026-08-21') {
  const collapsed = findTodaytixCollapsedShows(shows);
  const applied = [];
  const unresolved = [];

  for (const show of collapsed) {
    const v = verified[show.id];
    if (!v) {
      unresolved.push({
        id: show.id,
        title: show.title,
        reason: KNOWN_UNRESOLVED_REASONS[show.id] || (
          show.status === 'upcoming' || show.status === 'announced'
            ? 'not-yet-opened — todaytix first-performance date is the best available estimate'
            : 'no-reliable-independent-source-found'
        ),
      });
      continue;
    }

    const changes = [];
    if (v.confirmOnly) {
      changes.push({ field: 'openingDateSource', old: show.openingDateSource, new: sourceLabel });
    } else {
      changes.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: v.previewsStartDate });
      changes.push({ field: 'openingDate', old: show.openingDate, new: v.pressNight });
      changes.push({ field: 'openingDateSource', old: show.openingDateSource, new: sourceLabel });
    }

    applied.push({ id: show.id, title: show.title, slug: show.slug, confidence: v.confidence, citation: v.citation, changes });
  }

  return { applied, unresolved };
}

module.exports = {
  findTodaytixCollapsedShows,
  computeTodaytixPressNightChanges,
  VERIFIED_PRESS_NIGHTS,
  KNOWN_UNRESOLVED_REASONS,
};
