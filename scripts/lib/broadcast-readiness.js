/**
 * broadcast-readiness.js
 *
 * Workflow-level readiness gate for the opening-night broadcast. This is the
 * COARSE pre-filter applied in opening-night-broadcast.yml — deliberately
 * stricter than the script's own internal gate (send-opening-night-broadcast.js
 * MIN_REVIEWS) so a show that only meets the looser script threshold can't slip
 * through the automated draft path.
 *
 * Market-aware (2026-06-29):
 *   - Broadway: BROADWAY_MIN scored reviews AND >=1 aggregator (DTLI or BWW).
 *   - West End: WEST_END_MIN scored reviews, NO aggregator requirement.
 *
 * Why West End drops the aggregator requirement: DTLI and BWW are Broadway-only
 * aggregators. West End reviews are scored via the LLM ensemble and never carry
 * dtliThumb/bwwThumb, so the Broadway aggregator gate (`aggCount < 1`) could
 * NEVER pass for a WE show — it silently excluded every West End opening from
 * the automated draft pipeline. Beetlejuice WE (2026-06-03) had 29 scored
 * reviews / 0 DTLI / 0 BWW and had to be sent manually out-of-band as a result.
 *
 * Pure function — exported and unit-tested against real review data. The
 * workflow's inline node block requires this so the gate logic lives in one
 * testable place (CLAUDE.md §15).
 */

const { isLondonMarket } = require('./venue-classification');

// Broadway floors out around 13 scored reviews; median ~29. West End median is
// ~16 with a long tail of legit 8-15-review straight plays. 12 catches every
// major WE opening (Beetlejuice 29, Sinatra 29, War Horse 26, Glengarry 26,
// Les Liaisons 25, John Proctor 18, Teeth 'n' Smiles 21) while filtering the
// thin 2-11-review fringe. The script's 3 T1 / 2 T2 / 6 hi-conf gate is the
// real quality floor; this count is just a coarse "enough has landed" pre-check.
const BROADWAY_MIN = 15;
const WEST_END_MIN = 12;

/**
 * @param {Array} showReviews - all review objects for ONE show (scored or not).
 * @param {string} category   - show category ('broadway' | 'west-end' | ...).
 * @returns {{ready: boolean, reason: string, count: number}}
 */
function evaluateBroadcastReadiness(showReviews, category) {
  const scored = (showReviews || []).filter(r => r && r.assignedScore != null);
  const count = scored.length;
  const westEnd = isLondonMarket(category);
  const min = westEnd ? WEST_END_MIN : BROADWAY_MIN;

  if (count < min) {
    return { ready: false, reason: `only ${count}/${min} scored reviews`, count };
  }

  if (westEnd) {
    // West End: no aggregator gate — these reviews are LLM-scored and carry no
    // DTLI/BWW thumb. Count is the only coarse signal available.
    return { ready: true, reason: `${count} scored reviews (West End — no aggregator gate)`, count };
  }

  // Broadway: require at least one aggregator source.
  const hasDtli = scored.some(r => r.dtliThumb);
  const hasBww = scored.some(r => r.bwwThumb);
  if (!hasDtli && !hasBww) {
    return { ready: false, reason: '0 aggregator sources — need DTLI or BWW', count };
  }
  const aggNames = [hasDtli && 'DTLI', hasBww && 'BWW'].filter(Boolean);
  return { ready: true, reason: `${count} scored reviews, aggregators: ${aggNames.join('+')}`, count };
}

module.exports = { evaluateBroadcastReadiness, BROADWAY_MIN, WEST_END_MIN };
