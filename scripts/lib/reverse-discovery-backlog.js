'use strict';
/**
 * Age-ranked view of the reverse-discovery missing-show backlog.
 *
 * THE INCIDENT (Rhinoceros at A.R.T., 2026-08-24 → 2026-09-06): the detector
 * caught the show on DAY ONE — `bww-roundup:rhinoceros at american repertory
 * theater` was written to reverse-discovery-state.json on 2026-08-24 — and it
 * still took 12 days and a code fix to reach the catalogue. The detector was
 * never the problem. The escalation was: reverseDiscoveryBacklogResults()
 * always reported `status: 'warn'` and always named `candidates[0]`, so the
 * digest line read identically on day 1 and day 12 and never got loud enough
 * to prompt anyone to open the JSON.
 *
 * That is the SAME failure obClosingBacklogResults was fixed for ("Are You Now
 * or Have You Ever Been" sat 5 consecutive weekly runs behind candidates[0]);
 * the remedy there — rank by age, name the OLDEST, escalate once a warn line
 * has demonstrably failed — was simply never applied here. This is that remedy.
 *
 * STALE-REPORT HAZARD: the candidates report is regenerated every 6h, so it
 * can name a show that has since been added — "Game of Thrones: The Mad King"
 * was still listed on 2026-09-10 despite already being catalogued as
 * game-of-thrones-the-mad-king-regional-2026. Escalating that to 'error'
 * would be a false alarm, and a false alarm at error severity is exactly what
 * teaches people to ignore this row. Callers therefore pass `isStillMissing`,
 * built from the detector's OWN matcher (buildShowTitleIndex +
 * resolveMatchedShowId), so the escalation re-confirms against live
 * shows.json rather than trusting a file that may be hours old.
 *
 * EVIDENCE-ANCHORED vs CALENDAR sources is the load-bearing distinction. A
 * roundup source (WET / BWW / Playbill) only publishes once critics have
 * reviewed, so an unmatched roundup means "a reviewed show is missing" — the
 * owner's rule, and worth escalating. nyt-theater is an openings CALENDAR
 * (audit-reverse-discovery.js's own header says it is "not evidence-
 * anchored"): those entries routinely have no reviews yet, so escalating them
 * would train everyone to ignore the row — the precise way this channel
 * failed the first time.
 */

const { candidateKey } = require('./reverse-discovery');

/**
 * Sources whose presence PROVES critics have published. Shared with
 * audit-reverse-discovery.js so the two can never drift apart.
 */
const EVIDENCE_SOURCES = new Set(['wet-roundup', 'bww-roundup', 'playbill-roundup']);

/**
 * Days an evidence-anchored candidate may sit before the digest escalates.
 *
 * Three days = three missed daily promotion cycles (scrape-new-aggregators.yml
 * runs at 14:00 UTC and promotes regional/OB candidates in the same run). It
 * mirrors OB_CLOSING_AGED_DAYS_ERROR's reasoning — 21 days there is three
 * missed WEEKLY runs — rather than picking a fresh number.
 */
const RD_AGED_DAYS_ERROR = 3;

/**
 * Join the candidates report to the state file's firstSeen timestamps and rank
 * by age. The candidates report carries no age signal of its own (title,
 * source, url, date, market); reverse-discovery-state.json is where firstSeen
 * lives, keyed by candidateKey().
 *
 * @param {object} params
 * @param {Array<{title: string, source: string, market?: string}>} params.candidates
 * @param {Record<string, {firstSeen?: string}>} [params.state] - reverse-discovery-state.json
 * @param {number} params.nowMs
 * @param {(candidate: object) => boolean} [params.isStillMissing] - re-confirms
 *   the candidate is absent from the live catalogue. Defaults to trusting the
 *   report. Only gates ESCALATION: a since-added show stays in the count and
 *   can still be named, it just cannot raise severity on its own.
 * @returns {{count: number, status: 'warn'|'error', oldest: object, agedEvidence: object[]}|null}
 *   null when there is nothing to report.
 */
function rankReverseDiscoveryBacklog({ candidates, state, nowMs, isStillMissing } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const st = state && typeof state === 'object' ? state : {};

  const withAge = candidates.map((c) => {
    let ageDays = null;
    try {
      const entry = st[candidateKey(c)];
      const seen = entry && entry.firstSeen ? Date.parse(entry.firstSeen) : NaN;
      if (Number.isFinite(seen)) ageDays = Math.floor((nowMs - seen) / 86400000);
    } catch {
      // A malformed candidate must not take down the whole digest.
    }
    return { ...c, ageDays, evidenceAnchored: EVIDENCE_SOURCES.has(c.source) };
  });

  // Oldest first, exactly as obClosingBacklogResults ranks: entries with no
  // age signal sort after every aged entry but keep their relative order.
  const oldest = withAge.reduce((best, c) =>
    c.ageDays != null && (best.ageDays == null || c.ageDays > best.ageDays) ? c : best
  );

  // Only evidence-anchored candidates can escalate — see the header. A
  // candidate that has since been catalogued is dropped from the escalating
  // set: the report may simply be stale (STALE-REPORT HAZARD above).
  const stillMissing = (c) => {
    if (typeof isStillMissing !== 'function') return true;
    try {
      return isStillMissing(c) !== false;
    } catch {
      // A matcher failure must never silence a real backlog — fail loud.
      return true;
    }
  };
  const agedEvidence = withAge.filter(
    (c) =>
      c.evidenceAnchored &&
      c.ageDays != null &&
      c.ageDays >= RD_AGED_DAYS_ERROR &&
      stillMissing(c)
  );

  return {
    count: withAge.length,
    status: agedEvidence.length > 0 ? 'error' : 'warn',
    oldest,
    agedEvidence,
  };
}

/** Human label for a candidate, including its age when known. */
function describeCandidate(c) {
  if (!c) return '(none)';
  const age = c.ageDays != null ? ` — missing ${c.ageDays}d` : '';
  return `"${c.title}" (${c.source}${age})`;
}

module.exports = {
  EVIDENCE_SOURCES,
  RD_AGED_DAYS_ERROR,
  rankReverseDiscoveryBacklog,
  describeCandidate,
};
