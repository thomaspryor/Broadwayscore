#!/usr/bin/env node
'use strict';
// BRO-7092: classify the undone ops of old data-fix plans against current data
// (scripts/lib/fix-plan-triage.js). Read-only unless --write.
//
//   node scripts/triage-fix-plans.js [--max-age-days=7] [--json] [--plans=a,b]
//     Prints a summary, or with --json the per-plan verdicts. Needs review
//     texts for review ops; without them those ops are "unknown". In a cloud
//     session run it through CI: node scripts/cloud-run-script.js --review-texts
//     scripts/triage-fix-plans.js --json
//   node scripts/triage-fix-plans.js --from=<verdicts.json> --write
//     Records the verdicts in each plan as `triage`, and withdraws a plan
//     whose undone ops are all resolved or obsolete (status "superseded",
//     the BRO-5935 shape the land checks accept). Verdicts only: no review text.
//
// Output never contains review text: reasons are built from ids, file names,
// urls and short scalar values (scripts/lib/fix-plan-triage.js).
const fs = require('fs');
const path = require('path');
const triage = require('./lib/fix-plan-triage.js');
const { normalizeUrl } = require('./lib/review-normalization.js');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const PLANS_DIR = path.join(ROOT, 'data', 'pending-fixes');
const UNRESOLVED = new Set(['pending', 'partial', 'validation-failed']);

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function buildContext() {
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const shows = new Map((showsRaw.shows || showsRaw).map((s) => [s.id, s]));
  const retired = new Set((readJson(path.join(ROOT, 'data', 'retired-show-ids.json')) || []).map((r) => r.id || r));
  const commercialRaw = readJson(path.join(ROOT, 'data', 'commercial.json')) || {};
  const commercial = commercialRaw.shows || {};
  const reviewsRaw = readJson(path.join(ROOT, 'data', 'reviews.json'));
  const reviews = reviewsRaw.reviews || reviewsRaw;

  const byUrl = new Map(); // show|url -> count of reviews.json rows
  const byCritic = new Map(); // show|outletId|critic -> count
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const r of reviews) {
    if (r.url) bump(byUrl, `${r.showId}|${normalizeUrl(r.url)}`);
    bump(byCritic, `${r.showId}|${r.outletId}|${String(r.criticName || '').toLowerCase()}`);
  }

  const textsDir = resolveReviewTextsDir();
  const hasReviewTexts = fs.existsSync(textsDir) && fs.readdirSync(textsDir).length > 50;
  const fileCache = new Map();
  const reviewFile = (rel) => {
    if (!hasReviewTexts || !rel) return null;
    if (!fileCache.has(rel)) fileCache.set(rel, readJson(path.join(textsDir, rel)));
    return fileCache.get(rel);
  };
  const showUrlCache = new Map();
  const reviewFileForUrl = (showId, url) => {
    if (!showUrlCache.has(showId)) {
      const m = new Map();
      const dir = path.join(textsDir, showId);
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
          const rec = readJson(path.join(dir, f));
          if (rec && rec.url) m.set(normalizeUrl(rec.url), `${showId}/${f}`);
        }
      }
      showUrlCache.set(showId, m);
    }
    return showUrlCache.get(showId).get(normalizeUrl(url)) || null;
  };
  const countedEntries = (showId, rec) => {
    if (!rec) return 0;
    if (rec.url) return byUrl.get(`${showId}|${normalizeUrl(rec.url)}`) || 0;
    return byCritic.get(`${showId}|${rec.outletId}|${String(rec.criticName || '').toLowerCase()}`) || 0;
  };

  return {
    hasReviewTexts,
    show: (id) => shows.get(id) || null,
    isRetired: (id) => retired.has(id),
    commercial: (slug) => commercial[slug] || null,
    reviewFile,
    reviewFileForUrl,
    showFiles: (showId) => {
      const dir = path.join(textsDir, showId);
      return hasReviewTexts && fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
    },
    isUrlCounted: (showId, url) => (byUrl.get(`${showId}|${normalizeUrl(url)}`) || 0) > 0,
    isCounted: (showId, rec) => countedEntries(showId, rec) > 0,
    countedEntries,
    sameReview: (_showId, a, b) => Boolean(a && b && a.url && b.url && normalizeUrl(a.url) === normalizeUrl(b.url)),
  };
}

function oldUnresolvedPlans(maxDays, only) {
  const now = Date.now();
  const out = [];
  for (const name of fs.readdirSync(PLANS_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const id = name.replace(/\.json$/, '');
    if (only && !only.has(id)) continue;
    const plan = readJson(path.join(PLANS_DIR, name));
    if (!plan || !UNRESOLVED.has(plan.status)) continue;
    const age = (now - Date.parse(plan.createdAt)) / 86400000;
    if (!only && !(age > maxDays)) continue;
    out.push({ id, plan });
  }
  return out;
}

function classifyAll() {
  const only = arg('plans') ? new Set(String(arg('plans')).split(',')) : null;
  const ctx = buildContext();
  const plans = oldUnresolvedPlans(Number(arg('max-age-days', 7)), only).map(({ id, plan }) => ({
    id, status: plan.status, ...triage.classifyPlan(plan, ctx),
  }));
  return { at: new Date().toISOString(), hasReviewTexts: ctx.hasReviewTexts, plans };
}

/** The `triage` block recorded in a plan file. */
function triageBlock(entry, at) {
  const still = entry.ops.filter((o) => o.verdict === triage.STILL_NEEDED);
  return {
    card: 'BRO-7092',
    at,
    verdict: entry.verdict,
    counts: entry.counts,
    ...(still.length ? { stillNeededReason: still.map((o) => `op ${o.i}: ${o.reason}`).join('; ').slice(0, 600) } : {}),
    ops: entry.ops.map(({ i, verdict, reason }) => ({ i, verdict, reason })),
  };
}

function writeVerdicts(file) {
  const data = readJson(file);
  if (!data || !Array.isArray(data.plans)) throw new Error(`${file}: no plans array`);
  const tally = { superseded: 0, annotated: 0, skipped: 0 };
  for (const entry of data.plans) {
    const p = path.join(PLANS_DIR, `${entry.id}.json`);
    const plan = readJson(p);
    if (!plan || !UNRESOLVED.has(plan.status)) { tally.skipped++; continue; }
    if (entry.verdict === triage.UNKNOWN) { tally.skipped++; continue; }
    // Verdicts describe the plan as it was classified; a rerun since, or a
    // changed action list, makes them stale.
    const ranSince = plan.executedAt && Date.parse(plan.executedAt) > Date.parse(data.at);
    const n = (plan.plan && plan.plan.actions || []).length;
    if (ranSince || entry.ops.some((o) => o.i >= n) || plan.status !== entry.status) { tally.skipped++; tally.stale = (tally.stale || 0) + 1; continue; }
    plan.triage = triageBlock(entry, data.at);
    if (entry.verdict === triage.RESOLVED || entry.verdict === triage.OBSOLETE) {
      plan.status = 'superseded';
      plan.supersededAt = data.at;
      plan.supersededReason = `BRO-7092 triage against current data: every undone op is ${entry.verdict === triage.RESOLVED ? 'already in place' : 'resolved or no longer applies'} (${Object.entries(entry.counts).map(([k, v]) => `${v} ${k}`).join(', ')}); per-op reasons in triage.ops`;
      tally.superseded++;
    } else {
      tally.annotated++;
    }
    fs.writeFileSync(p, `${JSON.stringify(plan, null, 2)}\n`);
  }
  return tally;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/triage-fix-plans.js [--max-age-days=7] [--json] [--plans=a,b]\n       node scripts/triage-fix-plans.js --from=<verdicts.json> --write');
    return;
  }
  if (arg('write')) {
    const from = arg('from');
    if (!from) throw new Error('--write needs --from=<verdicts.json>');
    console.log(JSON.stringify(writeVerdicts(from)));
    return;
  }
  const result = classifyAll();
  if (arg('json')) { console.log(JSON.stringify(result)); return; }
  const by = {};
  const ops = {};
  for (const p of result.plans) {
    by[p.verdict] = (by[p.verdict] || 0) + 1;
    for (const [k, v] of Object.entries(p.counts)) ops[k] = (ops[k] || 0) + v;
  }
  console.log(`review texts: ${result.hasReviewTexts ? 'yes' : 'NO (review ops are unknown)'}`);
  console.log(`plans: ${result.plans.length}`, JSON.stringify(by));
  console.log('undone ops:', JSON.stringify(ops));
  for (const p of result.plans.filter((x) => x.verdict === triage.STILL_NEEDED)) {
    for (const o of p.ops.filter((x) => x.verdict === triage.STILL_NEEDED)) console.log(`  ${p.id} op ${o.i}: ${o.reason}`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { buildContext, triageBlock };
