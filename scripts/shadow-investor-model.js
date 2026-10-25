#!/usr/bin/env node
'use strict';

/**
 * shadow-investor-model.js — BRO-4989 shadow run. Computes the dated-cost
 * investor-return model and the new designation rule for every show, beside
 * the live model_* fields, and prints the BEFORE/AFTER diff and golden checks.
 * Writes nothing to commercial.json.
 *
 *   node scripts/shadow-investor-model.js [--out=diff.json] [--show=slug] [--golden]
 *
 * --golden exits 1 when the new model matches fewer golden facts than the
 * live one (the "at least as many" bar from the card).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { calculateInvestorReturn } = require('./lib/investor-return-model');
const { proposeDesignation } = require('./lib/designation-rule');
const { historyWithSeeds } = require('./lib/cost-history');

const DATA = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA, 'commercial.json'))
  ? path.join(DATA, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');

const args = process.argv.slice(2);
if (require('./lib/cli-help').hasHelpFlag(args)) {
  console.log('Usage: node scripts/shadow-investor-model.js [--out=diff.json] [--show=slug] [--golden]  (report only; see header)');
  process.exit(0);
}
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1];
const SINGLE = args.find((a) => a.startsWith('--show='))?.split('=')[1];
const GOLDEN = args.includes('--golden');

const MOVE_THRESHOLD = 0.25;
const NOT_MODELED = new Set(['Nonprofit', 'Tour Stop']);

/** Reported break-evens the model must land near (card golden list). */
const GOLDEN_BREAK_EVENS = [
  { slug: 'maybe-happy-ending', target: 820_000, tol: 0.10, note: 'Broadway Journal 2025-06-09 ~$820K' },
  { slug: 'the-great-gatsby', min: 900_000, note: 'producer-confirmed $900K+' },
];
/** Reported investor multiples (reported wins; the model is checked for distance only). */
const GOLDEN_MULTIPLES = [
  { slug: 'harry-potter', target: 1.06, note: 'Broadway Journal Dec 2025, $2.3M distributions on $35.5M' },
];

function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** true / false when the whole range is on one side of the line, null when it spans it. */
function callFromRange(low, high, line) {
  if (low >= line) return true;
  if (high < line) return false;
  return null;
}
/**
 * Golden facts are reported outcomes only: a recoupedSource that names a
 * report. Our own inferences ("Inferred: closed 30 days ago...") or a bare
 * flag with no source would grade the model against a guess.
 */
function isReportedRecoupment(comm) {
  const src = String(comm.recoupedSource || '').trim();
  return src.length > 0 && !/^inferred\b/i.test(src) && !/\binferred\b|no trade-press recoupment found/i.test(src.slice(0, 80));
}

const fmtCall = (c) => (c === null ? 'too close to call' : String(c));

/**
 * Specific causes of a difference, each tagged, so every change can be
 * checked against causes that can produce it. A change with no matching
 * cause is "unexplained" and fails the run.
 */
function causesFor(row, comm, model, show, weekly) {
  const c = [];
  if (model.svogGrant > 0 && comm.capitalization) {
    const near = model.svogGrant >= comm.capitalization * 0.8 ? ' (near the whole cap, so it divides by about the reserve)' : '';
    c.push({ kind: 'svog', text: `live % divides by cap minus the $${(model.svogGrant / 1e6).toFixed(1)}M SVOG grant${near}; new counts the grant as money in` });
  }
  if (row.old.method === 'simplified-lifetime') c.push({ kind: 'lifetime', text: 'live model used the 10-year lifetime shortcut; new one simulates every week with dated costs' });
  if (row.new.multipleRange[1] > 1) c.push({ kind: 'split', text: 'new figure is the investor return after the 50/50 producer split above recoupment' });
  if (model.estimatedWeeks > model.weeks * 0.2) c.push({ kind: 'estimated', text: `${model.estimatedWeeks} of ${model.weeks} weeks have no weekly grosses (estimated)` });
  const now = Date.now();
  const closing = show?.closingDate ? Date.parse(show.closingDate) : null;
  if (row.old.pct !== null && row.old.pct < 0) c.push({ kind: 'floor', text: 'live % goes below zero by counting operating losses past the cap; investors can lose at most what they put in (floor 0x)' });
  if (closing && closing > now && row.old.method === 'weekly-model') {
    c.push({ kind: 'projection', text: `live model counts the weeks up to the announced closing (${show.closingDate}) as played, at the average gross; new counts played weeks only` });
  }
  if (!closing || closing > now) c.push({ kind: 'reserve', text: 'running show: new holds the reserve fund back from what investors have been paid' });
  const firstWeek = Object.keys(weekly || {}).sort()[0];
  if (row.old.method === 'weekly-model' && firstWeek && show?.openingDate && show?.previewsStartDate
      && Date.parse(firstWeek) < Date.parse(show.openingDate) - 3 * 86400000) {
    c.push({ kind: 'preview-double-count', text: `weekly grosses start in previews (${firstWeek}), and the live model adds estimated preview weeks on top, counting previews twice` });
  }
  const nonSunday = Object.keys(weekly || {}).filter((k) => new Date(`${k}T12:00:00Z`).getUTCDay() !== 0).length;
  if (nonSunday > 0) c.push({ kind: 'duplicate-weeks', text: `${nonSunday} non-Sunday duplicate week rows in grosses (live counts them; BRO-4985 removes them)` });
  if (row.old.breakEven && Math.abs(row.new.breakEven / row.old.breakEven - 1) > 0.1) {
    c.push({ kind: 'cost-basis', text: `cost basis: live break-even $${row.old.breakEven.toLocaleString()} vs $${row.new.breakEven.toLocaleString()} from ${row.costAnchors} dated anchor(s), ${row.new.costQuality} quality` });
  }
  return c;
}

/** Causes that can produce each kind of change. */
const CAUSES_FOR_CHANGE = {
  'break-even': ['cost-basis'],
  return: ['svog', 'lifetime', 'split', 'estimated', 'cost-basis', 'floor', 'projection', 'reserve', 'duplicate-weeks', 'preview-double-count'],
  'model recouped call': ['svog', 'lifetime', 'estimated', 'cost-basis', 'projection', 'reserve', 'duplicate-weeks', 'preview-double-count'],
};

function main() {
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const grosses = load(path.join(DATA, 'grosses.json'));
  let history = { weeks: {} };
  try { history = load(path.join(DATA, 'grosses-history.json')); } catch { /* none */ }
  const commercial = load(COMMERCIAL_PATH).shows || load(COMMERCIAL_PATH);
  const L = makeGrossesLookup(grosses, history);
  const seeds = load(path.join(DATA, 'cost-anchor-seeds.json')).anchors;
  const bySlug = {};
  for (const s of shows) { bySlug[s.id] = s; if (s.slug) bySlug[s.slug] = s; }

  const rows = [];
  for (const [key, comm] of Object.entries(commercial)) {
    if (SINGLE && key !== SINGLE) continue;
    const show = bySlug[key] || bySlug[comm.slug] || bySlug[key.replace(/-\d{4}$/, '')];
    const old = {
      designation: comm.designation || null,
      recouped: comm.recouped ?? null,
      modelRecouped: comm.modelRecouped ?? null,
      pct: Array.isArray(comm.modelRecoupmentPct) ? comm.modelRecoupmentPct[1] : comm.modelRecoupmentPct ?? null,
      breakEven: comm.modelBreakeven ?? comm.weeklyRunningCost ?? null,
      method: comm.modelMethod || null,
    };
    const row = { slug: key, title: show?.title || key, old, new: null, proposed: null, changes: [], reasons: [] };
    if (!show || NOT_MODELED.has(comm.designation)) {
      row.skipped = !show ? 'no shows.json record' : `${comm.designation}: not modeled`;
      rows.push(row);
      continue;
    }
    const slug = show.slug || show.id;
    // Shadow: dated anchors (migrated figure + researched seeds), record untouched.
    const rec = { ...comm, costHistory: historyWithSeeds(comm, show, seeds[key] || []) };
    const weekly = L.getWeeklyData(slug, show.id);
    const model = calculateInvestorReturn(show, rec, L.getGrossesAllTime(slug, show.id), weekly);
    if (model.error) {
      row.skipped = model.error;
    } else {
      row.new = {
        multipleRange: model.investorMultipleRange,
        recoupedPctRange: model.recoupedPctRange,
        modelRecouped: model.modelRecouped,
        recoupCall: callFromRange(model.recoupedPctRange[0], model.recoupedPctRange[2], 100),
        recoupDate: model.central.recoupDate,
        breakEven: model.currentBreakEven,
        breakEvenRange: model.currentBreakEvenRange,
        costQuality: model.costQuality,
        sanityFlags: model.sanityFlags,
      };
    }
    row.proposed = proposeDesignation({ record: comm, show, model: model.error ? null : model });
    row.costAnchors = rec.costHistory.length;

    if (row.proposed.changed) row.changes.push(`designation ${old.designation} -> ${row.proposed.designation}`);
    if (row.new && old.modelRecouped !== null && old.modelRecouped !== row.new.modelRecouped) {
      row.changes.push(`model recouped call ${old.modelRecouped} -> ${row.new.modelRecouped}`);
    }
    if (row.new && old.breakEven && Math.abs(row.new.breakEven / old.breakEven - 1) > MOVE_THRESHOLD) {
      row.changes.push(`break-even ${old.breakEven} -> ${row.new.breakEven}`);
    }
    if (row.new && old.pct !== null) {
      const oldMult = old.pct / 100; // live % = share of (effective) cap recouped: 154 -> 1.54x
      const newMult = row.new.multipleRange[1];
      // Material only when both relative (>25%) and absolute (>=0.1x): 0.05x -> 0.11x is noise.
      if (Math.abs(newMult - oldMult) >= 0.1 && Math.abs(newMult / Math.max(oldMult, 0.01) - 1) > MOVE_THRESHOLD) row.changes.push(`return ${oldMult.toFixed(2)}x-equiv -> ${newMult}x`);
    }
    const causes = row.new ? causesFor(row, comm, model, show, weekly) : [];
    row.reasons = [];
    row.unexplained = [];
    for (const ch of row.changes) {
      if (ch.startsWith('designation')) {
        if (row.proposed.basis === 'reported' && row.proposed.reason) row.reasons.push(row.proposed.reason);
        else row.unexplained.push(ch);
        continue;
      }
      const type = Object.keys(CAUSES_FOR_CHANGE).find((k) => ch.startsWith(k));
      const hits = causes.filter((x) => CAUSES_FOR_CHANGE[type].includes(x.kind));
      if (!hits.length) row.unexplained.push(ch);
      for (const h of hits) if (!row.reasons.includes(h.text)) row.reasons.push(h.text);
    }
    rows.push(row);
  }

  // Golden checks: old (live) vs new.
  // Recoupment is judged on each model's own range, the same rule for both:
  // a range that spans the line is "too close to call" (owner's Near Cost
  // principle), neither a hit nor a miss. Strict central-only counts are
  // reported beside it.
  const golden = [];
  const g = (name, oldOk, newOk, detail) => golden.push({ name, oldOk, newOk, detail });
  const recoup = { live: { right: 0, wrong: 0, close: 0, strict: 0 }, new: { right: 0, wrong: 0, close: 0, strict: 0 } };
  const tally = (t, call, central, truth) => {
    if (call === null) t.close++; else if (call === truth) t.right++; else t.wrong++;
    if (central === truth) t.strict++;
  };
  for (const row of rows) {
    if (!row.new) continue;
    const comm = commercial[row.slug];
    if (comm.recouped !== true && comm.recouped !== false) continue;
    if (!isReportedRecoupment(comm)) continue;
    const p = comm.modelRecoupmentPct;
    const oldCall = Array.isArray(p) ? callFromRange(p[0], p[2], 100) : row.old.modelRecouped;
    tally(recoup.live, oldCall, row.old.modelRecouped, comm.recouped);
    tally(recoup.new, row.new.recoupCall, row.new.modelRecouped, comm.recouped);
    if (oldCall !== row.new.recoupCall) {
      golden.push({ name: `recouped=${comm.recouped}: ${row.slug}`, kind: 'recoup', oldCall, newCall: row.new.recoupCall,
        detail: `live ${fmtCall(oldCall)}, new ${fmtCall(row.new.recoupCall)} (pct ${row.new.recoupedPctRange.join('/')})` });
    }
  }
  for (const b of GOLDEN_BREAK_EVENS) {
    const row = rows.find((r) => r.slug === b.slug);
    if (!row?.new) continue;
    const ok = (v) => v != null && (b.min ? v >= b.min : Math.abs(v / b.target - 1) <= b.tol);
    g(`break-even ${b.slug}`, ok(row.old.breakEven), ok(row.new.breakEven), `live ${row.old.breakEven}, new ${row.new.breakEven} (${b.note})`);
  }
  for (const m of GOLDEN_MULTIPLES) {
    const row = rows.find((r) => r.slug === m.slug);
    if (!row?.new) continue;
    const oldMult = row.old.pct / 100;
    g(`multiple ${m.slug}`, Math.abs(oldMult / m.target - 1) <= 0.5, Math.abs(row.new.multipleRange[1] / m.target - 1) <= 0.5,
      `live ~${oldMult.toFixed(2)}x, new ${row.new.multipleRange[1]}x, reported ${m.target}x (${m.note}); reported wins`);
  }
  const point = golden.filter((x) => x.kind !== 'recoup');
  const oldScore = recoup.live.right + point.filter((x) => x.oldOk).length;
  const newScore = recoup.new.right + point.filter((x) => x.newOk).length;
  const worse = newScore < oldScore || recoup.new.wrong > recoup.live.wrong;

  const changed = rows.filter((r) => r.changes.length);
  const summary = {
    shows: rows.length,
    modeled: rows.filter((r) => r.new).length,
    designationChanges: rows.filter((r) => r.proposed?.changed).length,
    recoupedCallChanges: rows.filter((r) => r.changes.some((c) => c.startsWith('model recouped'))).length,
    bigMoves: rows.filter((r) => r.changes.some((c) => c.startsWith('break-even') || c.startsWith('return'))).length,
    unexplained: changed.filter((r) => r.unexplained.length).map((r) => `${r.slug}: ${r.unexplained.join('; ')}`),
    sanityFlagged: rows.filter((r) => r.new?.sanityFlags?.length).map((r) => `${r.slug}: ${r.new.sanityFlags[0]}`),
    golden: { live: oldScore, new: newScore, recoupment: recoup, pointChecks: point.map((x) => `${x.name}: live ${x.oldOk ? 'ok' : 'miss'}, new ${x.newOk ? 'ok' : 'miss'} (${x.detail})`) },
  };

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, golden, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows.filter((x) => x.proposed?.changed)) console.log(`  ${r.slug}: ${r.changes[0]} | ${r.reasons[0]}`);
  for (const x of golden.filter((y) => y.kind === 'recoup')) console.log(`  recoup call changed: ${x.name}: ${x.detail}`);

  if (GOLDEN && worse) {
    console.error(`FAIL: new model right on ${newScore} golden facts (${recoup.new.wrong} wrong), live ${oldScore} (${recoup.live.wrong} wrong)`);
    process.exit(1);
  }
  if (summary.unexplained.length) {
    console.error(`FAIL: ${summary.unexplained.length} changes without a reason`);
    process.exit(1);
  }
}

main();
