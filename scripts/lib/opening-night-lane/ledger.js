'use strict';
/**
 * Append-only per-night ledger for the opening-night lane (BRO-4210; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6).
 *
 * One JSON line per state change of one review on one night:
 *   discovered -> fetched -> scored -> rebuilt -> deployed -> verified-live
 * The KPI is time-to-live per review (first `discovered` to first `verified-live`),
 * computed from this file and nothing else. stage-latency.jsonl measured stage
 * latencies; none of it answered "when could a reader see this review".
 *
 * Append-only on purpose: nothing rewrites or deletes a line, so a stage that
 * was reached stays reached, and a crash between stages leaves an honest
 * record. Readers take the FIRST timestamp per (review, stage), so a retry that
 * logs a stage twice cannot move a review's time-to-live. One appendFileSync of
 * a single short line is atomic enough for one writer; the lane is the single
 * writer by design.
 *
 * Pure functions plus one thin fs wrapper. The directory is a parameter: where
 * the ledger lives (repo data dir, runner temp, a fixture dir) is the caller's
 * decision.
 */
const fs = require('fs');
const path = require('path');

const STAGES = ['discovered', 'fetched', 'scored', 'rebuilt', 'deployed', 'verified-live'];
const DEFAULT_MAX_MS = 20 * 60 * 1000; // first acceptance bar: URL seen to live in under 20 minutes

function ledgerPath(dir, show, night) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show || ''))) throw new Error(`ledger: bad show id "${show}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(night || ''))) throw new Error(`ledger: bad night "${night}" (want YYYY-MM-DD)`);
  return path.join(dir, `${show}-${night}.jsonl`);
}

/** Validate and normalise one event. Throws on anything that would make the ledger ambiguous. */
function buildEvent({ show, night, reviewKey, stage, at, meta } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`ledger: unknown stage "${stage}"`);
  if (!reviewKey || typeof reviewKey !== 'string') throw new Error('ledger: reviewKey is required (the review URL, normalised by the caller)');
  if (at === null) throw new Error('ledger: bad timestamp "null"');
  const ts = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(ts.getTime())) throw new Error(`ledger: bad timestamp "${at}"`);
  ledgerPath('.', show, night); // validates show and night
  const ev = { show, night, reviewKey, stage, at: ts.toISOString() };
  if (meta && typeof meta === 'object' && Object.keys(meta).length) ev.meta = meta;
  return ev;
}

function appendEvent(dir, input) {
  const ev = buildEvent(input);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath(dir, ev.show, ev.night), `${JSON.stringify(ev)}\n`);
  return ev;
}

/** Parse ledger text. Corrupt lines are counted, never thrown on: a half-written last line must not hide the rest. */
function parseLedger(text) {
  const events = [];
  let corrupt = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && STAGES.includes(ev.stage) && ev.reviewKey && !Number.isNaN(Date.parse(ev.at))) events.push(ev);
      else corrupt++;
    } catch { corrupt++; }
  }
  return { events, corrupt };
}

function readLedger(dir, show, night) {
  try {
    // A line for another show or night does not belong to this file: count it, never merge it in.
    const parsed = parseLedger(fs.readFileSync(ledgerPath(dir, show, night), 'utf8'));
    const events = parsed.events.filter((e) => e.show === show && e.night === night);
    return { events, corrupt: parsed.corrupt + (parsed.events.length - events.length) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { events: [], corrupt: 0 };
    throw e;
  }
}

/** Per-review view: first timestamp of each stage, last stage reached, time to live. Pure. */
function reviewStates(events) {
  const byKey = new Map();
  for (const ev of events || []) {
    let r = byKey.get(ev.reviewKey);
    if (!r) { r = { reviewKey: ev.reviewKey, firstAt: {}, manual: false }; byKey.set(ev.reviewKey, r); }
    const t = Date.parse(ev.at);
    if (!(ev.stage in r.firstAt) || t < Date.parse(r.firstAt[ev.stage])) r.firstAt[ev.stage] = ev.at;
    if (ev.meta && ev.meta.manual === true) r.manual = true;
  }
  return [...byKey.values()].map((r) => {
    const reached = STAGES.filter((s) => s in r.firstAt);
    const seen = r.firstAt.discovered;
    const live = r.firstAt['verified-live'];
    return {
      reviewKey: r.reviewKey,
      firstAt: r.firstAt,
      lastStage: reached.length ? reached[reached.length - 1] : null,
      // A review that skipped a stage is a ledger bug the caller must see, not a smaller number.
      skipped: STAGES.slice(0, STAGES.indexOf(reached[reached.length - 1]) + 1).filter((s) => !(s in r.firstAt)),
      manual: r.manual,
      ttlMs: seen && live ? Date.parse(live) - Date.parse(seen) : null,
      // verified-live stamped before discovered means two clocks disagree; never read it as a fast review.
      clockSkew: !!(seen && live && Date.parse(live) < Date.parse(seen)),
    };
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Night summary: how many reviews are live, time-to-live distribution, what is still pending and where. Pure. */
function summarize(events) {
  const reviews = reviewStates(events);
  const ttls = reviews.map((r) => r.ttlMs).filter((v) => v !== null && v >= 0).sort((a, b) => a - b);
  return {
    total: reviews.length,
    live: reviews.filter((r) => r.ttlMs !== null && !r.clockSkew).length,
    skewed: reviews.filter((r) => r.clockSkew).map((r) => r.reviewKey),
    medianMs: percentile(ttls, 50),
    p90Ms: percentile(ttls, 90),
    maxMs: ttls.length ? ttls[ttls.length - 1] : null,
    pending: reviews.filter((r) => r.ttlMs === null).map((r) => ({ reviewKey: r.reviewKey, lastStage: r.lastStage })),
    reviews,
  };
}

/**
 * The first acceptance bar, as a verdict: every expected review reached verified-live, each within
 * maxMs of being seen, with zero manual steps and no skipped stage. `expectedKeys` is the fixture's
 * review list; a review the lane never logged at all is a failure, not a silent omission. Pure.
 */
function rehearsalVerdict(events, { expectedKeys, maxMs = DEFAULT_MAX_MS, corrupt = 0 } = {}) {
  if (!Array.isArray(expectedKeys) || !expectedKeys.length) throw new Error('rehearsalVerdict: expectedKeys is required');
  const byKey = new Map(reviewStates(events).map((r) => [r.reviewKey, r]));
  const failures = [];
  // A damaged ledger line may have held a manual step or a stage; a rehearsal cannot pass over it.
  if (corrupt > 0) failures.push({ reviewKey: null, reason: 'corrupt-lines', detail: corrupt });
  for (const key of expectedKeys) {
    const r = byKey.get(key);
    if (!r) { failures.push({ reviewKey: key, reason: 'never-logged' }); continue; }
    if (r.skipped.length) failures.push({ reviewKey: key, reason: 'skipped-stage', detail: r.skipped });
    if (r.ttlMs === null) failures.push({ reviewKey: key, reason: 'not-live', detail: r.lastStage });
    else if (r.clockSkew) failures.push({ reviewKey: key, reason: 'negative-ttl', detail: r.ttlMs });
    else if (r.ttlMs > maxMs) failures.push({ reviewKey: key, reason: 'too-slow', detail: r.ttlMs });
    if (r.manual) failures.push({ reviewKey: key, reason: 'manual-step' });
  }
  return { pass: failures.length === 0, failures, checked: expectedKeys.length };
}

module.exports = { STAGES, DEFAULT_MAX_MS, ledgerPath, buildEvent, appendEvent, parseLedger, readLedger, reviewStates, summarize, rehearsalVerdict };
