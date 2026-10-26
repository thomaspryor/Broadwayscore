'use strict';

/**
 * cost-report-alerts — the "Action needed" rules of the weekly Scraper Cost
 * Report (scraper-cost-report.yml), in one PURE function (BRO-6391).
 *
 * WHY: the report used to build its Action-needed list in bash and email it,
 * ending each line in "check logs" / "investigate spike". Nothing filed a
 * card, so every red line waited for the owner to open a session by hand.
 * Now each red line is a routeAlert() condition (route-cost-report-alerts.js)
 * filed as a dispatch-at-filing card a worker session takes, and the email
 * names that card instead of asking the owner to act. Amber lines stay
 * email-only: they are "keep an eye on it", not work.
 *
 * Thresholds are the ones the bash step used (unchanged).
 */

const KEY_PREFIX = 'scraper-cost-report:';
const KEYS = Object.freeze({
  workflowFailures: `${KEY_PREFIX}workflow-failures`,
  sbProjectedOverCap: `${KEY_PREFIX}sb-projected-over-cap`,
  sbExhausted: `${KEY_PREFIX}sb-exhausted`,
  browserbaseSpike: `${KEY_PREFIX}browserbase-spike`,
});
const CARD_KEYS = Object.freeze(Object.values(KEYS));

const FAILURES_THRESHOLD = 5;
const SB_HIGH_CREDITS = 50000;
const BB_SPIKE_USD = 50;
const BB_MONITOR_USD = 25;

function int(v) {
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : null;
}

function failedBreakdown(failedByWorkflow) {
  return Object.entries(failedByWorkflow || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([wf, n]) => `${wf}: ${n}`);
}

/**
 * PURE. Which Action-needed lines does this week's data produce?
 *
 * @param {object} m
 * @param {number|string} m.totalFailed
 * @param {number|string} m.totalCancelled
 * @param {Record<string, number>} [m.failedByWorkflow] workflow file -> failed runs
 * @param {number|string} m.bbCost  Browserbase USD this week
 * @param {number|string} m.bbSessions
 * @param {number|string} [m.sbProjected] projected ScrapingBee credits this cycle
 * @param {number|string} [m.sbCap]
 * @param {string} [m.sbStatus]
 * @param {number|string} [m.sbCreditsTotal]
 * @param {string} [m.apiDegraded] non-empty when some provider data is missing
 * @param {string} [m.runsQueryFailed] workflows whose run history could not be read (failure count is low)
 * @param {string} [m.runUrl] this run, linked from each card
 * @returns {{ lines: Array<{level:'red'|'amber', text:string, conditionKey:string|null, card:object|null}>,
 *            resolvableKeys: string[] }}
 *   `card` is the routeAlert() payload for a red line; `resolvableKeys` are
 *   card conditions this run shows clear. None are resolvable when provider
 *   data is degraded: a missing number reads as zero, never as a fix.
 */
function evaluateCostReport(m = {}) {
  const lines = [];
  const runRef = m.runUrl ? `\n\nReport run: ${m.runUrl}` : '';
  const footer = 'Found by the weekly Scraper Cost Report (.github/workflows/scraper-cost-report.yml). '
    + 'The owner does not need to act: a worker session takes this card.\n\n'
    + 'Done means: the cause is found and fixed, or shown to be legitimate use (say which, with numbers). '
    + 'Whether to raise a spend budget is not this card\'s call (provider-spend:overspend in the daily digest asks the owner that). '
    + 'The VERIFY line below reads the alert ledger and only passes once the next weekly report (Mondays 14:00 UTC) is clear, '
    + 'so after landing a fix report the card Paused with RECHECK-AFTER: <next Monday> rather than Done.';

  const failed = int(m.totalFailed) || 0;
  const cancelled = int(m.totalCancelled) || 0;
  if (failed > FAILURES_THRESHOLD) {
    const breakdown = failedBreakdown(m.failedByWorkflow);
    lines.push({
      level: 'red',
      conditionKey: KEYS.workflowFailures,
      text: `${failed} scraper workflow failures this week (${cancelled} cancelled runs not counted)`,
      card: {
        title: `Scraper workflows failed ${failed} times this week, find and fix the cause`,
        description: `${footer}\n\nTechnical: ${failed} failed/timed-out runs across the scraper workflows in the 7 days to this report (threshold ${FAILURES_THRESHOLD}; ${cancelled} cancelled runs not counted).`
          + (breakdown.length ? `\n\nFailures by workflow:\n${breakdown.map((l) => `- ${l}`).join('\n')}` : '')
          + runRef,
        hint: 'Read the failed runs of the workflows above (GitHub Actions API, conclusion=failure). Group them by error signature; fix the code behind each repeated signature. A one-off provider outage needs no fix: say so on the card.',
      },
    });
  }

  const sbProjected = int(m.sbProjected);
  const sbCap = int(m.sbCap);
  if (sbProjected != null && sbCap != null && sbCap > 0 && sbProjected > sbCap) {
    const overPct = Math.floor(((sbProjected - sbCap) * 100) / sbCap);
    lines.push({
      level: 'red',
      conditionKey: KEYS.sbProjectedOverCap,
      text: `ScrapingBee projected ${sbProjected} credits this cycle, ${overPct}% over the ${sbCap} cap`,
      card: {
        title: `ScrapingBee on track to run out this cycle (${overPct}% over cap), cut usage`,
        description: `${footer}\n\nTechnical: projected ${sbProjected} credits against a ${sbCap} cap (SB_TARGET_CAP). When ScrapingBee runs out mid-cycle, Bright Data and Playwright take the overflow and some fetches fail.${runRef}`,
        hint: 'Find which callers spend the credits (data/audit spend ledger, [Scraper Summary] lines in the scraper workflows) and move them to Bright Data first or reduce their cadence.',
      },
    });
  }

  if (/exhausted/i.test(String(m.sbStatus || ''))) {
    lines.push({
      level: 'red',
      conditionKey: KEYS.sbExhausted,
      text: 'ScrapingBee credits exhausted (fallbacks active)',
      card: {
        title: 'ScrapingBee credits ran out, check fallbacks are carrying the load',
        description: `${footer}\n\nTechnical: the ScrapingBee usage API reports the plan exhausted. Fetches fall back to Bright Data / Playwright until renewal.${runRef}`,
        hint: 'Confirm the fallback chain is serving the scrapers (recent collect/gather runs succeed); find what used the credits so the next cycle does not run out.',
      },
    });
  }

  const bbCost = Number(m.bbCost);
  const bbUsd = Number.isFinite(bbCost) ? Math.round(bbCost) : 0;
  const bbSessions = int(m.bbSessions) || 0;
  const bbCostText = Number.isFinite(bbCost) ? bbCost.toFixed(2) : String(m.bbCost);
  if (bbUsd > BB_SPIKE_USD) {
    lines.push({
      level: 'red',
      conditionKey: KEYS.browserbaseSpike,
      text: `Browserbase $${bbCostText} this week (${bbSessions} sessions)`,
      card: {
        title: `Browserbase cost $${bbCostText} this week (${bbSessions} sessions), find what drove it`,
        description: `${footer}\n\nTechnical: ${bbSessions} Browserbase sessions (~$0.10 each) in the 7 days to this report, threshold $${BB_SPIKE_USD}/week. Caps: scripts/lib/browserbase-caps.js; live usage: scripts/lib/browserbase-live-usage.js.${runRef}`,
        hint: 'List the week\'s sessions per day and match them to the workflow runs that created them (collect-review-texts, opening-night-poller, aggregator-url-watcher). Fix the caller that exceeds its expected use, or lower its cap. Emergency stop: repo variable BROWSERBASE_KILL_SWITCH=true.',
      },
    });
  } else if (bbUsd > BB_MONITOR_USD) {
    lines.push({ level: 'amber', conditionKey: null, card: null, text: `Browserbase $${bbCostText} this week (${bbSessions} sessions), monitor` });
  }

  const sbCredits = int(m.sbCreditsTotal) || 0;
  if (sbCredits > SB_HIGH_CREDITS) {
    lines.push({ level: 'amber', conditionKey: null, card: null, text: `High ScrapingBee credit usage (${sbCredits}), review if Bright Data first is working` });
  }

  const degraded = String(m.apiDegraded || '').trim();
  if (degraded) {
    lines.push({ level: 'amber', conditionKey: null, card: null, text: `Cost data partially unavailable: ${degraded}` });
  }

  const runsQueryFailed = String(m.runsQueryFailed || '').trim();
  if (runsQueryFailed) {
    lines.push({ level: 'amber', conditionKey: null, card: null, text: `Run history unreadable for ${runsQueryFailed}, failure count may be low` });
  }

  const firing = new Set(lines.map((l) => l.conditionKey).filter(Boolean));
  // An undercounted failure total is not a clear week for the failures card.
  const unknown = new Set(runsQueryFailed ? [KEYS.workflowFailures] : []);
  const resolvableKeys = degraded ? [] : CARD_KEYS.filter((k) => !firing.has(k) && !unknown.has(k));
  return { lines, resolvableKeys };
}

/**
 * Parse the bash step's "file:N,file:N" failure list. Bad pairs are skipped.
 * @param {string} s
 * @returns {Record<string, number>}
 */
function parseFailedByWorkflow(s) {
  const out = {};
  for (const pair of String(s || '').split(',')) {
    const i = pair.lastIndexOf(':');
    if (i <= 0) continue;
    const n = Number(pair.slice(i + 1));
    if (Number.isInteger(n) && n > 0) out[pair.slice(0, i).trim()] = n;
  }
  return out;
}

module.exports = {
  evaluateCostReport,
  parseFailedByWorkflow,
  KEYS,
  CARD_KEYS,
  FAILURES_THRESHOLD,
  BB_SPIKE_USD,
};
