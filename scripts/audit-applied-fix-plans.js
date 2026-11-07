#!/usr/bin/env node
/**
 * BRO-6872: an APPLIED fix plan whose review never became includable is reported loudly.
 *
 *   node scripts/audit-applied-fix-plans.js [--strict] [--counts=PATH] [--show=ID] [--quiet]
 *
 * Exit 0 on a completed scan (report-only monitor by default, like audit-star-band-drift.js);
 * with --strict, exit 1 when any applied plan's review has no row. Exit 2 on a setup error
 * (no data/pending-fixes, no reviews.json, no review-texts checkout) rather than a vacuous pass.
 *
 * Why this exists: data/pending-fixes/*.json records approved repairs ("this review is not the
 * wrong production, clear the flag"). The runner writes the review-text file and marks the plan
 * `applied`, and nothing after that checks the row reached data/reviews.json. Five pipeline steps
 * between the file and the row fail silently and independently (scripts/verify-review-recovery.js),
 * so an applied plan can read as done for months while the show page still misses the review.
 *
 * It never re-implements the rebuild's inclusion rules: review-guards.js explainExclusion owns them
 * (with the rebuild's own data/audit/rebuild-exclusions-<show>.json where present, as
 * exclusion-rule-census.js does), and anything it excludes is skipped, not reported. The decision
 * is in scripts/lib/applied-fix-plan-rows.js and unit-tested there.
 *
 * Two report classes, with different repairs:
 *   includable-but-absent  the rebuild would include this review and there is no row -> rebuild path
 *   no-score               the review has no score at all -> scoring, not a rebuild
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('./lib/cli-help').exitOnHelp(module);
const { normalizeOutlet, normalizeCritic } = require('./lib/review-normalization');
const { matchesOutletCriticFile } = require('./lib/review-file-match');
const { explainExclusion, explainShowLevelExclusion } = require('./lib/review-guards');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const audit = require('./lib/applied-fix-plan-rows');

const argv = process.argv.slice(2);
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
const REBUILD_EXCLUSIONS_RE = /^rebuild-exclusions-(.+)\.json$/;

// { showId: { basename: statKey } }. review-guards rebuildOnlyPassExclusion() looks the file up by
// BASENAME in a flat map, so the raw { showId, exclusions: [{file, reason}] } payload must be
// flattened first. Passing the raw object matched nothing and every rebuild-only pass (dedup,
// twins, skippedNoScore) was ignored, which reported real duplicate-text drops as ABSENT
// (reviewer finding, BRO-6872). Same loader as exclusion-rule-census.js.
function loadRebuildExclusions(auditDir) {
  const byShow = Object.create(null);
  let names = [];
  try { names = fs.readdirSync(auditDir); } catch { return byShow; }
  for (const n of names) {
    const m = REBUILD_EXCLUSIONS_RE.exec(n);
    if (!m) continue;
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(path.join(auditDir, n), 'utf8')); } catch { continue; }
    if (!payload || !Array.isArray(payload.exclusions)) continue;
    const files = Object.create(null);
    for (const ex of payload.exclusions) {
      if (ex && ex.file && ex.file !== '-' && ex.reason && !files[ex.file]) files[ex.file] = ex.reason;
    }
    byShow[payload.showId || m[1]] = files;
  }
  return byShow;
}

function main() {
  const repoDir = path.resolve(__dirname, '..');
  const plansDir = path.join(repoDir, 'data', 'pending-fixes');
  const reviewsPath = path.join(repoDir, 'data', 'reviews.json');
  const showsPath = path.join(repoDir, 'data', 'shows.json');
  const textsDir = resolveReviewTextsDir();
  for (const [p, what] of [[plansDir, 'data/pending-fixes'], [reviewsPath, 'data/reviews.json'], [showsPath, 'data/shows.json']]) {
    if (!fs.existsSync(p)) { console.error(`audit-applied-fix-plans: missing ${what} (npm run data:check)`); return 2; }
  }
  // Without the private review-texts checkout every action reads as "file gone" and the audit would
  // pass green on nothing at all (reviewer finding, BRO-6872).
  if (!textsDir || !fs.existsSync(textsDir)) {
    console.error('audit-applied-fix-plans: no data/review-texts checkout (./scripts/setup-local-data.sh)');
    return 2;
  }
  const onlyShow = arg('show');
  const quiet = argv.includes('--quiet');
  const strict = argv.includes('--strict');

  const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const rows = Array.isArray(reviews) ? reviews : reviews.reviews || [];
  // reviewTextsScannedAt is the rebuild's real scan cutoff; lastUpdated/generatedAt are the fallback
  // (a scoped --show= rebuild can move lastUpdated without rescanning other shows).
  const meta = (reviews && reviews._meta) || {};
  const rebuiltAt = Date.parse(meta.reviewTextsScannedAt || meta.lastUpdated || meta.generatedAt || '') || null;
  if (rebuiltAt == null) console.warn('audit-applied-fix-plans: reviews.json has no _meta scan timestamp; the post-rebuild grace check is off (plans applied since the last rebuild may be reported early).');
  const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const showById = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || []).map((s) => [s.id, s]));
  const rebuildExclusions = loadRebuildExclusions(path.join(repoDir, 'data', 'audit'));
  // The rebuild writes NO file for a show with zero exclusions (rebuild-exclusion-audit.js), so a
  // missing per-show list cannot mean "unknown" — that would blind the audit to exactly the clean
  // shows a real miss hides in. The honest signal is global: at least one list means this run
  // rebuilt, and a show without one simply excluded nothing. No list at all (a checkout that never
  // rebuilt, e.g. a local run) means the dedup and no-score passes are invisible for every show.
  const sawRebuild = Object.keys(rebuildExclusions).length > 0;

  // 591 canonical URLs belong to more than one show (a Broadway run and its tour), so the URL index
  // is keyed by show as well: a twin's row must never mark a missing row as present.
  const byShowUrl = new Map();
  const byShow = new Map();
  for (const r of rows) {
    const s = r.showId || r.show_id;
    if (!s) continue;
    const u = audit.canonicalReviewUrl(r.url || r.canonicalUrl);
    if (u && !byShowUrl.has(`${s}\n${u}`)) byShowUrl.set(`${s}\n${u}`, r);
    if (!byShow.has(s)) byShow.set(s, []);
    byShow.get(s).push(r);
  }
  // URL first. The outlet/critic filename fallback runs ONLY for a file with no URL: where a show
  // has a dedup survivor and a loser from the same outlet and critic, it would otherwise match the
  // survivor's row and hide a real miss (reviewer finding, BRO-6872).
  const findRow = (action, rec) => {
    const u = audit.canonicalReviewUrl(rec.url);
    if (u) return byShowUrl.get(`${action.showId}\n${u}`) || null;
    const base = path.basename(action.file);
    return (byShow.get(action.showId) || []).find((r) =>
      matchesOutletCriticFile(base, normalizeOutlet(r.outletId || r.outlet || ''), normalizeCritic(r.criticName || r.critic || ''), normalizeOutlet)) || null;
  };
  const explain = (action, rec) => {
    const show = showById.get(action.showId) || null;
    if (!show) return 'unknownShow';
    const showRule = explainShowLevelExclusion(show);
    if (showRule) return showRule;
    const list = Object.prototype.hasOwnProperty.call(rebuildExclusions, action.showId) ? rebuildExclusions[action.showId] : null;
    // The rebuild's own log wins over the mirror, for ANY reason it recorded — not just the
    // cross-file passes review-guards opts into via REBUILD_ONLY_PASS_REASONS. That set is the
    // CENSUS's policy (a per-file disagreement is a mirror gap it must keep counting,
    // review-guards.js:5291). This audit asks a different question: did the rebuild include the
    // row? A reason in the log means it did not, so there is nothing here to report. Without this,
    // two Paddington reviews whose 2026-10-13 plans cleared wrongProduction read as ABSENT while
    // the rebuild was excluding them every run as skippedCrossMarket (US outlets, West End show) —
    // a guard the mirror documents as not expressible (review-guards.js:4684).
    const logged = list ? list[path.basename(action.file)] : null;
    if (logged) return logged;
    const rule = explainExclusion(rec, show, path.join(textsDir, action.file), sawRebuild ? { rebuildExclusions: list || {} } : undefined);
    if (rule) return rule;
    // Unknown, never reported. This is why the step runs inside the rebuild workflow.
    if (!sawRebuild) return 'unknown-no-rebuild-exclusion-list';
    return null;
  };

  const reported = []; const skipReasons = new Map(); let checked = 0; let plansRead = 0;
  for (const name of fs.readdirSync(plansDir).filter((f) => f.endsWith('.json')).sort()) {
    let plan;
    try { plan = JSON.parse(fs.readFileSync(path.join(plansDir, name), 'utf8')); } catch { continue; }
    plansRead++;
    for (const action of audit.clearingActions(plan, name)) {
      if (onlyShow && action.showId !== onlyShow) continue;
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(textsDir, action.file), 'utf8')); } catch { rec = null; }
      checked++;
      const verdict = audit.judgeClearedAction(action, rec, { findRow, explain, rebuiltAt });
      if (verdict.skipped) skipReasons.set(verdict.reason, (skipReasons.get(verdict.reason) || 0) + 1);
      else if (!verdict.ok) reported.push({ ...action, reason: verdict.reason, url: verdict.url });
    }
  }
  const absent = reported.filter((r) => r.reason === 'includable-but-absent');
  const unscored = reported.filter((r) => r.reason === 'no-score');

  const countsOut = arg('counts');
  if (countsOut) {
    const p = path.resolve(repoDir, countsOut);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      plansRead,
      actionsChecked: checked,
      includableButAbsent: absent.length,
      noScore: unscored.length,
      skipped: Object.fromEntries([...skipReasons].sort()),
      reported: reported.map((r) => ({ planFile: r.planFile, file: r.file, field: r.field, reason: r.reason })),
    }, null, 2)}\n`);
  }
  if (!quiet) {
    console.log(`applied fix plans: ${plansRead} read, ${checked} flag-clearing action(s) checked`);
    console.log(`  skipped: ${[...skipReasons].sort().map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    for (const r of absent) console.log(`  ABSENT  ${r.planFile} [${r.status}] cleared ${r.field} on ${r.file}${r.url ? ` (${r.url})` : ''}`);
    for (const r of unscored) console.log(`  NO-SCORE ${r.planFile} [${r.status}] cleared ${r.field} on ${r.file}${r.url ? ` (${r.url})` : ''}`);
  }
  if (!reported.length) { if (!quiet) console.log('OK: every applied fix plan reached an includable row.'); return 0; }
  const say = strict ? console.error : console.log;
  if (absent.length) {
    say(`\n${absent.length} applied fix plan action(s) the rebuild would include have no review row.`);
    say('  node scripts/verify-review-recovery.js --show=<showId> --production');
  }
  if (unscored.length) {
    say(`\n${unscored.length} applied fix plan action(s) have no score, so the rebuild drops them. They need scoring, not a rebuild.`);
    say('  node scripts/score-reviews-llm.js --show=<showId>');
  }
  return strict ? 1 : 0;
}

process.exitCode = main();
