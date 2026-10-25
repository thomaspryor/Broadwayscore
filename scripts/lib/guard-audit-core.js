/**
 * guard-audit-core.js — the spend-guard audit (BRO-3011, spend-guards Sprint 3).
 *
 * Pure: no I/O. scripts/guard-audit.js reads the files and routes alerts.
 *
 * Per guard (one per breaker conditionKey), over the last 7 days:
 *   - trip days, from data/audit/breaker-transitions.jsonl (BRO-3022's per-day
 *     trip TRANSITIONS — alert-ledger.json cannot answer this) via
 *     breaker-transitions.daysTripped, with the reader's integrity flags
 *     OR-ed in (a corrupt/unreadable ledger makes the count a lower bound);
 *   - priced spend during trips: spend-ledger rows on trip days whose
 *     fallback_from is the guard's own skip label (what the trip rerouted),
 *     billed rows only, priced with provider-pricing.usdFor. The spend ledger
 *     keeps ~2 days, so each run's per-day figures are carried forward in the
 *     snapshot (spendByDay) and the 7-day total says where coverage starts;
 *   - cap drift: the ceiling that actually bit (the latest TRIPPED row's
 *     ceiling in the last 14 days, else the state file's when > 0) below 1.5x
 *     the trailing 14-day median demand. Operator pins ('env') are reported,
 *     never flagged. A ceiling of 0 is reported as "breaker effectively off"
 *     (shouldTripBreaker reads 0 as no ceiling) but a one-off 0 on a recovery
 *     row is not drift by itself — BD's opening-window reserve swings 0/250;
 *   - verdict: SHADOW (a '-shadow' key, never a defect) | NO DATA (no rows
 *     ever, or the ledger missing/unreadable — never "0 trips") | DEFECT
 *     (> 2 trip days) | ACCEPTED (> 2 days but provider-spend-thresholds.json
 *     acceptedDailyTrip[provider], owner-accepted) | UNCERTAIN (<= 2 days on a
 *     lower-bound count: never cleared) | OK.
 *
 * Skip labels (fallback-attribution SKIP_REASONS): sd-circuit-breaker →
 * 'sd-breaker', sb-circuit-breaker → 'sb-breaker', the BRIGHTDATA_ZONE web
 * unlocker zone → 'bd-budget' (which ALSO stamps per-run budget skips — said
 * on the line). serp_api1 has no skip label: its spend reads "n/a". A label
 * missing from SKIP_REASONS renders "label not stamped yet". Spend is never
 * summed across guards (the same reroute can follow two trips).
 */
'use strict';

const { daysTripped, rowsForKey, TRIPPED } = require('./breaker-transitions');
const { usdFor } = require('./provider-pricing');
const { SKIP_REASONS } = require('./fallback-attribution');

const WINDOW_DAYS = 7;
const DRIFT_WINDOW_DAYS = 14;
const DEFECT_DAYS = 2; // > this many trip days in the window is a DEFECT
const DRIFT_FACTOR = 1.5;
const MEDIAN_MIN_SAMPLES = 7;
const SPEND_KEEP_DAYS = 14;
const GUARD_KEY_RE = /^(sd|sb|bd)-circuit-breaker(?:-(.+))?$/;

/** Guards reported even with no history, so silence reads as NO DATA, not OK. */
function expectedGuards(bdZone = 'web_unlocker2') {
  return ['sd-circuit-breaker', `bd-circuit-breaker-${bdZone}`, 'bd-circuit-breaker-serp_api1', 'sb-circuit-breaker'];
}

function dayAdd(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** {provider, shadow, zone, alertKey} for a breaker conditionKey, or null. */
function describeGuard(key) {
  const m = GUARD_KEY_RE.exec(String(key || ''));
  if (!m) return null;
  const provider = { sd: 'scrapingdog', sb: 'scrapingbee', bd: 'brightdata' }[m[1]];
  const suffix = m[2] || null;
  const shadow = suffix === 'shadow';
  const zone = m[1] === 'bd' ? suffix : null;
  // Alert keys deliberately avoid the 'circuit-breaker' substring so
  // owner-alert-router's NEVER_QUIET_CONDITION_RE does not apply: this is a
  // weekly-cadence finding with its own 168h cooldown.
  const alertKey = `guard-audit:${m[1]}${zone ? `-${zone}` : ''}${shadow ? '-shadow' : ''}`;
  return { provider, shadow, zone, alertKey };
}

/** The fallback_from label a trip of this guard stamps on rerouted calls, or null. */
function skipLabelFor(key, bdZone = 'web_unlocker2') {
  const g = describeGuard(key);
  if (!g) return null;
  if (g.provider === 'scrapingdog') return 'sd-breaker';
  if (g.provider === 'scrapingbee') return 'sb-breaker';
  if (g.provider === 'brightdata' && g.zone === bdZone) return 'bd-budget';
  return null;
}

/** Demand series for drift: provider-spend-daily rows → [{day, value}] (clean, deduped by day). */
function demandSeries(dailyRows, guard) {
  const g = describeGuard(guard);
  if (!g) return [];
  const byDay = new Map();
  for (const r of Array.isArray(dailyRows) ? dailyRows : []) {
    const p = r && r.providers && r.providers[g.provider];
    if (!r || typeof r.day !== 'string' || !p || p.status !== 'ok') continue;
    let v;
    if (g.provider === 'brightdata') {
      v = g.zone && /serp/.test(g.zone) ? p.serpReqs : p.unlockerReqs;
    } else {
      if (Number.isFinite(p.cap) && Number.isFinite(p.cycleUsed) && p.cycleUsed >= p.cap) continue; // exhausted pack
      v = p.dayCredits;
    }
    if (!Number.isFinite(v)) continue;
    const prev = byDay.get(r.day);
    if (!prev || String(r.capturedAt || '') >= String(prev.capturedAt || '')) byDay.set(r.day, { capturedAt: r.capturedAt, v });
  }
  return [...byDay.entries()].map(([day, x]) => ({ day, value: x.v }));
}

// Days strictly BEFORE untilDay (today is partial), matching
// scrapingbee-caps.trailingMedianDayCredits.
function medianOver(series, untilDay, days = DRIFT_WINDOW_DAYS) {
  const since = dayAdd(untilDay, -days);
  const vals = series.filter((s) => s.day >= since && s.day < untilDay).map((s) => s.value).sort((a, b) => a - b);
  if (vals.length < MEDIAN_MIN_SAMPLES) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

/**
 * The ceiling that bit: latest TRIPPED transition row for the key in the
 * drift window, else the state file's ceiling when > 0.
 * @returns {{ceiling: number|null, source: string|null, from: 'trip-row'|'state'|null, currentZero: boolean}}
 */
function effectiveCeiling(key, transitionRows, state, untilDay) {
  const since = dayAdd(untilDay, -(DRIFT_WINDOW_DAYS - 1));
  const trips = rowsForKey(transitionRows || [], key)
    .filter((r) => r.to === TRIPPED && String(r.day || r.ts || '').slice(0, 10) >= since && Number.isFinite(r.ceiling));
  const currentZero = Boolean(state && state.ceiling === 0);
  if (trips.length) {
    const last = trips[trips.length - 1];
    return { ceiling: last.ceiling, source: last.ceilingSource || null, from: 'trip-row', currentZero };
  }
  if (state && Number.isFinite(state.ceiling) && state.ceiling > 0) {
    return { ceiling: state.ceiling, source: state.ceilingSource || null, from: 'state', currentZero };
  }
  return { ceiling: null, source: state ? state.ceilingSource || null : null, from: null, currentZero };
}

function capDrift(key, { transitionRows, state, dailyRows, untilDay }) {
  const eff = effectiveCeiling(key, transitionRows, state, untilDay);
  const median = medianOver(demandSeries(dailyRows, key), untilDay);
  const out = { ...eff, median14d: median, drift: false, note: null };
  // A breaker that is not enforcing (BRO-3010's shadow mode) blocks nothing,
  // so its ceiling cannot be drift worth an alert.
  if (state && (state.shadow === true || state.enforce === false)) { out.note = 'not enforcing (shadow)'; return out; }
  if (eff.ceiling == null || median == null) { out.note = 'n/a'; return out; }
  if (eff.source === 'env') { out.note = 'operator pin (not flagged)'; return out; }
  out.drift = eff.ceiling < DRIFT_FACTOR * median;
  return out;
}

/**
 * Billed spend per day per guard from spend-ledger rows. Pure.
 * @returns {Object<string, Object<string, {usd: number, rows: number, unpriced: number}>>}
 */
function spendByDayFromLedger(ledgerRows, guards, days, { bdZone = 'web_unlocker2', pricing } = {}) {
  const wanted = new Set(days);
  const out = {};
  const labelToGuard = new Map();
  for (const k of guards) {
    const label = skipLabelFor(k, bdZone);
    if (label && SKIP_REASONS.has(label)) labelToGuard.set(label, k);
  }
  for (const r of Array.isArray(ledgerRows) ? ledgerRows : []) {
    if (!r || r.success === false) continue; // not billed
    const day = String(r.ts || '').slice(0, 10);
    if (!wanted.has(day)) continue;
    const guard = labelToGuard.get(r.fallback_from);
    if (!guard) continue;
    out[day] = out[day] || {};
    const cell = out[day][guard] = out[day][guard] || { usd: 0, rows: 0, unpriced: 0 };
    cell.rows++;
    const units = r.provider === 'brightdata' ? 1 : Number(r.credits);
    try {
      if (!Number.isFinite(units)) throw new Error('no units');
      cell.usd += pricing ? usdFor(r.provider, units, pricing) : usdFor(r.provider, units);
    } catch {
      cell.unpriced++;
    }
  }
  for (const d of Object.keys(out)) for (const g of Object.keys(out[d])) out[d][g].usd = Math.round(out[d][g].usd * 10000) / 10000;
  return out;
}

/**
 * Merge this run's ledger-derived spend into the carried-forward history.
 * A day is COMPLETE only when the ledger starts before that day's 00:00Z and
 * the run is after that day ends; a complete stored day wins over a recount
 * (the ledger may since have rotated part of it away); a partial stored day is
 * always recomputed.
 */
function mergeSpendHistory(prevByDay, freshByDay, { ledgerStartTs, nowIso, untilDay, guards }) {
  const keepSince = dayAdd(untilDay, -(SPEND_KEEP_DAYS - 1));
  const merged = {};
  const days = new Set([...Object.keys(prevByDay || {}), ...Object.keys(freshByDay || {})]);
  const nowDay = String(nowIso).slice(0, 10);
  for (const d of [...days, ...Array.from({ length: WINDOW_DAYS }, (_, k) => dayAdd(untilDay, -k))]) {
    if (d < keepSince || d > untilDay) continue;
    const prev = prevByDay && prevByDay[d];
    const coveredWhole = ledgerStartTs != null && String(ledgerStartTs) < `${d}T00:00:00` && d < nowDay;
    if (prev && !prev.partial) { merged[d] = prev; continue; }
    const covered = ledgerStartTs != null && String(ledgerStartTs).slice(0, 10) <= d;
    if (!covered && !prev) continue;
    if (!covered) { merged[d] = prev; continue; }
    const cells = {};
    for (const g of guards) {
      const fresh = freshByDay[d] && freshByDay[d][g];
      const stored = prev && prev.guards && prev.guards[g];
      // The spend ledger is trimmed by line count, so its start drifts later
      // through the day: a recount of a partial day can see FEWER rows than
      // the stored partial. Keep whichever saw more (review finding).
      const pick = stored && (!fresh || stored.rows > fresh.rows) ? stored : fresh;
      if (pick) cells[g] = pick;
    }
    merged[d] = { partial: !coveredWhole, guards: cells };
  }
  return merged;
}

function verdictFor({ shadow, hasHistory, ledgerOk, days, lowerBound, accepted }) {
  if (shadow) return 'SHADOW';
  if (!ledgerOk || !hasHistory) return 'NO DATA';
  if (days > DEFECT_DAYS) return accepted ? 'ACCEPTED' : 'DEFECT';
  if (lowerBound) return 'UNCERTAIN';
  return 'OK';
}

/**
 * The whole audit. Inputs are already-read data; returns the snapshot.
 * @param {object} p
 * @param {{rows: object[], corruptLines: number, missing: boolean, unreadable: boolean}} p.ledger  breaker-transitions.readLedger
 * @param {object[]} p.spendRows  scraper-spend-ledger rows
 * @param {object[]} p.dailyRows  provider-spend-daily rows
 * @param {Object<string, object|null>} p.states  conditionKey → state file object (BD zones may share one)
 * @param {object} p.thresholds  provider-spend-thresholds.json
 * @param {object|null} p.prevSnapshot  last guard-audit-snapshot.json
 * @param {string} p.nowIso
 */
function runGuardAudit({ ledger, spendRows, dailyRows, states = {}, thresholds = {}, prevSnapshot = null, nowIso, bdZone = 'web_unlocker2', pricing } = {}) {
  const untilDay = String(nowIso).slice(0, 10);
  const sinceDay = dayAdd(untilDay, -(WINDOW_DAYS - 1));
  const rows = (ledger && ledger.rows) || [];
  const ledgerOk = Boolean(ledger) && !ledger.missing && !ledger.unreadable;
  const seen = new Set(rows.map((r) => r.conditionKey).filter((k) => GUARD_KEY_RE.test(k)));
  const guards = [...new Set([...expectedGuards(bdZone), ...seen])].sort();
  const accepted = (thresholds && thresholds.acceptedDailyTrip) || {};

  const windowDays = Array.from({ length: SPEND_KEEP_DAYS }, (_, k) => dayAdd(untilDay, -k));
  const fresh = spendByDayFromLedger(spendRows, guards, windowDays, { bdZone, pricing });
  const ledgerStartTs = (Array.isArray(spendRows) && spendRows.length)
    ? spendRows.reduce((m, r) => (r && r.ts && (!m || r.ts < m) ? r.ts : m), null) : null;
  const spendByDay = mergeSpendHistory(prevSnapshot && prevSnapshot.spendByDay, fresh, { ledgerStartTs, nowIso, untilDay, guards });
  const coveredDays = Object.keys(spendByDay).filter((d) => d >= sinceDay).sort();
  const partialSince = coveredDays.length && coveredDays[0] > sinceDay ? coveredDays[0] : (coveredDays.length ? null : untilDay);

  const results = guards.map((key) => {
    const g = describeGuard(key);
    const audit = daysTripped(rows, { conditionKey: key, sinceDay, untilDay });
    const lowerBound = audit.lowerBound || (ledger && ledger.corruptLines > 0) || false;
    const hasHistory = rowsForKey(rows, key).length > 0;
    const label = skipLabelFor(key, bdZone);
    let spend;
    if (!label) spend = { note: 'n/a (no skip label)' };
    else if (!SKIP_REASONS.has(label)) spend = { note: `label '${label}' not stamped yet` };
    else {
      let usd = 0; let rowsN = 0; let unpriced = 0;
      for (const d of audit.dayList) {
        const cell = spendByDay[d] && spendByDay[d].guards && spendByDay[d].guards[key];
        if (cell) { usd += cell.usd; rowsN += cell.rows; unpriced += cell.unpriced; }
      }
      spend = { usd: Math.round(usd * 100) / 100, rows: rowsN, unpriced, label, partialSince,
        caveat: label === 'bd-budget' ? "'bd-budget' also marks per-run budget skips" : null };
    }
    const drift = capDrift(key, { transitionRows: rows, state: states[key] || null, dailyRows, untilDay });
    const verdict = verdictFor({ shadow: g.shadow, hasHistory, ledgerOk, days: audit.days, lowerBound, accepted: accepted[g.provider] === true });
    return {
      key, alertKey: g.alertKey, provider: g.provider, shadow: g.shadow,
      verdict, days: audit.days, dayList: audit.dayList, lowerBound, spend, drift,
    };
  });

  return renderGuardAudit(results, { nowIso, sinceDay, untilDay, spendByDay, ledgerOk });
}

function describeLine(r) {
  const daysTxt = r.verdict === 'NO DATA' ? 'no data' : `${r.lowerBound ? 'at least ' : ''}${r.days} trip day(s)`;
  const spend = r.spend.note ? `spend ${r.spend.note}`
    : `rerouted spend on trip days $${r.spend.usd.toFixed(2)} (${r.spend.rows} rows${r.spend.partialSince ? `, data since ${r.spend.partialSince}` : ''}${r.spend.unpriced ? `, ${r.spend.unpriced} unpriced` : ''})${r.spend.caveat ? ` — ${r.spend.caveat}` : ''}`;
  let drift = '';
  if (r.drift.drift) drift = ` · CAP DRIFT: ceiling ${r.drift.ceiling} (${r.drift.source || 'unknown'}) < 1.5x 14-day median ${r.drift.median14d}`;
  if (r.drift.currentZero) drift += ' · ceiling is 0 right now (breaker effectively off)';
  return `${r.verdict}: ${daysTxt}; ${spend}${drift}`;
}

/** Snapshot shape: digest-snapshots/renderNamedDigestBlock (bannerText + items). */
function renderGuardAudit(results, { nowIso, sinceDay, untilDay, spendByDay, ledgerOk }) {
  const defects = results.filter((r) => r.verdict === 'DEFECT').map((r) => r.key);
  const drifts = results.filter((r) => r.drift.drift && !r.shadow).map((r) => r.key);
  const items = results.map((r) => ({ title: r.key, detail: describeLine(r) }));
  const bannerText = !ledgerOk
    ? 'Spend guard audit (last 7 days): breaker transition ledger missing or unreadable — no verdicts.'
    : defects.length || drifts.length
      ? `Spend guard audit (last 7 days): ${defects.length} defect(s)${drifts.length ? `, ${drifts.length} cap drift(s)` : ''}.`
      : 'Spend guard audit (last 7 days): no defects.';
  return {
    generatedAt: nowIso,
    window: { since: sinceDay, until: untilDay },
    bannerText,
    items,
    defects,
    drifts,
    guards: results,
    spendByDay,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** HTML section for the weekly scraper cost report. */
function renderGuardAuditHtml(snapshot) {
  const rows = (snapshot.items || []).map((it) => `<tr><td style="padding:2px 8px 2px 0;white-space:nowrap">${escapeHtml(it.title)}</td><td style="padding:2px 0">${escapeHtml(it.detail)}</td></tr>`).join('');
  return `<p style="margin:0 0 6px 0">${escapeHtml(snapshot.bannerText)}</p><table style="font-size:12px;border-collapse:collapse">${rows}</table>`;
}

module.exports = {
  WINDOW_DAYS,
  DEFECT_DAYS,
  DRIFT_FACTOR,
  expectedGuards,
  describeGuard,
  skipLabelFor,
  demandSeries,
  effectiveCeiling,
  capDrift,
  spendByDayFromLedger,
  mergeSpendHistory,
  verdictFor,
  runGuardAudit,
  renderGuardAudit,
  renderGuardAuditHtml,
};
