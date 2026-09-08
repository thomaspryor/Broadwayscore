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

// Pure lib -> pure lib. Reading THE shared ceiling (rather than re-deriving a
// number here) is what keeps the digest's cap-exhausted line honest after the
// T13 step-down moves the cap.
const { resolveMaxSessionsPerDay } = require('./browserbase-caps');

const BB_COST_PER_SESSION = 0.10;

/** "YYYY-MM-DD" for the UTC day before `now`. The reconciliation target is
 * always a COMPLETE day — recording the in-progress day would freeze a
 * few-hours-old partial figure into the ledger forever (ship-check P0). */
function utcYesterday(now = new Date()) {
  return new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
}

/** Is `day` exactly the calendar day after `prevDay` (both "YYYY-MM-DD" UTC)? */
function isNextUtcDay(prevDay, day) {
  if (!prevDay || !day) return false;
  return new Date(`${day}T00:00:00Z`) - new Date(`${prevDay}T00:00:00Z`) === 86400000;
}

/**
 * Build one COMPLETE day's spend record from raw provider readings (any of
 * which may be null = unmeasurable) and the previous record (for
 * cycle-counter deltas).
 *
 * SB and SD only expose cycle-cumulative counters, so a per-day figure is the
 * delta vs the previous record — valid ONLY when the previous record is the
 * immediately preceding calendar day. Across a gap (cron outage) the delta
 * spans multiple days and would false-breach a one-day threshold, so it
 * degrades to 'baseline'. A counter that went DOWN means the cycle renewed —
 * the day's usage is the new cycle's counter itself. 'baseline' = measured
 * but not day-attributable; it neither breaks nor extends the streak.
 */
function computeDayRecord({ day, bb, bd, sb, sd, prev }) {
  const prevAdjacent = prev && isNextUtcDay(prev.day, day) ? prev : null;
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

  rec.providers.scrapingbee = cycleDelta(sb, prevAdjacent?.providers?.scrapingbee);
  rec.providers.scrapingdog = cycleDelta(sd, prevAdjacent?.providers?.scrapingdog);
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
 * Trailing consecutive fully-green CALENDAR days (no overspend, no unmeasured
 * provider, no missing day). A calendar gap — the cron simply didn't run —
 * breaks the streak: an unrecorded day is an unproven day (ship-check P1;
 * this is the invariant the whole file exists to protect). 'baseline' days
 * also break it — they cannot prove anything yet. Records must be
 * day-ascending; duplicates by day are the caller's bug.
 */
function computeStreak(records, thresholds) {
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (i < records.length - 1 && !isNextUtcDay(records[i].day, records[i + 1].day)) break;
    const { overspend, unmeasured } = budgetBreaches(records[i], thresholds);
    const hasBaseline = Object.values(records[i].providers || {}).some((e) => e?.status === 'baseline');
    if (overspend.length || unmeasured.length) break;
    if (hasBaseline) break;
    streak++;
  }
  return streak;
}

/**
 * Snapshot for the morning digest — the {generatedAt, bannerText, items}
 * shape renderNamedDigestBlock already renders (backlog-drain precedent; no
 * new render code). Items must be {title} OBJECTS — the renderer reads
 * it.title and silently drops bare strings (ship-check P0; see
 * scripts/backlog-drain.js for the same wrapping). Spend AND yield on one
 * line each: a $0 day with a dead pipeline must not read as green.
 */
function renderSnapshot({
  record, streak, breaches, generatedAt, maxSessionsPerDay = resolveMaxSessionsPerDay(), attribution,
  attributionCoverageMin = 0.8,
}) {
  const p = record.providers;
  const items = [];
  const fmt = (e, money, extra) => (e.status === 'ok' ? `${money}${extra || ''}` : e.status);

  items.push({ title: `${record.day} · Browserbase: ${fmt(p.browserbase, `$${p.browserbase.cost ?? '?'}`, ` (${p.browserbase.sessions} sessions)`)}` });

  // Cap-exhausted line (Scraping v2 T13). Spend alone can't answer "did the
  // ceiling actually BITE?" — and that is the question the step-down
  // (250 -> 100 -> 60) is gated on. A day that lands under budget because the
  // cap clipped it is NOT a healthy day: work was dropped. Derived from the
  // session count already in the ledger, so there's no new writer to keep
  // in sync. See memory/browserbase-cap-stepdown-runbook.md.
  if (p.browserbase?.status === 'ok' && typeof p.browserbase.sessions === 'number') {
    const used = p.browserbase.sessions;
    if (used >= maxSessionsPerDay) {
      items.push({ title: `⚠️ Browserbase CAP EXHAUSTED: ${used}/${maxSessionsPerDay} sessions — work was dropped, this day does NOT count toward the step-down streak` });
    } else if (used >= maxSessionsPerDay * 0.9) {
      items.push({ title: `Browserbase near cap: ${used}/${maxSessionsPerDay} sessions (${Math.round((used / maxSessionsPerDay) * 100)}%)` });
    }
  }

  items.push({ title: `${record.day} · Bright Data: ${fmt(p.brightdata, `$${p.brightdata.cost ?? '?'}`, ` (${p.brightdata.serpReqs} serp / ${p.brightdata.unlockerReqs} unlocker)`)}` });
  for (const key of ['scrapingbee', 'scrapingdog']) {
    const e = p[key];
    const label = key === 'scrapingbee' ? 'ScrapingBee' : 'ScrapingDog';
    if (e.status === 'ok' && e.dayCredits != null) items.push({ title: `${label}: ${e.dayCredits} credits (${e.cycleUsed} this cycle)` });
    else if (e.status === 'baseline') items.push({ title: `${label}: baseline day (cycle ${e.cycleUsed}) — day figure starts tomorrow` });
    else items.push({ title: `${label}: unknown — billing API unreachable` });
  }

  // attributedPct (task #752): "did the ledger capture ALL of this provider's
  // spend?" answered as a number instead of an assumption. null means the
  // billing side was unmeasurable that day — reported as "n/a", never as a
  // false 0% or 100%.
  //
  // topCoveragePct (S0-T7) answers a DIFFERENT question: even when overall
  // attribution is high, the printed top-N callers list can still be a small
  // slice of a long tail — "covers N% of billed X" makes that visible instead
  // of implying the top-N list IS the whole picture. Below
  // attributionCoverageMin, this degrades to a coverage warning naming the
  // fix in flight — it never suppresses the line entirely (Pre-mortem/User
  // Impact plan-review consensus: suppression hides the only signal).
  if (attribution) {
    for (const [provider, label] of [['browserbase', 'Browserbase'], ['brightdata', 'Bright Data'], ['scrapingbee', 'ScrapingBee'], ['scrapingdog', 'ScrapingDog']]) {
      const a = attribution[provider];
      if (!a || a.pct == null) continue;
      const pctText = `${Math.round(a.pct * 100)}% attributed`;
      const unit = a.unit === 'credits' ? 'credits' : 'calls';
      const suffix = unit === 'credits' ? 'cr' : '';
      let coverageText = '';
      if (a.top && a.top.length) {
        const topList = a.top.map((t) => `${t.script} ${t.amount}${suffix}`).join(', ');
        coverageText = a.topCoveragePct != null
          ? ` — top callers (covers ${Math.round(a.topCoveragePct * 100)}% of billed ${unit}): ${topList}`
          : ` — top: ${topList}`;
      }
      items.push({ title: `${label} attribution: ${pctText}${coverageText}` });
      if (a.topCoveragePct != null && a.topCoveragePct < attributionCoverageMin) {
        items.push({
          title: `⚠️ ${label} top-caller coverage low: ${Math.round(a.topCoveragePct * 100)}% of billed ${unit} < ${Math.round(attributionCoverageMin * 100)}% threshold — BRO-2961 (uninstrumented direct-caller cleanup) is the fix in flight`,
        });
      }
    }
  }

  let bannerText;
  if (breaches.overspend.length) bannerText = `OVER BUDGET: ${breaches.overspend.join('; ')}`;
  else if (breaches.unmeasured.length) bannerText = `Could not measure: ${breaches.unmeasured.join(', ')} — day does not count toward the streak`;
  else bannerText = `Within budget · streak ${streak} of 7 verified day${streak === 1 ? '' : 's'}`;

  return { generatedAt, bannerText, items, moreCount: 0 };
}

/**
 * Collapse one day's raw call-ledger rows (scripts/lib/provider-telemetry.js)
 * into one row per (provider, workflow, script, fn) with call count + summed
 * credits (S0-T6).
 *
 * WHY THIS EXISTS: the raw ledger rotates at MAX_LEDGER_LINES (20K) — under a
 * day at unthrottled Scrapingdog volume — so a 7-day attribution window
 * cannot be built by re-reading the raw ledger; it has already rotated past
 * yesterday by the time today's reconciliation runs. This produces the
 * durable daily summary that DOES survive: one row per grouping key per day,
 * written once to data/audit/scraper-spend-daily-agg.jsonl (a separate,
 * NON-rotated file — check-provider-spend.js owns that I/O), idempotently
 * replacing that day's rows on re-run (same pattern as provider-spend-daily.
 * jsonl). No rotation policy is needed here: cardinality is bounded by
 * (day x provider x workflow x script x fn), tiny next to the raw per-call
 * ledger it summarizes.
 *
 * Grouping key is (provider, workflow, script, fn) rather than just provider
 * so the Sprint 3 guard audit and any "which caller costs the most" query can
 * still be answered from the aggregate after the raw rows are gone. Rows from
 * a local/launchd run (no GITHUB_WORKFLOW) carry workflow: null and do NOT
 * merge with a CI row for the same script — that's a distinct row on
 * purpose, not a bug: null and any real workflow name should stay two
 * different call paths for the same script, not be conflated.
 *
 * @param {Array<Object>} ledgerRecords - raw parsed ledger lines
 * @param {string} day - "YYYY-MM-DD" UTC
 * @returns {Array<{day, provider, workflow, script, fn, calls, credits}>}
 *   sorted by credits descending (most expensive grouping first), so a
 *   --dry-run print or digest line can just take the head of the list.
 */
function aggregateLedgerByDay(ledgerRecords, day) {
  const groups = {};
  for (const r of ledgerRecords || []) {
    if (!r || typeof r.ts !== 'string' || r.ts.slice(0, 10) !== day) continue;
    const workflow = r.workflow || null;
    const script = r.script || 'unknown';
    const fn = r.fn || 'unknown';
    const key = `${r.provider}|${workflow}|${script}|${fn}`;
    if (!groups[key]) groups[key] = { day, provider: r.provider, workflow, script, fn, calls: 0, credits: 0 };
    groups[key].calls += 1;
    groups[key].credits += typeof r.credits === 'number' && Number.isFinite(r.credits) ? r.credits : 0;
  }
  return Object.values(groups).sort((a, b) => b.credits - a.credits
    || b.calls - a.calls
    || a.provider.localeCompare(b.provider)
    || a.script.localeCompare(b.script));
}

module.exports = {
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot,
  utcYesterday, isNextUtcDay, aggregateLedgerByDay, BB_COST_PER_SESSION,
};
