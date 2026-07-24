/**
 * opening-night-selection — the single "which shows are in their opening-night
 * window" predicate, lifted verbatim from opening-night-orchestrator.yml's
 * inline `node -e` (2026-07-24) so the orchestrator and the local
 * opening-night monitor launcher can't silently drift apart. The monitor's
 * deliberately-broader selection (it exists to catch shows the orchestrator's
 * trust/status gates skip — the documented WE untrusted-openingDateSource
 * starvation class) is expressed as OPTIONS on the same predicate, not a fork.
 *
 * Defaults reproduce the orchestrator's historical behavior exactly; the
 * parity test (opening-night-selection.test.mjs) locks that in with the
 * pre-extraction logic inlined as a fixture.
 */

const { isTrustedPressNightSource } = require('./press-night-trust.js');

/**
 * @param {Array} shows           shows.json `.shows` array
 * @param {object} [opts]
 * @param {string} [opts.market]  '' (all) | 'broadway' | 'west-end' — broadway
 *                                includes off-broadway; west-end includes
 *                                off-west-end (matches orchestrator $MARKET)
 * @param {Date}   [opts.now]     injection point for tests
 * @param {number} [opts.lookbackDays]   default 21 (tier-3 outlets publish 7-14d
 *                                late; BWW RR seen at +14d — Heated Rivalry)
 * @param {number} [opts.lookAheadHours] default 6 (the 23:00 UTC cron fires
 *                                before midnight; still discover "tomorrow")
 * @param {boolean} [opts.includeUntrusted] monitor-only: ignore the WE
 *                                untrusted-openingDateSource pre-open gate
 * @param {boolean} [opts.ignoreStatus]     monitor-only: ignore the status gate
 *                                (announced/closed shows with a date in-window
 *                                still selected — the Sherlock Holmes class)
 * @returns {Array} matching show objects (not just ids)
 */
function selectOpeningNightShows(shows, opts = {}) {
  const {
    market = '',
    now = new Date(),
    lookbackDays = 21,
    lookAheadHours = 6,
    includeUntrusted = false,
    ignoreStatus = false,
  } = opts;

  const lookAhead = new Date(now.getTime() + lookAheadHours * 60 * 60 * 1000);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);

  return shows.filter(s => {
    const cat = s.category || 'broadway';
    // OB/OWE shows frequently open "cold" with no formal press night, so
    // openingDate is often null — which would exclude them from discovery
    // entirely (Are You Now Or Have You Ever Been: 0 reviews despite 3+
    // published, 2026-06-15). For those cold-open markets, fall back to
    // previewsStartDate as the discovery anchor. Press-night markets
    // (broadway/west-end) keep requiring a real openingDate.
    const isColdOpenMarket = cat === 'off-broadway' || cat === 'off-west-end';
    const effectiveOpening = s.openingDate || (isColdOpenMarket ? s.previewsStartDate : null);
    if (!effectiveOpening) return false;
    if (!ignoreStatus) {
      // Include 'previews' shows whose (effective) opening date has passed or
      // is within the look-ahead — the 23:00 UTC cron fires before midnight,
      // so we need to catch shows opening "tomorrow" in UTC terms.
      const validStatus = s.status === 'open' || s.status === 'upcoming' ||
        (s.status === 'previews' && new Date(effectiveOpening) <= lookAhead);
      if (!validStatus) return false;
    }
    if (market === 'broadway' && cat !== 'broadway' && cat !== 'off-broadway') return false;
    if (market === 'west-end' && cat !== 'west-end' && cat !== 'off-west-end') return false;
    // WE shows with an UNTRUSTED openingDateSource (e.g. todaytix) may carry
    // a preview date rather than a real press night, so the orchestrator
    // doesn't poll them in the previews-anticipation window — but ONCE the
    // show is genuinely 'open', discovery MUST run (A Life in Four Seasons:
    // 2 of 7+ reviews, 2026-06-15). The monitor passes includeUntrusted to
    // drop this gate entirely — catching exactly the shows it starves.
    if (!includeUntrusted && cat === 'west-end' && !isTrustedPressNightSource(s.openingDateSource)
        && s.status !== 'open') {
      return false;
    }
    const d = new Date(effectiveOpening);
    d.setHours(0, 0, 0, 0);
    return d >= cutoff && d <= lookAhead;
  });
}

module.exports = { selectOpeningNightShows };

// CLI seam for opening-night-orchestrator.yml (replaces its inline node -e):
//   node scripts/lib/opening-night-selection.js --market=broadway
// Prints comma-separated show ids (empty output = no shows), matching the
// workflow's previous stdout contract exactly.
if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
  const { shows } = require('../../data/shows.json');
  const selected = selectOpeningNightShows(shows, { market: args.market || '' });
  if (selected.length > 0) console.log(selected.map(s => s.id).join(','));
}
