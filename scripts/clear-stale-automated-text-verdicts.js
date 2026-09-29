#!/usr/bin/env node
'use strict';

/**
 * clear-stale-automated-text-verdicts.js — sweep automated TEXT-QUALITY
 * verdicts (not_a_review / garbage_text / truncated_text rejections, and the
 * heuristic+llm nonReviewFlag) that predate the complete fullText now on disk,
 * and hand those files back to the LLM scorer to be judged on the new text.
 *
 * Predicate + rationale: scripts/lib/stale-automated-text-verdict.js. Measured
 * 2026-09-29: 56 files, ~6/10 spot-read genuine reviews (e.g.
 * a-time-to-kill-2013/nytimes--charles-isherwood.json). Runs daily from
 * llm-ensemble-score.yml ahead of the capped needsRescore drain so future
 * recoveries (recover-*-browser.js, collect-review-texts.js re-fetches) heal
 * without anyone noticing them first.
 *
 * Also (BRO-4391): an ensemble wrong_production rejection on a review dated
 * inside a declared priorRuns/tourLegs window that was never re-judged with
 * those runs in the prompt is cleared + requeued ONCE (productionVerdictRecheckedAt).
 *
 * Per file: the verdict moves into priorAutomatedTextVerdicts[], the live
 * fields are null-assigned (never deleted), every score computed from the old
 * text is parked in the same breadcrumb (so the file publishes nothing until
 * the scorer re-judges it; an outlet's explicit originalScoreNormalized stays
 * as assignedScore), and needsRescore is raised via markRescoreNeeded(). Files that another guard would STILL exclude after the
 * clear (wrongShow, url_content_mismatch, ...) are left untouched: clearing
 * there requeues nothing (stuck-rescore-flag.js invariant forbids flagging)
 * and would let the old text in unjudged if that other blocker later lifts.
 *
 * Usage:
 *   node scripts/clear-stale-automated-text-verdicts.js                 # dry run
 *   node scripts/clear-stale-automated-text-verdicts.js --apply         # write
 *   node scripts/clear-stale-automated-text-verdicts.js --show=ID       # one show
 *   node scripts/clear-stale-automated-text-verdicts.js --dir=PATH      # other corpus (or REVIEW_TEXTS_DIR)
 *   node scripts/clear-stale-automated-text-verdicts.js --json
 *   --force-bulk   override the surge guard (> SURGE_THRESHOLD files)
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { shouldRefuseSurge } = require('./lib/wrong-show-blocker-cleanup');
const { staleAutomatedTextVerdicts, neutralizeStaleAutomatedTextVerdict, isPreContextWrongProduction, neutralizePreContextWrongProduction, RESCORE_REASON, RECHECK_RESCORE_REASON } = require('./lib/stale-automated-text-verdict');
const { markRescoreNeeded } = require('./lib/rescore-flagging');
const { isScoreable } = require('./lib/is-scoreable');

// Steady state is a handful of recoveries a day; the one-time backlog (56)
// goes through with --force-bulk. A larger daily batch means the predicate
// or a writer regressed.
const SURGE_THRESHOLD = 25;

const USAGE = `clear-stale-automated-text-verdicts.js — clear automated not_a_review/garbage_text/truncated_text verdicts that predate the complete fullText now on disk, and requeue the file for LLM scoring.

Usage:
  node scripts/clear-stale-automated-text-verdicts.js [--apply] [--show=ID] [--dir=PATH] [--json] [--force-bulk]
`;

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const val = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
  };
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    forceBulk: argv.includes('--force-bulk'),
    show: val('show'),
    dir: val('dir') || process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts'),
  };
}

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const map = new Map();
  for (const s of (raw.shows || raw)) if (s && s.id) map.set(s.id, s);
  return map;
}

function scan(dir, shows, showFilter) {
  const matches = [];
  let showDirs = listShowDirs(dir);
  if (showFilter) showDirs = showDirs.filter((d) => d === showFilter);
  for (const showDir of showDirs) {
    const showPath = path.join(dir, showDir);
    let files;
    try { files = fs.readdirSync(showPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      const fp = path.join(showPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const show = shows.get(showDir);
      const kinds = staleAutomatedTextVerdicts(data);
      // BRO-4391: wrong_production verdicts issued before the declared
      // priorRuns/tourLegs were in the prompt get one re-judge with them.
      if (!kinds.length && isPreContextWrongProduction(data, show)) kinds.push('wrongProductionRecheck');
      if (!kinds.length) continue;
      matches.push({ path: fp, rel: `${showDir}/${file}`, show, kinds, data });
    }
  }
  return matches;
}

/**
 * Neutralize + requeue one record in memory (m.data is mutated only when the
 * cleared record is scoreable). Returns a summary row; row.changed says
 * whether the caller should write.
 */
function processRecord(m, now) {
  const d = m.data;
  const before = {
    rejectionReason: d.rejectionReason ?? null,
    rejectedBy: d.rejectedBy ?? null,
    nonReviewFlag: d.nonReviewFlag ?? null,
    nonReviewType: d.nonReviewType ?? null,
  };
  const trial = JSON.parse(JSON.stringify(d));
  const recheck = m.kinds.includes('wrongProductionRecheck');
  const neutralize = (rec) => (recheck ? neutralizePreContextWrongProduction(rec, m.show, now) : neutralizeStaleAutomatedTextVerdict(rec, now));
  neutralize(trial);
  const scoreable = isScoreable(trial, m.show, m.path);
  if (scoreable) {
    neutralize(d);
    markRescoreNeeded(d, recheck ? RECHECK_RESCORE_REASON : RESCORE_REASON, now);
  }
  const last = scoreable ? d.priorAutomatedTextVerdicts[d.priorAutomatedTextVerdicts.length - 1] : null;
  return {
    rel: m.rel, kinds: m.kinds, before, changed: scoreable, needsRescore: d.needsRescore === true,
    parkedScore: last && last.parkedScore ? Object.keys(last.parkedScore) : null,
    keptExplicit: scoreable && d.scoreSource === 'explicit-after-stale-verdict-clear' ? d.assignedScore : null,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const opts = parseArgs(argv);
  if (!fs.existsSync(opts.dir)) {
    console.error(`[stale-text-verdicts] review-texts dir missing: ${opts.dir}`);
    process.exit(2);
  }
  const shows = loadShows();
  const matches = scan(opts.dir, shows, opts.show);

  const now = new Date().toISOString();
  const rows = matches.map((m) => processRecord(m, now));
  const requeued = rows.filter((r) => r.changed).length;
  const parked = rows.filter((r) => r.parkedScore).length;

  // Surge guard counts files this run would WRITE — the untouched
  // other-blocker residue matches every day and must not eat the budget.
  if (opts.apply && shouldRefuseSurge(requeued, SURGE_THRESHOLD, opts.forceBulk)) {
    console.error(`::error::Refusing to clear ${requeued} stale automated text verdicts (> ${SURGE_THRESHOLD}). A batch this large usually means the predicate or a writer regressed — re-run with --force-bulk if this is a legitimate backlog cleanup.`);
    process.exit(1);
  }

  let written = 0;
  if (opts.apply) {
    const { safeWriteReview } = require('./lib/review-write-guard');
    matches.forEach((m, i) => {
      if (!rows[i].changed) return;
      const res = safeWriteReview(m.path, m.data, { force: true });
      if (res && res.wrote !== false) written++;
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ matched: rows.length, requeued, parked, leftForOtherBlocker: rows.length - requeued, written, apply: opts.apply, rows }, null, 2));
  } else {
    console.log(`[stale-text-verdicts] ${rows.length} file(s) with a stale automated text verdict${opts.show ? ` (show=${opts.show})` : ''}; ${requeued} cleared + requeued for rescore (${parked} with an old-text score parked), ${rows.length - requeued} left untouched (another guard still excludes them)${opts.apply ? `; wrote ${written}` : ' (dry run)'}`);
    for (const r of rows) {
      const was = r.before.rejectionReason ? `${r.before.rejectedBy}:${r.before.rejectionReason}` : '';
      const nr = r.before.nonReviewFlag ? `nonReviewFlag:${r.before.nonReviewType}` : '';
      console.log(`    - ${r.rel}  [${[was, nr].filter(Boolean).join(' + ')}] -> ${r.changed ? `cleared, needsRescore${r.parkedScore ? `, parked ${r.parkedScore.join('+')}` : ''}${r.keptExplicit != null ? `, explicit ${r.keptExplicit} kept` : ''}` : 'untouched (other blocker)'}`);
    }
  }
}

if (require.main === module) main();

module.exports = { scan, processRecord, SURGE_THRESHOLD };
