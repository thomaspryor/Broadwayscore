'use strict';

/**
 * model-quality-scorecard.js (BRO-8289): pure logic for scripts/model-quality-scorecard.js.
 *
 * Owner condition on the Sonnet default (BRO-8278 option A): "measure the impact so the site isn't
 * getting worse and things are still fixed well". This compares ALL landed work in a baseline window
 * (the 28 days before the switch) with the window after it. The primary verdict compares whole windows,
 * not Sonnet-vs-Opus sessions, because Opus keeps the hard cards (P0, architecture, shared infra,
 * scoring) after the switch: a per-family split would measure task mix, not model quality. The family
 * table is informational.
 *
 * Inputs are local ledgers only (landings.jsonl, claude-session-cost.jsonl) plus an optional list of
 * card reopen events from Linear. Nothing here reads the network or writes.
 */

const { modelFamily, summarizeCost } = require('./claude-session-cost.js');

const DAY_MS = 86400 * 1000;

// ---- Thresholds (the regression rule; change here and nowhere else) -------------------------------
const THRESHOLDS = {
  baselineDays: 28,
  /** Fewer landed changes than this in a window = INSUFFICIENT DATA, never OK. */
  minLandedAfter: 15,
  minLandedBaseline: 15,
  /** The after window must also span this many days, so one busy day cannot give an OK. */
  minAfterDays: 7,
  /** A landing of a card that already landed 6h-7d earlier is rework (a follow-up fix). */
  reworkWindowDays: 7,
  reworkMinGapHours: 6,
  /** WORSE when after-rate > ratio x baseline-rate AND the after-rate is at least the floor. */
  reworkRatio: 1.5, reworkFloor: 0.05,
  /** Extra land attempts per landed change (a refused or red run that was pushed again). */
  retryRatio: 1.5, retryFloor: 0.10,
  /** Revert landings (branch name has "revert") per landed change. */
  revertRatio: 2, revertFloor: 0.02,
  /** Cards reopened after Done, per landed change; needs this many reopens after the switch. */
  reopenRatio: 2, reopenMinCount: 3, reopenFloor: 0.02,
};

function cardOfBranch(branch) {
  const m = String(branch || '').match(/(?:^|[/-])bro-(\d+)\b/i);
  return m ? `BRO-${m[1]}` : null;
}

/** PURE. Landings rows -> rows in [startMs, endMs) with card + ms. */
function landingsInWindow(landings, startMs, endMs) {
  const out = [];
  for (const r of landings || []) {
    const ms = Date.parse(r && r.ts);
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    out.push({ ms, card: cardOfBranch(r.branch), branch: String(r.branch || ''), attempts: Number(r.attempts) || 1 });
  }
  return out;
}

/**
 * PURE. Rework + retry + revert counts for the landings in a window. The lookback supplies earlier
 * landings: a landing is rework when the same card landed earlier within the rework window.
 */
function reworkStats(allLandings, startMs, endMs, t = THRESHOLDS) {
  const win = landingsInWindow(allLandings, startMs, endMs);
  const lookback = landingsInWindow(allLandings, startMs - t.reworkWindowDays * DAY_MS, endMs);
  const byCard = new Map();
  for (const r of lookback) {
    if (!r.card) continue;
    if (!byCard.has(r.card)) byCard.set(r.card, []);
    byCard.get(r.card).push(r.ms);
  }
  let rework = 0;
  let extraAttempts = 0;
  let reverts = 0;
  for (const r of win) {
    if (r.card) {
      const earlier = (byCard.get(r.card) || []).some((ms) => r.ms - ms >= t.reworkMinGapHours * 3600 * 1000 && r.ms - ms <= t.reworkWindowDays * DAY_MS);
      if (earlier) rework += 1;
    }
    extraAttempts += Math.max(0, r.attempts - 1);
    if (/revert/i.test(r.branch)) reverts += 1;
  }
  const n = win.length;
  const rate = (x) => (n ? x / n : null);
  return { landed: n, cards: new Set(win.map((r) => r.card).filter(Boolean)).size, rework, reworkRate: rate(rework), extraAttempts, retryRate: rate(extraAttempts), reverts, revertRate: rate(reverts) };
}

/** PURE. Cost per landed card for a window, whole and by model family (reuses summarizeCost). */
function costStats(sessionRows, endMs, days) {
  const s = summarizeCost(sessionRows, { nowMs: endMs, days });
  const byModel = {};
  for (const [fam, v] of Object.entries(s.byModel)) byModel[fam] = { sessions: v.sessions, usd: v.usd, avgPerSession: v.sessions ? v.usd / v.sessions : null };
  return { totalUsd: s.totalUsd, sessions: s.sessions, cards: s.cards, perCardUsd: s.perCardUsd, byModel };
}

/** PURE. Reopen events [{ ms, card }] in the window; null input = no Linear read. */
function reopenStats(reopens, startMs, endMs, landed) {
  if (!Array.isArray(reopens)) return { available: false, count: null, rate: null };
  const count = reopens.filter((e) => e.ms >= startMs && e.ms < endMs).length;
  return { available: true, count, rate: landed ? count / landed : null };
}

function worse(metric, after, before, ratio, floor) {
  if (after === null || before === null || after < floor) return null;
  // A zero baseline: treat it as floor/ratio so any after-rate over the floor counts as a rise.
  const base = Math.max(before, floor / ratio);
  return after > ratio * base ? { metric, after, before, ratio } : null;
}

/**
 * PURE. The full scorecard.
 * @returns {{verdict:'OK'|'WORSE'|'INSUFFICIENT DATA', reasons:string[], baseline:object, after:object, windows:object}}
 */
function computeScorecard({ sessionRows, landings, reopens = null, switchDate, nowMs = Date.now() }, t = THRESHOLDS) {
  const switchMs = Date.parse(`${switchDate}T00:00:00Z`);
  if (!Number.isFinite(switchMs)) throw new Error(`bad switch date: ${switchDate}`);
  const baseStart = switchMs - t.baselineDays * DAY_MS;
  const afterDays = Math.max(1, Math.ceil((nowMs - switchMs) / DAY_MS));
  const build = (start, end, days) => {
    const r = reworkStats(landings, start, end, t);
    return { ...r, cost: costStats(sessionRows, end - 1, days), reopen: reopenStats(reopens, start, end, r.landed), days };
  };
  const baseline = build(baseStart, switchMs, t.baselineDays);
  const after = build(switchMs, nowMs, afterDays);
  const hits = [
    worse('rework rate', after.reworkRate, baseline.reworkRate, t.reworkRatio, t.reworkFloor),
    worse('extra land attempts per landed change', after.retryRate, baseline.retryRate, t.retryRatio, t.retryFloor),
    worse('revert rate', after.revertRate, baseline.revertRate, t.revertRatio, t.revertFloor),
  ];
  if (after.reopen.available && baseline.reopen.available && after.reopen.count >= t.reopenMinCount) {
    hits.push(worse('cards reopened after Done per landed change', after.reopen.rate, baseline.reopen.rate, t.reopenRatio, t.reopenFloor));
  }
  const reasons = hits.filter(Boolean).map((h) => `${h.metric}: ${(h.after * 100).toFixed(1)}% after vs ${(h.before * 100).toFixed(1)}% baseline (limit ${h.ratio}x)`);
  const spanDays = (nowMs - switchMs) / DAY_MS;
  const enough = after.landed >= t.minLandedAfter && baseline.landed >= t.minLandedBaseline && spanDays >= t.minAfterDays;
  let verdict = 'OK';
  if (!enough) {
    verdict = 'INSUFFICIENT DATA';
    reasons.unshift(`need >=${t.minLandedAfter} landed changes in each window (baseline ${baseline.landed}, after ${after.landed}) and >=${t.minAfterDays} days since the switch (${spanDays.toFixed(1)})`);
  } else if (reasons.length) verdict = 'WORSE';
  return { verdict, reasons, baseline, after, windows: { baselineStart: new Date(baseStart).toISOString().slice(0, 10), switchDate, now: new Date(nowMs).toISOString().slice(0, 10) } };
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(2)}`);

/** PURE. Markdown table for the card comment and the terminal. */
function formatScorecard(sc, { siteHealth = [] } = {}) {
  const b = sc.baseline; const a = sc.after;
  const reo = (w) => (w.reopen.available ? `${w.reopen.count} (${pct(w.reopen.rate)})` : 'n/a (no Linear read)');
  const rows = [
    ['Landed changes', b.landed, a.landed],
    ['Cards landed', b.cards, a.cards],
    ['Cost per landed card', usd(b.cost.perCardUsd), usd(a.cost.perCardUsd)],
    ['Rework (follow-up landing on same card within 7 days)', `${b.rework} (${pct(b.reworkRate)})`, `${a.rework} (${pct(a.reworkRate)})`],
    ['Extra land attempts per landed change', `${b.extraAttempts} (${pct(b.retryRate)})`, `${a.extraAttempts} (${pct(a.retryRate)})`],
    ['Revert landings', `${b.reverts} (${pct(b.revertRate)})`, `${a.reverts} (${pct(a.revertRate)})`],
    ['Cards reopened after Done', reo(b), reo(a)],
  ];
  const lines = [
    `| Metric | Baseline ${sc.windows.baselineStart} to ${sc.windows.switchDate} | After ${sc.windows.switchDate} to ${sc.windows.now} |`,
    '|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    'Recorded sessions by model family (informational; task mix differs):',
  ];
  for (const [label, w] of [['baseline', b], ['after', a]]) {
    const fams = Object.entries(w.cost.byModel).map(([f, v]) => `${f} ${v.sessions} sessions, ${usd(v.avgPerSession)} avg`).join('; ') || 'no recorded sessions';
    lines.push(`- ${label}: ${fams}`);
  }
  if (siteHealth.length) { lines.push('', 'Site health (latest snapshot, not windowed):'); siteHealth.forEach((s) => lines.push(`- ${s}`)); }
  lines.push('', `VERDICT: ${sc.verdict}${sc.reasons.length ? ` - ${sc.reasons.join('; ')}` : ''}`);
  return lines.join('\n');
}

module.exports = { THRESHOLDS, cardOfBranch, landingsInWindow, reworkStats, costStats, reopenStats, computeScorecard, formatScorecard, modelFamily };
