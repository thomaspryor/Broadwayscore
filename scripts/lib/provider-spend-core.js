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
const { resolveMaxSessionsPerDay, activeTier1Boost } = require('./browserbase-caps');
// BRO-3097: which providers' ledger rows get `host` folded into the daily
// aggregate's grouping key — see HOST_DIMENSION_PROVIDERS's own docstring.
const { HOST_DIMENSION_PROVIDERS } = require('./provider-telemetry');

// BRO-3240: BB_COST_PER_SESSION priced Browserbase per SESSION CREATED, but
// Browserbase bills browser-HOURS against a monthly plan, not sessions — real
// sessions are tiny (~0.06-0.2 min each), so the per-session model overstated
// cost ~10x ($6-9/day modeled vs $19.65-27.74/mo actual invoice total) and
// fired the browserbaseDailyUsd digest alarm on phantom spend nearly every
// day. Rates below sourced live from browserbase.com/pricing (Developer plan,
// checked 2026-09-14) and cross-checked against the account's real invoice
// base lines (Sept $19.65, Aug/Jul $20.00 — matches BB_BASE_MONTHLY_USD).
//
// Deliberately NOT quota-gated (no "first 100 browser-hours/mo are free"
// logic): that would require knowing Browserbase's actual billing-cycle
// reset date, and the account's only cumulative usage counter
// (GET /v1/projects/{id}/usage's browserMinutes) is documented
// lifetime-cumulative by health-check.js's own Browserbase check — it never
// resets, so a monthly quota boundary can't be derived from it without an
// unverified assumption. Charging the overage rate on ALL measured minutes
// (never gating out an included allowance) means this model can only ever
// OVER-state cost relative to a quota-aware one — the safe direction for an
// overspend alarm to be wrong in, unlike under-stating it (plan-review
// consensus, BRO-3240).
const BB_BASE_MONTHLY_USD = 20;
const BB_BASE_AMORTIZED_DAYS = 30;
const BB_OVERAGE_PER_BROWSER_HOUR_USD = 0.12;

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
 * Pure Browserbase pricing function, factored out of computeDayRecord so the
 * $ math is independently testable with plain numbers (plan-review finding,
 * BRO-3240) rather than only reachable through the full day-record shape.
 * costBase/costOverage are exposed alongside the summed `cost` so a reader of
 * the ledger/digest can tell a flat subscription day apart from a real
 * overage day, instead of one blended number that reads as "usage-driven"
 * even on a zero-session day.
 * @param {{sessions:number, minutes:number}} bb
 */
function bbCost(bb) {
  const costBase = +(BB_BASE_MONTHLY_USD / BB_BASE_AMORTIZED_DAYS).toFixed(2);
  const costOverage = +((bb.minutes / 60) * BB_OVERAGE_PER_BROWSER_HOUR_USD).toFixed(2);
  return {
    sessions: bb.sessions,
    minutes: +bb.minutes.toFixed(2),
    costBase,
    costOverage,
    cost: +(costBase + costOverage).toFixed(2),
  };
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
function computeDayRecord({ day, bb, bd, sb, sd, prev, readAt = null }) {
  const prevAdjacent = prev && isNextUtcDay(prev.day, day) ? prev : null;
  const rec = { day, providers: {} };

  rec.providers.browserbase = bb == null || typeof bb.minutes !== 'number'
    ? { status: 'unknown' }
    : { status: 'ok', ...bbCost(bb) };

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

  rec.providers.scrapingbee = cycleDelta(sb, prevAdjacent?.providers?.scrapingbee, readAt);
  rec.providers.scrapingdog = cycleDelta(sd, prevAdjacent?.providers?.scrapingdog, readAt);
  // BRO-6646: when each prepaid pack renews, for the exhaustion-pace check.
  // ScrapingBee gives a date; ScrapingDog gives days left (`validity`) as of
  // the reading, so it is counted from the read date, not the record's day.
  const readDay = (readAt || `${day}T00:00:00Z`).slice(0, 10);
  if (sb && sb.renewalDate && rec.providers.scrapingbee.status !== 'unknown') rec.providers.scrapingbee.renewalDate = sb.renewalDate;
  if (sd && typeof sd.daysToRenewal === 'number' && rec.providers.scrapingdog.status !== 'unknown') {
    rec.providers.scrapingdog.renewalDate = sd.daysToRenewal < 0 ? null
      : new Date(Date.parse(`${readDay}T00:00:00Z`) + sd.daysToRenewal * DAY_MS).toISOString().slice(0, 10);
  }
  return rec;
}

// BRO-3023: two cycle readings one calendar day apart are only "a day of usage" when they
// were also sampled about 24h apart. A retimed run (late cron, workflow_dispatch re-run)
// is pro-rated to a 24h rate and flagged `retimed`.
const READ_INTERVAL_TOLERANCE_MS = 6 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// Hours between two readAt stamps, or null when either is unusable (legacy behaviour).
function sampleGapMs(prevReadAt, readAt) {
  const a = Date.parse(prevReadAt);
  const b = Date.parse(readAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return b - a;
}

function cycleDelta(reading, prevEntry, readAt = null) {
  if (reading == null) return { status: 'unknown' };
  const out = { status: 'ok', cycleUsed: reading.cycleUsed, cap: reading.cap ?? reading.limit ?? null };
  if (readAt) out.readAt = readAt;
  const prevCycleUsed = prevEntry && typeof prevEntry.cycleUsed === 'number' ? prevEntry.cycleUsed : null;
  if (prevCycleUsed == null) {
    out.status = 'baseline';
  } else {
    const raw = reading.cycleUsed >= prevCycleUsed
      ? reading.cycleUsed - prevCycleUsed
      : reading.cycleUsed; // counter reset = cycle renewed
    const gap = readAt && prevEntry.readAt ? sampleGapMs(prevEntry.readAt, readAt) : null;
    if (gap != null && Math.abs(gap - DAY_MS) > READ_INTERVAL_TOLERANCE_MS) {
      // Retimed run: pro-rate to a 24h rate instead of hiding the day (a baseline would
      // skip budget breaches, break the streak and cascade into the next run).
      out.dayCredits = Math.round(raw * DAY_MS / gap);
      out.retimed = true;
    } else {
      out.dayCredits = raw;
    }
  }
  return out;
}

/**
 * Compare one day record against thresholds. Unknown providers are breaches of
 * measurability, reported distinctly so the alert says "could not measure X",
 * not "X overspent".
 * @returns {{overspend: string[], unmeasured: string[]}}
 */
function budgetBreaches(record, thresholds, history = []) {
  const overspend = [];
  const unmeasured = [];
  const p = record.providers || {};

  if (p.browserbase?.status === 'ok') {
    if (thresholds.browserbaseDailyUsd != null && p.browserbase.cost > thresholds.browserbaseDailyUsd) {
      overspend.push(`browserbase $${p.browserbase.cost} > $${thresholds.browserbaseDailyUsd} (${p.browserbase.sessions} sessions, ${p.browserbase.minutes}min)`);
    }
  } else unmeasured.push('browserbase');

  if (p.brightdata?.status === 'ok') {
    // BRO-6646: the 7-day average against the daily line, so one busy day
    // (a backfill, an opening night) is not an owner alarm; a sustained rise is.
    const costs = [p.brightdata.cost, ...windowDays(record, history).map((r) => r.providers?.brightdata?.cost).filter((n) => typeof n === 'number')];
    const avg = +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(2);
    if (thresholds.brightdataDailyUsd != null && avg > thresholds.brightdataDailyUsd) {
      overspend.push(`brightdata averaging $${avg}/day over ${costs.length} days > $${thresholds.brightdataDailyUsd} (today $${p.brightdata.cost}: ${p.brightdata.serpReqs} serp + ${p.brightdata.unlockerReqs} unlocker reqs)`);
    }
  } else unmeasured.push('brightdata');

  for (const [key, thKey] of [['scrapingbee', 'scrapingbeeDailyCredits'], ['scrapingdog', 'scrapingdogDailyCredits']]) {
    const entry = p[key];
    if (!entry || entry.status === 'unknown') { unmeasured.push(key); continue; }
    if (entry.status === 'baseline') continue; // measured; delta arrives tomorrow
    const pace = packPaceBreach(key, entry, record, history);
    if (pace !== undefined) { if (pace) overspend.push(pace); continue; }
    if (thresholds[thKey] != null && entry.dayCredits > thresholds[thKey]) {
      overspend.push(`${key} ${entry.dayCredits} credits > ${thresholds[thKey]}`);
    }
  }
  return { overspend, unmeasured };
}

// A renewal further out than this is not a monthly cycle (e.g. an expiry date
// on rolled-over credits), so the pace check would be meaningless.
const MAX_PACE_RENEWAL_DAYS = 40;

// Whole days from `day` to `renewalDate` (both YYYY-MM-DD), or null when either
// is missing or the date has passed (an expired pack is not "renews today").
// Same rule as scrapingbee-caps.js daysToRenewal, which this module cannot
// require (scrapingdog-caps.js requires this file).
function daysToRenewal(renewalDate, day) {
  if (typeof renewalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(renewalDate)) return null;
  const d = Math.round((Date.parse(`${renewalDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(d) && d >= 0 ? d : null;
}
const PACE_WINDOW_DAYS = 7;

/** History records in the PACE_WINDOW_DAYS before `record` (excluding it), day-ascending. */
function windowDays(record, history = []) {
  const from = Date.parse(`${record.day}T00:00:00Z`) - (PACE_WINDOW_DAYS - 1) * DAY_MS;
  return (history || []).filter((r) => r && r.day < record.day && Date.parse(`${r.day}T00:00:00Z`) >= from)
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * BRO-6646: ScrapingBee and ScrapingDog are prepaid credit packs. A busy day
 * (a historical backfill) costs nothing extra; running the pack dry before it
 * renews does. So the alarm is "at the last 7 days' average, the credits left
 * run out before renewal", or "the pack is already empty". Owner, 2026-10-30:
 * the daily-credit line "has just been telling me that the whole time".
 * Returns a breach string, null (pace is fine), or undefined when the pace
 * cannot be judged (no cap or renewal date), so the caller falls back to the
 * daily threshold. Pure.
 */
function packPaceBreach(key, entry, record, history = []) {
  const cap = entry.cap;
  if (typeof cap !== 'number' || cap <= 0 || typeof entry.cycleUsed !== 'number') return undefined;
  if (entry.cycleUsed >= cap) return `${key} pack exhausted (${entry.cycleUsed} of ${cap} credits used)`;
  const readDay = String(entry.readAt || `${record.day}T00:00:00Z`).slice(0, 10);
  const daysLeft = daysToRenewal(entry.renewalDate, readDay);
  if (daysLeft == null || daysLeft > MAX_PACE_RENEWAL_DAYS) return undefined;
  // This cycle's days only: walking back, stop at a counter reset (an earlier
  // day with more credits used than now), or the old cycle's burn would count.
  const credits = [entry.dayCredits];
  let used = entry.cycleUsed;
  for (const r of windowDays(record, history).reverse()) {
    const e = r.providers?.[key];
    if (!e || typeof e.cycleUsed !== 'number' || e.cycleUsed > used) break;
    used = e.cycleUsed;
    if (typeof e.dayCredits === 'number') credits.push(e.dayCredits);
  }
  const avg = credits.reduce((a, b) => a + b, 0) / credits.length;
  const left = cap - entry.cycleUsed;
  const need = Math.round(avg * Math.max(1, daysLeft));
  return need > left
    ? `${key} on pace to run out before renewal: ~${Math.round(avg)} credits/day (${credits.length}-day average) x ${Math.max(1, daysLeft)} days to ${entry.renewalDate} = ${need} > ${left} left`
    : null;
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
    const { overspend, unmeasured } = budgetBreaches(records[i], thresholds, records.slice(0, i));
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

  items.push({ title: `${record.day} · Browserbase: ${fmt(p.browserbase, `$${p.browserbase.cost ?? '?'}`, ` (${p.browserbase.sessions} sessions, ${p.browserbase.minutes}min)`)}` });

  // Cap-exhausted line (Scraping v2 T13). Spend alone can't answer "did the
  // ceiling actually BITE?" — and that is the question the step-down
  // (250 -> 100 -> 60) is gated on. A day that lands under budget because the
  // cap clipped it is NOT a healthy day: work was dropped. Derived from the
  // session count already in the ledger, so there's no new writer to keep
  // in sync. See memory/browserbase-cap-stepdown-runbook.md.
  if (p.browserbase?.status === 'ok' && typeof p.browserbase.sessions === 'number') {
    const used = p.browserbase.sessions;
    // BRO-5243 Tier-1 boost: Tier-1 hosts may pass the bulk ceiling, bulk
    // hosts still stop at it, so a boosted day names both (BRO-5261).
    const boost = activeTier1Boost({ now: new Date(`${record.day}T12:00:00Z`) });
    const boostNote = boost > 0 ? ` (bulk ceiling; Tier-1 boost to ${maxSessionsPerDay + boost} active${used >= maxSessionsPerDay + boost ? ', also exhausted' : ''})` : '';
    if (used >= maxSessionsPerDay) {
      items.push({ title: `⚠️ Browserbase CAP EXHAUSTED: ${used}/${maxSessionsPerDay} sessions${boostNote} — work was dropped, this day does NOT count toward the step-down streak` });
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
 * WHY THIS EXISTS: the raw ledger rotates at MAX_LEDGER_LINES (45K, ~2-3 days) — under a
 * day at unthrottled Scrapingdog volume — so a 7-day attribution window
 * cannot be built by re-reading the raw ledger; it has already rotated past
 * yesterday by the time today's reconciliation runs. This produces the
 * durable daily summary that DOES survive: one row per grouping key per day,
 * written once to data/audit/scraper-spend-daily-agg.jsonl (a separate,
 * NON-rotated file — check-provider-spend.js owns that I/O), idempotently
 * replacing that day's rows on re-run (same pattern as provider-spend-daily.
 * jsonl). No rotation policy is needed here: cardinality is bounded by
 * (day x provider x workflow x script x fn x host x category) — host/
 * category are non-null for exactly one provider today (see
 * HOST_DIMENSION_PROVIDERS below), so this stays tiny next to the raw
 * per-call ledger it summarizes.
 *
 * Grouping key is (provider, workflow, script, fn) rather than just provider
 * so the Sprint 3 guard audit and any "which caller costs the most" query can
 * still be answered from the aggregate after the raw rows are gone. Rows from
 * a local/launchd run (no GITHUB_WORKFLOW) carry workflow: null and do NOT
 * merge with a CI row for the same script — that's a distinct row on
 * purpose, not a bug: null and any real workflow name should stay two
 * different call paths for the same script, not be conflated.
 *
 * BRO-3097 (ship-check finding): the grouping key also splits on `category`
 * ('review-text'|'discovery'|null) and, for HOST_DIMENSION_PROVIDERS members
 * (currently just browserbase), on `host`. Without this the review-text/
 * discovery split BRO-3097 exists to enable would have been lost the moment
 * the raw ledger rotated past a day — this durable aggregate is what
 * actually survives the 7-day window the card's spend decision needs. `host`
 * is scoped to HOST_DIMENSION_PROVIDERS (not every provider) because BD/
 * ScrapingBee/Scrapingdog hit dozens of review-outlet hosts per script —
 * adding host to their grouping key would multiply this file's row count
 * well past the bounded cardinality above, for no attribution question
 * anyone has asked yet.
 *
 * @param {Array<Object>} ledgerRecords - raw parsed ledger lines
 * @param {string} day - "YYYY-MM-DD" UTC
 * @returns {Array<{day, provider, workflow, script, fn, host, category, calls, credits}>}
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
    const host = HOST_DIMENSION_PROVIDERS.has(r.provider) ? (r.host || null) : null;
    const category = r.category || null;
    const key = `${r.provider}|${workflow}|${script}|${fn}|${host}|${category}`;
    if (!groups[key]) groups[key] = { day, provider: r.provider, workflow, script, fn, host, category, calls: 0, credits: 0 };
    groups[key].calls += 1;
    groups[key].credits += typeof r.credits === 'number' && Number.isFinite(r.credits) ? r.credits : 0;
  }
  return Object.values(groups).sort((a, b) => b.credits - a.credits
    || b.calls - a.calls
    || a.provider.localeCompare(b.provider)
    || a.script.localeCompare(b.script));
}

// BRO-3227 (moved here from check-provider-spend.js by BRO-3349): the
// ledger going stale/discontinuous is not itself a spend breach
// (budgetBreaches/computeStreak below only see whatever record THIS run
// produces) — it's a "did prior runs' writes
// actually land?" question, which is exactly what BRO-3317 found silently
// broken for 11 days (a `push-with-retry.sh` hard-reset fallback discarded
// this script's own write, and nothing noticed because the script itself
// kept exiting 0 daily). These thresholds gate a loud, independent check of
// the ledger AS COMMITTED, read before this run contributes anything.
const STALE_HOURS_THRESHOLD = 48;
const CONTINUITY_WINDOW_DAYS = 7;

// "YYYY-MM-DD" only — guards both functions below against a corrupt/
// hand-edited record (e.g. {day: "zzz"} or {day: null}) silently producing
// Invalid Date/NaN math instead of being treated as absent (ship-check
// finding, BRO-3227).
const VALID_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Epoch ms for the END (23:59:59.999 UTC) of a "YYYY-MM-DD" day, or NaN if
 * `day` is not a real calendar date.
 *
 * BRO-3349 (ship-check/Codex P1): VALID_DAY_RE alone is NOT enough. It is a
 * SHAPE check, and shapes like "2026-99-99" pass it while `new Date()` yields
 * Invalid Date. Because the old code picked the lexical max of shape-valid
 * days FIRST and converted second, a single such row outranked every real day
 * and made ledgerFreshnessHours() return NaN — which every caller treats as
 * "no usable data" (a WARN), not as staleness. One garbage row therefore
 * downgraded this dead-man from ERROR to a permanent WARN even with months of
 * real rows present and the reconciliation long dead. Validate the instant,
 * not the shape, and let a bad row lose ONE day rather than the whole check
 * (the same rule readLedger() already applies to unparseable JSON lines).
 * @param {string} day
 * @returns {number}
 */
function dayEndMs(day) {
  if (!VALID_DAY_RE.test(day)) return NaN;
  return new Date(`${day}T23:59:59.999Z`).getTime();
}

/**
 * Hours between `now` and the end (23:59:59.999 UTC) of the ledger's most
 * recent REAL recorded day. Infinity for an empty (or entirely malformed)
 * ledger — no usable data is maximally stale, never "fresh by default".
 * Never NaN: an unreal day is dropped, not propagated.
 * @param {Array<{day: string}>} records
 * @param {Date} [now]
 * @returns {number}
 */
function ledgerFreshnessHours(records, now = new Date()) {
  const ends = (records || []).filter(Boolean).map((r) => dayEndMs(r.day)).filter((ms) => Number.isFinite(ms));
  if (!ends.length) return Infinity;
  return (now.getTime() - Math.max(...ends)) / 3600000;
}

/**
 * The ledger's most recent REAL recorded day ("YYYY-MM-DD"), or null. Shares
 * dayEndMs()'s validity rule so a row's reported `day` can never disagree with
 * the age computed for it.
 * @param {Array<{day: string}>} records
 * @returns {string|null}
 */
function lastLedgerDay(records) {
  let best = null;
  let bestMs = -Infinity;
  for (const r of (records || []).filter(Boolean)) {
    const ms = dayEndMs(r.day);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.day; }
  }
  return best;
}

/**
 * UTC calendar days ("YYYY-MM-DD"), ascending, in the trailing `days`-day
 * window that have no record. The window ends TWO days before `now`, not
 * one: "yesterday" relative to `now` is DAY (utcYesterday(now), the day
 * THIS run's own reconciliation is about to write) — checking for it in the
 * pre-write ledger would report it missing on every single healthy run,
 * since nothing has written it yet at check time (ship-check/Codex P1
 * finding, BRO-3227 — confirmed live: a --dry-run against the real ledger
 * flagged the just-not-yet-written day as "missing" before this fix). The
 * window this function validates is the `days` complete days a healthy
 * ledger should ALREADY contain from prior runs, not the day in flight.
 * @param {Array<{day: string}>} records
 * @param {Date} [now]
 * @param {number} [days]
 * @returns {string[]}
 */
function missingLedgerDays(records, now = new Date(), days = CONTINUITY_WINDOW_DAYS) {
  const present = new Set((records || []).filter(Boolean).map((r) => r.day).filter((d) => VALID_DAY_RE.test(d)));
  const missing = [];
  for (let i = 2; i <= days + 1; i++) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    if (!present.has(d)) missing.push(d);
  }
  return missing.sort();
}

/**
 * BRO-4215: providers whose ledger explained less than `min` of their billed
 * spend on EACH of the last `days` consecutive recorded days. ScrapingBee sat
 * at 12-23% attributed for weeks with only a digest line to show for it
 * (~70% of its credits were Reddit Sentiment rows discarded at runner exit);
 * this turns a sustained gap into an actionable alert instead of a number
 * someone has to notice. A null pct (billing API down / provider idle) breaks
 * the run: an unmeasured day proves nothing either way.
 * @param {Array<{day:string, attributedPct?:Object}>} series day-ascending
 * @returns {Array<{provider:string, pcts:number[]}>}
 */
function attributionGaps(series, { min = 0.8, days = 2, providers = [] } = {}) {
  const sorted = [...(series || [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const recent = sorted.slice(-days);
  if (recent.length < days) return [];
  for (let i = 1; i < recent.length; i++) {
    if (!isNextUtcDay(recent[i - 1].day, recent[i].day)) return [];
  }
  const gaps = [];
  for (const provider of providers) {
    const pcts = recent.map((r) => (r.attributedPct || {})[provider]);
    if (pcts.every((p) => typeof p === 'number' && p < min)) gaps.push({ provider, pcts });
  }
  return gaps;
}

/**
 * BRO-4215: has an attribution gap closed? Same window as attributionGaps:
 * the last `days` recorded days (by date) must be consecutive, measured, and
 * ALL >= min. Shared by check-provider-spend.js (resolveCondition) and
 * check-attribution-gap-clear.js (the card's VERIFY), so the ledger condition
 * and the card cannot disagree (one good day inside a gap resolving the
 * condition would let the next bad pair file a duplicate card).
 * @returns {{verdict:'clear'|'open'|'unverifiable', days:string[], pcts:(number|null)[]}}
 */
function attributionWindowVerdict(series, provider, { min = 0.8, days = 2 } = {}) {
  const sorted = [...(series || [])].filter((r) => r && r.day)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const recent = sorted.slice(-days);
  const pcts = recent.map((r) => { const p = (r.attributedPct || {})[provider]; return typeof p === 'number' ? p : null; });
  const dayList = recent.map((r) => r.day);
  const consecutive = recent.every((r, i) => i === 0 || isNextUtcDay(recent[i - 1].day, r.day));
  if (recent.length < days || !consecutive) return { verdict: 'unverifiable', days: dayList, pcts };
  if (pcts.some((p) => p !== null && p < min)) return { verdict: 'open', days: dayList, pcts };
  if (pcts.some((p) => p === null)) return { verdict: 'unverifiable', days: dayList, pcts };
  return { verdict: 'clear', days: dayList, pcts };
}

module.exports = {
  attributionGaps,
  attributionWindowVerdict,
  computeDayRecord, budgetBreaches, computeStreak, renderSnapshot,
  utcYesterday, isNextUtcDay, aggregateLedgerByDay, bbCost,
  BB_BASE_MONTHLY_USD, BB_BASE_AMORTIZED_DAYS, BB_OVERAGE_PER_BROWSER_HOUR_USD,
  ledgerFreshnessHours, lastLedgerDay, missingLedgerDays, STALE_HOURS_THRESHOLD, CONTINUITY_WINDOW_DAYS,
};
