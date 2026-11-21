/** Page-view telemetry for the existing weekly email-gate funnel monitor. */
const { phQuery, REAL_USERS_WHERE } = require('./posthog-query');

// Match isPassiveTrigger in src/lib/gate-logic.ts. Explicit actions, blocking
// gates and one-shot recapture are exempt from the passive page-view minimum.
const EXEMPT_TRIGGERS = new Set(['csv_download', 'json_download', 'page_view_limit', 'recapture']);
const MIN_PAGE_VIEWS = 2;

// JSONExtractRaw preserves missing/null versus a real numeric zero. Never
// coerce legacy events without telemetry (or a malformed payload) into zero.
function pageCount(raw) {
  try {
    const value = JSON.parse(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

function summarizeGatePageViews(rows) {
  const violations = new Map();
  const summary = {
    checkedEvents: 0, belowMinimumEvents: 0, unknownPageViewEvents: 0, exemptEvents: 0,
    violationsByTrigger: {},
  };
  for (const [trigger, rawCount, rawMinimum, n] of rows) {
    const count = Number(n);
    if (EXEMPT_TRIGGERS.has(trigger)) {
      summary.exemptEvents += count;
      continue;
    }
    const views = pageCount(rawCount);
    if (views === null) {
      summary.unknownPageViewEvents += count;
      continue;
    }
    summary.checkedEvents += count;
    // Keep an independent two-page floor even if a future config edit drops
    // the client minimum. Honor higher configured minimums when present.
    const minimum = Math.max(MIN_PAGE_VIEWS, pageCount(rawMinimum) ?? MIN_PAGE_VIEWS);
    if (views < minimum) {
      summary.belowMinimumEvents += count;
      const key = trigger || '(none)';
      violations.set(key, (violations.get(key) || 0) + count);
    }
  }
  summary.violationsByTrigger = Object.fromEntries(violations);
  return summary;
}

async function getGatePageViewSummary(days, query = phQuery) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('days must be a positive integer');
  // One grouped query, no person IDs or raw event export. Explicit LIMIT
  // avoids HogQL's default 100-row cap dropping a rare violation bucket.
  const rows = await query(`
    SELECT JSONExtractString(properties,'trigger') AS trigger,
      JSONExtractRaw(properties,'pageViewCount') AS pageViewCount,
      JSONExtractRaw(properties,'minPageViewsForPassiveGate') AS minPageViewsForPassiveGate,
      count() AS n
    FROM events
    WHERE event = 'gate_modal_shown'
      AND timestamp > now() - INTERVAL ${days} DAY
      AND ${REAL_USERS_WHERE}
    GROUP BY trigger, pageViewCount, minPageViewsForPassiveGate
    LIMIT 1000000`);
  return summarizeGatePageViews(rows);
}

module.exports = { summarizeGatePageViews, getGatePageViewSummary };
