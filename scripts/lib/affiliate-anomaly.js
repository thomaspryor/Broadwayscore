'use strict';

/**
 * affiliate-anomaly.js — pure decision functions for affiliate revenue-stream
 * health (affiliate hardening plan, 2026-08-03; investigation of the -77.6%
 * WoW scare that turned out to be a prior-week outlier).
 *
 * The four failure layers this watches, established by that investigation:
 *   site → click        (PostHog ticket_click)     — CTA/rendering breakage
 *   click → Impact      (Impact-recorded clicks)   — pxf.io handoff breakage
 *   Impact → conversion (Impact actions)           — attribution/partner-side
 *   conversion → payout (payout economics)         — contract/rate changes
 *
 * Silence/collapse against each metric's OWN baseline is delegated to
 * scripts/lib/arm-yield.js (computeArmState / computeCollapseState) — the
 * primitive built for exactly that shape (card #647) — rather than a second
 * hand-tuned threshold system. This module holds only the genuinely novel
 * CROSS-SOURCE checks (ratios between two providers, payout economics, the
 * ungated dead-man's-switch) plus the outlier annotations shared with the
 * weekly report, so "what counts as an outlier" has exactly one definition.
 *
 * Everything here is pure (no I/O, no Date.now — callers pass asOf) so the
 * checks can be replayed against the real June–July 2026 history in
 * affiliate-anomaly.test.mjs. Volumes are tiny (~2 conversions/day), so every
 * check is click-volume-conditioned to keep Poisson noise from paging anyone.
 */

const { dayToMs, toDayKey, MS_PER_DAY } = require('./arm-yield');

/** Sum map values over the `days` calendar days ending at asOf (inclusive). */
function sumWindow(byDay, asOf, days) {
  const map = byDay instanceof Map ? byDay : new Map(Object.entries(byDay || {}));
  let total = 0;
  const endMs = dayToMs(asOf);
  for (let i = 0; i < days; i += 1) {
    total += Number(map.get(toDayKey(endMs - i * MS_PER_DAY))) || 0;
  }
  return total;
}

/**
 * Handoff break: the site keeps firing ticket_click events but Impact stops
 * recording clicks — the pxf.io redirect chain is broken while the UI looks
 * fine. (Clicks register at Impact BEFORE the redirect, so the inverse — links
 * fine, conversions dead — is covered by the flatline/collapse checks.)
 */
function checkHandoffBreak({ impactClicksByDay, posthogTTClicksByDay, asOf, days = 3, minRatio = 0.3, minPosthogClicks = 30, zeroDayPosthogFloor = 15 }) {
  const posthog = sumWindow(posthogTTClicksByDay, asOf, days);
  const impact = sumWindow(impactClicksByDay, asOf, days);
  if (posthog < minPosthogClicks) {
    return { verdict: 'not-applicable', reason: `only ${posthog} PostHog TodayTix clicks in ${days}d (need ${minPosthogClicks} for the ratio to mean anything)`, impact, posthog };
  }
  // Single-day total outage check: a one-day Impact=0 inside an otherwise
  // healthy window survives the ratio test (25+25+0 vs 120 = 42% > 30%) and
  // would go unreported until day 2-3 (Codex ship-check finding 2026-08-03).
  // A full zero against real same-day clicks is never noise at this volume.
  const impactMap = impactClicksByDay instanceof Map ? impactClicksByDay : new Map(Object.entries(impactClicksByDay || {}));
  const posthogMap = posthogTTClicksByDay instanceof Map ? posthogTTClicksByDay : new Map(Object.entries(posthogTTClicksByDay || {}));
  const endMs = dayToMs(asOf);
  for (let i = 0; i < days; i += 1) {
    const day = toDayKey(endMs - i * MS_PER_DAY);
    const dayImpact = Number(impactMap.get(day)) || 0;
    const dayPosthog = Number(posthogMap.get(day)) || 0;
    if (dayImpact === 0 && dayPosthog >= zeroDayPosthogFloor) {
      return {
        verdict: 'broken',
        reason: `Impact recorded ZERO clicks on ${day} while ${dayPosthog} real TodayTix clicks flowed — full one-day handoff outage (window ratio ${Math.round((impact / posthog) * 100)}% would have hidden it)`,
        impact, posthog, ratio: impact / posthog, zeroDay: day,
      };
    }
  }
  const ratio = impact / posthog;
  if (ratio < minRatio) {
    return {
      verdict: 'broken',
      reason: `Impact recorded only ${impact} clicks vs ${posthog} PostHog TodayTix clicks over ${days}d (${Math.round(ratio * 100)}%, floor ${Math.round(minRatio * 100)}%) — the pxf.io redirect chain is likely broken while the site UI still looks fine`,
      impact, posthog, ratio,
    };
  }
  return { verdict: 'healthy', reason: `Impact/PostHog click ratio ${Math.round(ratio * 100)}% over ${days}d`, impact, posthog, ratio };
}

/**
 * Bot divergence: Impact records far MORE clicks than real users produced —
 * crawlers hitting the tracking links directly. Observed live Jul 31–Aug 2
 * 2026 (Impact 89/62/60 vs ~30 real). Costs nothing directly but dilutes EPC
 * and risks Impact compliance flags if sustained.
 */
function checkBotDivergence({ impactClicksByDay, posthogTTClicksByDay, asOf, days = 3, maxRatio = 2.5, minImpactClicks = 60 }) {
  const posthog = sumWindow(posthogTTClicksByDay, asOf, days);
  const impact = sumWindow(impactClicksByDay, asOf, days);
  if (impact < minImpactClicks || posthog === 0) {
    return { verdict: 'not-applicable', reason: `only ${impact} Impact clicks in ${days}d (need ${minImpactClicks})`, impact, posthog };
  }
  const ratio = impact / posthog;
  if (ratio > maxRatio) {
    return {
      verdict: 'diverged',
      reason: `Impact recorded ${impact} clicks vs only ${posthog} real PostHog TodayTix clicks over ${days}d (${ratio.toFixed(1)}x, ceiling ${maxRatio}x) — likely bots hitting the pxf.io tracking links; dilutes EPC and risks Impact compliance review if sustained`,
      impact, posthog, ratio,
    };
  }
  return { verdict: 'healthy', reason: `Impact/PostHog click ratio ${ratio.toFixed(1)}x over ${days}d`, impact, posthog, ratio };
}

/**
 * Payout anomaly: conversions still flowing but the economics changed —
 * blended take-rate under the floor (TodayTix contract is 1% existing / 5%
 * new, so a trailing blend under 0.8% means either a contract change or a
 * wall of $0.00 payouts) or multiple explicit $0-payout conversions (the
 * 2026-07-29 $91.69-sale/$0.00-payout action is the reference case).
 * @param {Array<{EventDate:string, Amount:string|number, Payout:string|number}>} actions
 */
function checkPayoutAnomaly({ actions, asOf, days = 7, minTakeRate = 0.008, maxZeroPayout = 1, minConversions = 3 }) {
  const startMs = dayToMs(asOf) - (days - 1) * MS_PER_DAY;
  const inWindow = (actions || []).filter((a) => {
    const ms = dayToMs(String(a.EventDate || '').slice(0, 10));
    return Number.isFinite(ms) && ms >= startMs && ms <= dayToMs(asOf);
  });
  const sales = inWindow.reduce((s, a) => s + (parseFloat(a.Amount) || 0), 0);
  const payout = inWindow.reduce((s, a) => s + (parseFloat(a.Payout) || 0), 0);
  const zeroPayout = inWindow.filter((a) => (parseFloat(a.Amount) || 0) > 0 && (parseFloat(a.Payout) || 0) === 0);
  const takeRate = sales > 0 ? payout / sales : null;

  if (inWindow.length < minConversions) {
    return { verdict: 'not-applicable', reason: `only ${inWindow.length} conversions in ${days}d (need ${minConversions} to judge economics)`, conversions: inWindow.length, sales, payout, takeRate, zeroPayoutCount: zeroPayout.length };
  }
  const problems = [];
  if (takeRate !== null && takeRate < minTakeRate) {
    problems.push(`blended take-rate ${(takeRate * 100).toFixed(2)}% over ${days}d is under the ${(minTakeRate * 100).toFixed(1)}% floor — the partner contract/rate template may have changed`);
  }
  if (zeroPayout.length > maxZeroPayout) {
    problems.push(`${zeroPayout.length} conversions with a real sale amount but $0.00 payout in ${days}d (allowed ${maxZeroPayout})`);
  }
  if (problems.length) {
    return { verdict: 'anomalous', reason: problems.join('; '), conversions: inWindow.length, sales, payout, takeRate, zeroPayoutCount: zeroPayout.length };
  }
  return { verdict: 'healthy', reason: `take-rate ${takeRate === null ? 'n/a' : (takeRate * 100).toFixed(2) + '%'}, ${zeroPayout.length} zero-payout`, conversions: inWindow.length, sales, payout, takeRate, zeroPayoutCount: zeroPayout.length };
}

/**
 * Dead-man's-switch — deliberately UNGATED by any cross-condition. The
 * cross-conditioned checks all assume the two providers fail independently,
 * but one client-side change (consent banner, ad-blocker list, tracking
 * script) can kill BOTH signals at once, and every conditioned check then
 * stays silent precisely because its corroborating signal is also dead
 * (pre-mortem finding, 2026-08-03). Both signals near-zero for `days`
 * straight = CRITICAL, no further questions.
 */
function checkDeadMan({ impactClicksByDay, posthogClicksByDay, asOf, days = 2, dailyFloor = 5 }) {
  const endMs = dayToMs(asOf);
  const impactMap = impactClicksByDay instanceof Map ? impactClicksByDay : new Map(Object.entries(impactClicksByDay || {}));
  const posthogMap = posthogClicksByDay instanceof Map ? posthogClicksByDay : new Map(Object.entries(posthogClicksByDay || {}));
  const daysChecked = [];
  for (let i = 0; i < days; i += 1) {
    const day = toDayKey(endMs - i * MS_PER_DAY);
    daysChecked.push({
      day,
      impact: Number(impactMap.get(day)) || 0,
      posthog: Number(posthogMap.get(day)) || 0,
    });
  }
  const allDead = daysChecked.every((d) => d.impact < dailyFloor && d.posthog < dailyFloor);
  if (allDead) {
    return {
      verdict: 'dead',
      reason: `BOTH Impact clicks and PostHog ticket clicks under ${dailyFloor}/day for ${days} consecutive days (${daysChecked.map((d) => `${d.day}: ${d.impact}/${d.posthog}`).join(', ')}) — a shared-fate breakage (consent/tracking/site) that the cross-conditioned checks cannot see`,
      daysChecked,
    };
  }
  return { verdict: 'healthy', reason: 'at least one click signal alive', daysChecked };
}

/**
 * Absolute zero-conversion ceiling — fires regardless of click evidence.
 * At the June-2026 baseline of ~2 conversions/day, 7 straight zero days has
 * probability well under 1e-4; even at half that rate it stays alertable.
 */
function checkZeroConversionCeiling({ conversionsByDay, asOf, days = 7 }) {
  const total = sumWindow(conversionsByDay, asOf, days);
  if (total === 0) {
    return { verdict: 'dead', reason: `0 conversions for ${days} consecutive days ending ${asOf} — beyond plausible variance at any observed baseline, regardless of click volume`, total };
  }
  return { verdict: 'healthy', reason: `${total} conversions in trailing ${days}d`, total };
}

// ── Report annotations (shared with scripts/lib/affiliate-email.js) ─────────

/**
 * Days contributing an outsized share of the window's commission — the 7/24
 * pattern (one day = $89 of a $142 week) that made the WoW delta panic-read.
 * @param {Array<{EventDate:string, Payout:string|number}>} actions
 */
function findOutlierDays(actions, { share = 0.4 } = {}) {
  const byDay = new Map();
  let total = 0;
  for (const a of actions || []) {
    const day = String(a.EventDate || '').slice(0, 10);
    if (!Number.isFinite(dayToMs(day))) continue;
    const p = parseFloat(a.Payout) || 0;
    byDay.set(day, (byDay.get(day) || 0) + p);
    total += p;
  }
  if (total <= 0) return [];
  return [...byDay.entries()]
    .filter(([, p]) => p / total >= share)
    .map(([day, payout]) => ({ day, payout, shareOfWindow: payout / total }))
    .sort((a, b) => b.payout - a.payout);
}

/**
 * Single buyers with several conversions in the window — "6 of 11 orders on
 * 7/24 were one buyer". SubId1 carries the PostHog distinct_id, echoed back
 * by Impact on each conversion.
 */
function findRepeatBuyers(actions, { minConversions = 3 } = {}) {
  const bySub = new Map();
  for (const a of actions || []) {
    const sub = a.SubId1 || '';
    if (!sub) continue;
    if (!bySub.has(sub)) bySub.set(sub, { subId1: sub, conversions: 0, sales: 0, payout: 0 });
    const row = bySub.get(sub);
    row.conversions += 1;
    row.sales += parseFloat(a.Amount) || 0;
    row.payout += parseFloat(a.Payout) || 0;
  }
  return [...bySub.values()]
    .filter((r) => r.conversions >= minConversions)
    .sort((a, b) => b.conversions - a.conversions);
}

/**
 * Trailing-baseline context for the WoW panel: daily averages over the
 * `baselineDays` before the current window, from a per-day performance series
 * ({date, clicks, conversions, payout, sales}).
 */
function baselineComparison(dailyPerf, { asOf, windowDays = 7, baselineDays = 28 }) {
  const endMs = dayToMs(asOf);
  const windowStartMs = endMs - (windowDays - 1) * MS_PER_DAY;
  const baselineStartMs = windowStartMs - baselineDays * MS_PER_DAY;
  const win = { days: 0, clicks: 0, conversions: 0, payout: 0, sales: 0 };
  const base = { days: 0, clicks: 0, conversions: 0, payout: 0, sales: 0 };
  for (const row of dailyPerf || []) {
    const ms = dayToMs(row.date);
    if (!Number.isFinite(ms) || ms > endMs) continue;
    const bucket = ms >= windowStartMs ? win : ms >= baselineStartMs ? base : null;
    if (!bucket) continue;
    bucket.days += 1;
    bucket.clicks += Number(row.clicks) || 0;
    bucket.conversions += Number(row.conversions) || 0;
    bucket.payout += Number(row.payout) || 0;
    bucket.sales += Number(row.sales) || 0;
  }
  const perDay = (b) => (b.days > 0 ? {
    clicks: b.clicks / b.days,
    conversions: b.conversions / b.days,
    payout: b.payout / b.days,
    sales: b.sales / b.days,
  } : null);
  const winPerDay = perDay(win);
  const basePerDay = perDay(base);
  let payoutVsBaselinePct = null;
  if (winPerDay && basePerDay && basePerDay.payout > 0) {
    payoutVsBaselinePct = ((winPerDay.payout - basePerDay.payout) / basePerDay.payout) * 100;
  }
  return { window: win, baseline: base, windowPerDay: winPerDay, baselinePerDay: basePerDay, payoutVsBaselinePct };
}

module.exports = {
  sumWindow,
  checkHandoffBreak,
  checkBotDivergence,
  checkPayoutAnomaly,
  checkDeadMan,
  checkZeroConversionCeiling,
  findOutlierDays,
  findRepeatBuyers,
  baselineComparison,
};
