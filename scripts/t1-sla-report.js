#!/usr/bin/env node
'use strict';

/**
 * t1-sla-report.js — THE metric (sprint-plan-t1-retrieval.md S2-T8).
 *
 * Trailing-14d, measured at T+48h: of the T1 reviews we EVENTUALLY scored, what % were
 * scored within 24h of when they first became retrievable (clock = max(publishDate,
 * showCreatedAt))? Reviews with a suspect publishDate land in the unmeasurable bucket
 * and never enter the denominator (S2-T6).
 *
 * Data join (no new collection):
 *   • scoredAt  ← earliest `scored` stage in data/audit/stage-latency.jsonl (reviewKey)
 *   • firstSeen ← earliest `review-first-seen`/`review-text-collected` stage (for the
 *                 provenance suspect check), else the review file's firstSeenAt
 *   • publishDate + tier ← reviews.json (outletId → outlet-registry tier)
 *   • showCreatedAt ← shows.json discoveredAt
 *
 * Usage: node scripts/t1-sla-report.js [--days=14] [--tier=1] [--json]
 */

const fs = require('fs');
const path = require('path');
const { computeSla } = require('./lib/t1-sla');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATENCY_LOG = path.join(DATA_DIR, 'audit', 'stage-latency.jsonl');

function load(f) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }

function main() {
  const args = process.argv.slice(2);
  const days = parseInt((args.find(a => a.startsWith('--days=')) || '--days=14').split('=')[1], 10);
  const tier = parseInt((args.find(a => a.startsWith('--tier=')) || '--tier=1').split('=')[1], 10);
  const asJson = args.includes('--json');

  const reviews = (load('reviews.json').reviews) || [];
  const shows = (load('shows.json').shows) || [];
  const registry = load('outlet-registry.json').outlets || load('outlet-registry.json');

  const discoveredAt = new Map(shows.map(s => [(s.id || s.slug), s.discoveredAt || s.previewsStartDate || s.openingDate || null]));
  const tierOf = (oid) => (registry[oid] && registry[oid].tier) || null;

  // Index reviews by (showId, outletId, normalized-url) for the reviewKey join.
  const normUrl = (u) => (u || '').split('?')[0].replace(/\/$/, '').toLowerCase();
  const revByKey = new Map();
  for (const r of reviews) {
    revByKey.set(`${r.showId}|${r.outletId}|${normUrl(r.url)}`, r);
  }

  // Earliest scored + firstSeen timestamp per (showId, reviewKey).
  const scoredAt = new Map();
  const seenAt = new Map();
  if (fs.existsSync(LATENCY_LOG)) {
    for (const line of fs.readFileSync(LATENCY_LOG, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e.reviewKey || !e.showId || !e.at) continue;
      const k = `${e.showId}||${e.reviewKey}`;
      if (e.stage === 'scored') { if (!scoredAt.has(k) || e.at < scoredAt.get(k)) scoredAt.set(k, e.at); }
      else if (e.stage === 'review-first-seen' || e.stage === 'review-text-collected') {
        if (!seenAt.has(k) || e.at < seenAt.get(k)) seenAt.set(k, e.at);
      }
    }
  }

  const now = Date.now();
  // Window + maturity are keyed off the SHOW's opening, not scoring activity: the SLA
  // is about opening-night RETRIEVAL, so we measure reviews for shows that opened in
  // the trailing window and are mature (≥48h old, so late T1s have had time). This
  // deliberately excludes bulk rescores of ancient reviews (whose recent scoredAt vs
  // months-old clockStart would read as a 0% breach and swamp the real signal).
  const openMs = new Map(shows.map(s => [(s.id || s.slug), Date.parse((s.openingDate || s.previewsStartDate || '') + 'T23:00:00-04:00')]));
  const windowStart = now - days * 86400000;
  const maturity = now - 48 * 3600000;
  const rows = [];
  for (const [k, sAt] of scoredAt) {
    const [showId, reviewKey] = k.split('||');
    const oMs = openMs.get(showId);
    if (!Number.isFinite(oMs) || oMs < windowStart || oMs > maturity) continue; // opened in [window, T-48h]
    const outletId = reviewKey.split(':')[0];
    const url = reviewKey.split(':').slice(2).join(':');          // outletId:critic:url
    const rev = revByKey.get(`${showId}|${outletId}|${normUrl(url)}`);
    rows.push({
      showId, outletId,
      tier: tierOf(outletId),
      publishDate: rev ? rev.publishDate : null,
      firstSeenAt: seenAt.get(k) || (rev && rev.firstSeenAt) || sAt,
      scoredAt: sAt,
      showCreatedAt: discoveredAt.get(showId),
    });
  }

  const sla = computeSla(rows, { withinHours: 24, tierFilter: (t) => t === tier });
  const out = {
    windowDays: days, tier, measuredAt: new Date(now).toISOString(),
    ...sla,
  };
  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`\n=== T1 Retrieval SLA (trailing ${days}d, tier ${tier}) ===`);
  console.log(`Measured (eventually-scored, measurable): ${sla.measured}`);
  console.log(`Within 24h of clock start:                ${sla.withinSla}`);
  console.log(`SLA: ${sla.pct == null ? 'n/a (no measurable reviews in window)' : sla.pct + '%'}`);
  console.log(`Unmeasurable (suspect/no publishDate):     ${sla.unmeasurable}`);
  console.log(`Not-yet-scored in window:                  ${sla.unscored}`);
  if (sla.unmeasurableSample.length) {
    console.log(`Unmeasurable sample: ${sla.unmeasurableSample.slice(0, 8).map(u => `${u.outletId}(${u.reason})`).join(', ')}`);
  }
  const byReason = sla.unmeasurableByReason || {};
  if (Object.keys(byReason).length) {
    const parts = Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`);
    console.log(`Unmeasurable by reason: ${parts.join(', ')}`);
  }
  const blindByPrecision = (byReason['date-only-publish-date'] || 0) + (byReason['shared-roundup-timestamp'] || 0);
  if (blindByPrecision) {
    console.log(`\n⚠ ${blindByPrecision} review(s) carry no usable publication CLOCK, so a 24h SLA`);
    console.log(`  cannot be computed for them. They are excluded, NOT counted as breaches:`);
    console.log(`   • date-only-publish-date  — day-resolution date; its clock start is midnight`);
    console.log(`     UTC, but reviews drop in the evening, so a review scored the SAME NIGHT`);
    console.log(`     measures ~26h. The imprecision (±24h) exceeds the threshold (24h).`);
    console.log(`   • shared-roundup-timestamp — an HH:MM stamp shared by 2+ outlets of one show`);
    console.log(`     (roundup bleed: one aggregator page's datePublished copied onto every`);
    console.log(`     review extracted from it). Two outlets never publish in the same second.`);
    console.log(`  To make these measurable, capture per-article publication times at COLLECTION`);
    console.log(`  (JSON-LD datePublished, stamped with publishDateSource) — not at report time.`);
  }
  // "n/a" must not be misread as "healthy". This metric only ever sees reviews that were
  // eventually SCORED — a review nobody discovered has no row here at all, so a coverage
  // gap is invisible to it by construction. Say so, rather than letting an empty
  // denominator pass for a clean bill of health.
  if (sla.measured === 0) {
    console.log(`\nNOTE: "n/a" is not "on time". This metric only covers reviews that were`);
    console.log(`  eventually scored — a review never discovered has no row here at all, so a`);
    console.log(`  coverage gap cannot show up in this number. Coverage (did we find every`);
    console.log(`  review?) is audit-opening-night-coverage.js. Timeliness of the reviews we`);
    console.log(`  DID find is scripts/time-to-publish-sla.js, which has its own clock.`);
  }
  if (sla.pct === 0 && sla.measured > 0) {
    console.log(`\n⚠ scoredAt is the EARLIEST 'scored' event in stage-latency.jsonl. If a bulk`);
    console.log(`  rescore (e.g. the 2026-07 NYC anchored-bands rollout) re-stamped older`);
    console.log(`  reviews, their scoredAt reflects the rescore, not first-score — the % then`);
    console.log(`  reads artificially low. A clean baseline needs original-score timing`);
    console.log(`  (first-seen backfill S2-T5 + a first-score stamp) to settle.`);
  }
}

if (require.main === module) main();
module.exports = { main };
