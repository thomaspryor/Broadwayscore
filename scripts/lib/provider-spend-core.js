/**
 * provider-spend-core.js — pure decision functions for the daily scraping-spend
 * reconciliation (Scraping Cost System v2, Sprint 0).
 *
 * The invariant this enforces: "fixed" is a claim only 7 consecutive
 * billing-verified days within thresholds may make. A day any provider could
 * not be measured is 'unknown' and BREAKS the streak — an unmeasurable day
 * must never count as a green one (fail-closed, plan-review consensus).
 *
 * I/O lives in scripts/check-provider-spend.js; these functions are pure and
 * tested in provider-spend-core.test.mjs (CLAUDE.md §15).
 */
'use strict';

const BB_COST_PER_SESSION = 0.10;

/**
 * Build today's spend record from raw provider readings (any of which may be
 * null = unmeasurable) and yesterday's record (for cycle-counter deltas).
 *
 * SB and SD only expose cycle-cumulative counters, so a per-day figure is the
 * delta vs the previous record. A counter that went DOWN means the cycle
 * renewed — the day's usage is the new cycle's counter itself. With no prior
 * record the delta is unknowable: status 'baseline' (measured, but not
 * day-attributable; does not break the streak, does not count toward it).
 */
function computeDayRecord({ day, bb, bd, sb, sd, prev }) {
  const rec = { day, providers: {} };

  rec.providers.browserbase = bb == null
    ? { status: 'unknown' }
    : { status: 'ok', sessions: bb, cost: +(bb * BB_COST_PER_SESSION).toFixed(2) };

  if (bd == null || bd.serp == null || bd.unlocker == null) {
    rec.providers.brightdata = { status: 'unknown' };
  } else {
    rec.providers.brightdata = {
      status: 'ok',
      cost: +(bd.serp.cost + bd.unlocker.cost).toFixed(2),
      serpReqs: bd.serp.reqs,
      unlockerReqs: bd.unlocker.reqs,
    };
  }

  rec.providers.scrapingbee = cycleDelta(sb, prev?.providers?.scrapingbee);
  rec.providers.scrapingdog = cycleDelta(sd, prev?.providers?.scrapingdog);
  return rec;
}

function cycleDelta(reading, prevEntry) {
  if (reading == null) return { status: 'unknown' };
  const out = { status: 'ok', cycleUsed: reading.cycleUsed, cap: reading.cap ?? reading.limit ?? null };
  const prevCycleUsed = prevEntry && typeof prevEntry.cycleUsed === 'number' ? prevEntry.cycleUsed : null;
  if (prevCycleUsed == null) {
    out.status = 'baseline';
  } else {
    out.dayCredits = reading.cycleUsed >= prevCycleUsed
      ? reading.cycleUsed - prevCycleUsed
      : reading.cycleUsed; // counter reset = cycle renewed
  }
  return out;
}

/**
 * Compare one day record against thresholds. Unknown providers are breaches of
 * measurability, reported distinctly so the alert says "could not measure X",
 * not "X overspent".
 * @returns {{overspend: string[], unmeasured: string[]}}
 */
function budgetBreaches(record, thresholds) {
  const overspend = [];
  const unmeasured = [];
  const p = record.providers || {};

  if (p.browserbase?.status === 'ok') {
    if (thresholds.browserbaseDailyUsd != null && p.browserbase.cost > thresholds.browserbaseDailyUsd) {
      overspend.push(`browserbase $${p.browserbase.cost} > $${thresholds.browserbaseDailyUsd} (${p.browserbase.sessions} sessions)`);
    }
  } else unmeasured.push('browserbase');

  if (p.brightdata?.status === 'ok') {
    if (thresholds.brightdataDailyUsd != null && p.brightdata.cost > thresholds.brightdataDailyUsd) {
      overspend.push(`brightdata $${p.brightdata.cost} > $${thresholds.brightdataDailyUsd} (${p.brightdata.serpReqs} serp + ${p.brightdata.unlockerReqs} unlocker reqs)`);
    }
  } else unmeasured.push('brightdata');

  for (const [key, thKey] of [['scrapingbee', 'scrapingbeeDailyCredits'], ['scrapingdog', 'scrapingdogDailyCredits']]) {
    const entry = p[key];
    if (!entry || entry.status === 'unknown') { unmeasured.push(key); continue; }
    if (entry.status === 'baseline') continue; // measured; delta arrives tomorrow
    if (thresholds[thKey] != null && entry.dayCredits > thresholds[thKey]) {
      overspend.push(`${key} ${entry.dayCredits} credits > ${thresholds[thKey]}`);
    }
  }
  return { overspend, unmeasured };
}

/**
 * Trailing consecutive fully-green days (no overspend, no unmeasured
 * provider). 'baseline' days are excluded from the streak but do not reset a
 * PRIOR streak — they simply cannot prove anything yet, so the streak counts
 * only proven days. Records must be day-ascending; duplicates by day are the
 * caller's bug.
 */
function computeStreak(records, thresholds) {
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const { overspend, unmeasured } = budgetBreaches(records[i], thresholds);
    const hasBaseline = Object.values(records[i].providers || {}).some((e) => e?.status === 'baseline');
    if (overspend.length || unmeasured.length) break;
    if (hasBaseline) break; // can't prove this day; streak restarts after it
    streak++;
  }
  return streak;
}

/**
 * Snapshot for the morning digest — the {generatedAt, bannerText, items}
 * shape renderNamedDigestBlock already renders (backlog-drain precedent; no
 * new render code). Spend AND yield on one line each: a $0 day with a dead
 * pipeline must not read as green (plan-review consensus).
 */
function renderSnapshot({ record, streak, breaches, generatedAt }) {
  const p = record.providers;
  const items = [];
  const fmt = (e, money, extra) => (e.status === 'ok' ? `${money}${extra || ''}` : e.status);

  items.push(`Browserbase: ${fmt(p.browserbase, `$${p.browserbase.cost ?? '?'}`, ` (${p.browserbase.sessions} sessions)`)}`);
  items.push(`Bright Data: ${fmt(p.brightdata, `$${p.brightdata.cost ?? '?'}`, ` (${p.brightdata.serpReqs} serp / ${p.brightdata.unlockerReqs} unlocker)`)}`);
  for (const key of ['scrapingbee', 'scrapingdog']) {
    const e = p[key];
    const label = key === 'scrapingbee' ? 'ScrapingBee' : 'ScrapingDog';
    if (e.status === 'ok' && e.dayCredits != null) items.push(`${label}: ${e.dayCredits} credits today (${e.cycleUsed} this cycle)`);
    else if (e.status === 'baseline') items.push(`${label}: baseline day (cycle ${e.cycleUsed}) — day figure starts tomorrow`);
    else items.push(`${label}: unknown — billing API unreachable`);
  }

  let bannerText;
  if (breaches.overspend.length) bannerText = `OVER BUDGET: ${breaches.overspend.join('; ')}`;
  else if (breaches.unmeasured.length) bannerText = `Could not measure: ${breaches.unmeasured.join(', ')} — day does not count toward the streak`;
  else bannerText = `Within budget · streak ${streak} of 7 verified day${streak === 1 ? '' : 's'}`;

  return { generatedAt, bannerText, items, moreCount: 0 };
}

module.exports = { computeDayRecord, budgetBreaches, computeStreak, renderSnapshot, BB_COST_PER_SESSION };
