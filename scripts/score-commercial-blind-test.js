#!/usr/bin/env node
'use strict';
/**
 * Score a blind commercial-research run against known outcomes (BRO-4990).
 *
 * Step 1, research shows whose outcome commercial.json already holds, in
 * sandbox mode (nothing written but FILE):
 *   node scripts/deep-research-commercial.js --shows=a,b,c --model=M --out=FILE
 * Step 2, score it:
 *   node scripts/score-commercial-blind-test.js FILE [FILE2 ...] [--json]
 *
 * Re-run this whenever the research model changes (OpenAI retires models:
 * o4-mini shuts down 2026-10-23) so a swap is judged on measured accuracy.
 *
 * Metrics per run:
 *   fill       share of shows with a non-TBD designation / a capitalization
 *   designation exact match vs the record, among shows the model answered
 *   outcome    same side of recoupment (recouped / lost money / nonprofit)
 *   recouped   true/false match, where both sides state it
 *   cap        within ±20% of the recorded capitalization
 *   cost       USD from the response usage fields + search fees
 */

const fs = require('fs');
const path = require('path');
const { canonicalDesignation } = require('./lib/commercial-designations');

const RECOUPED = new Set(['Miracle', 'Windfall', 'Easy Winner', 'Trickle']);
const LOST = new Set(['Fizzle', 'Flop']);
const CAP_TOLERANCE = 0.2;

function outcomeClass(d) {
  if (RECOUPED.has(d)) return 'recouped';
  if (LOST.has(d)) return 'lost';
  if (d === 'Nonprofit') return 'nonprofit';
  return null;
}

const answered = (d) => !!d && d !== 'TBD';

/**
 * @param {Record<string, object>} results - out-file `shows`
 * @param {Record<string, object>} truth - commercial.json `shows`
 */
function scoreRun(results, truth) {
  const rows = [];
  for (const [slug, r] of Object.entries(results)) {
    const t = truth[slug];
    if (!t) { rows.push({ slug, missingTruth: true }); continue; }
    const row = {
      slug,
      error: r._error || (r._noData ? 'no structured data' : null),
      cost: (r._cost && r._cost.usd) || 0,
      searches: (r._cost && r._cost.searches) || 0,
      truthDesignation: t.designation,
      // Same normalization the apply step uses ("flop" -> "Flop").
      designation: canonicalDesignation(r.designation) || r.designation || null,
      truthCap: t.capitalization ?? null,
      cap: r.capitalization ?? null,
      truthRecouped: t.recouped ?? null,
      recouped: r.recouped ?? null,
      confidence: r.confidence || null,
      selfCitedDropped: r._selfCitedDropped || 0,
    };
    row.designationMatch = answered(row.designation) ? row.designation === row.truthDesignation : null;
    const oc = outcomeClass(row.designation);
    row.outcomeMatch = oc ? oc === outcomeClass(row.truthDesignation) : null;
    row.recoupedMatch = row.recouped != null && row.truthRecouped != null ? row.recouped === row.truthRecouped : null;
    row.capMatch = row.cap != null && row.truthCap
      ? Math.abs(row.cap - row.truthCap) / row.truthCap <= CAP_TOLERANCE
      : null;
    rows.push(row);
  }
  const scored = rows.filter(r => !r.missingTruth);
  const rate = (key) => {
    const judged = scored.filter(r => r[key] != null);
    return { hit: judged.filter(r => r[key]).length, of: judged.length };
  };
  return {
    shows: scored.length,
    errors: scored.filter(r => r.error).length,
    fillDesignation: scored.filter(r => answered(r.designation)).length,
    fillCap: scored.filter(r => r.cap != null).length,
    designation: rate('designationMatch'),
    outcome: rate('outcomeMatch'),
    recouped: rate('recoupedMatch'),
    cap: rate('capMatch'),
    // High-confidence answers are what the weekly apply step auto-publishes.
    highConfidenceDesignation: (() => {
      const h = scored.filter(r => r.confidence === 'high' && r.designationMatch != null);
      return { hit: h.filter(r => r.designationMatch).length, of: h.length };
    })(),
    totalCost: scored.reduce((s, r) => s + r.cost, 0),
    rows,
  };
}

const fmt = ({ hit, of }) => (of ? `${hit}/${of} (${Math.round((hit / of) * 100)}%)` : 'n/a');

function main() {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: score-commercial-blind-test.js OUT_FILE [OUT_FILE ...] [--json]');
    return 2;
  }
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'commercial.json'), 'utf8')).shows;
  const report = {};
  for (const f of files) {
    const out = JSON.parse(fs.readFileSync(f, 'utf8'));
    report[out.model || f] = scoreRun(out.shows || {}, truth);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const [model, s] of Object.entries(report)) {
    console.log(`\n=== ${model} — ${s.shows} shows, ${s.errors} errors, $${s.totalCost.toFixed(2)} ($${(s.totalCost / (s.shows || 1)).toFixed(3)}/show) ===`);
    console.log(`fill: designation ${s.fillDesignation}/${s.shows}, capitalization ${s.fillCap}/${s.shows}`);
    console.log(`designation exact ${fmt(s.designation)} | outcome side ${fmt(s.outcome)} | recouped ${fmt(s.recouped)} | cap ±20% ${fmt(s.cap)} | high-confidence designation ${fmt(s.highConfidenceDesignation)}`);
    for (const r of s.rows) {
      if (r.missingTruth) { console.log(`  ${r.slug}: no record to compare`); continue; }
      const cap = (v) => (v == null ? '?' : `$${(v / 1e6).toFixed(1)}M`);
      const mark = (m) => (m == null ? '·' : m ? '✓' : '✗');
      console.log(`  ${mark(r.designationMatch)}${mark(r.outcomeMatch)}${mark(r.recoupedMatch)}${mark(r.capMatch)} ${r.slug}: ${r.designation || '-'} (truth ${r.truthDesignation}) cap ${cap(r.cap)} (truth ${cap(r.truthCap)}) conf ${r.confidence || '-'} $${r.cost.toFixed(3)}${r.error ? ' ERROR ' + r.error : ''}${r.selfCitedDropped ? ' [self-cite dropped]' : ''}`);
    }
  }
  return 0;
}

module.exports = { scoreRun, outcomeClass };
if (require.main === module) process.exit(main());
