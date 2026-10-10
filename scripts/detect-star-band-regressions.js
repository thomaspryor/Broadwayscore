#!/usr/bin/env node
'use strict';
/**
 * detect-star-band-regressions.js (BRO-4770) — standing detector over the WHOLE
 * review corpus (every show in an anchored market, no date window: the checks
 * read local review-text files only, so they are cheap). It finds, and with
 * --apply repairs by flagging needsRescore so the normal drain re-scores in
 * anchored mode:
 *
 *   1. unanchored / out-of-band   a high-reliability star or grade whose review
 *                                 is not anchored, or whose score sits outside
 *                                 its band by more than --tol (default 2)
 *   2. clobbered                  a later whole-file write reverted a newer
 *                                 scoring group (scripts/lib/scoring-recency.js
 *                                 carries the fix, this catches any that slip
 *                                 through). Read from the review-texts git
 *                                 history (--history-days back, and the run says
 *                                 how far the available history reaches), only
 *                                 reported while the CURRENT file is still on
 *                                 the older scoring. A clobber that dropped the
 *                                 band is also caught by check 1 on any run.
 *
 *   3. false-truncation          (BRO-4804, EVERY market, not only anchored ones) a scored
 *                                 file whose complete-tier text the scorer called
 *                                 truncated only because of a page footer, so the
 *                                 ensemble was told to hedge. Predicate:
 *                                 isFalseTruncationScore in rescore-flagging.js.
 *
 * (A review on the BWW/Playbill roundup but missing from the live show JSON is
 * covered by the hourly audit-aggregator-gap.yml run of
 * scripts/audit-show-review-gap.js, which ingests the missing URL directly.)
 *
 * The first full run reports counts by market and by show. Nothing is capped
 * silently: every finding is flagged (the drain caps its own daily spend).
 *
 * With --alert, anything found goes through owner-alert-router (digest). The
 * repair is automatic, so the alert is a record, not a task.
 *
 * Usage: node scripts/detect-star-band-regressions.js [--tol=2]
 *          [--history-days=7] [--apply] [--alert] [--json=PATH] [--help]
 *   --replay=SHA[,SHA]   dry-run the clobber check on specific review-texts
 *                        commits (ignores the "still reverted" filter), used to
 *                        prove the detector on a known case
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { starBandVerdict, scoringRegression, DEFAULT_TOL } = require('./lib/star-band-regression');
const { scoringStamp } = require('./lib/scoring-recency');
const { shouldUseAnchoredMode } = require('./lib/star-reliability');
const { safeWriteReview } = require('./lib/review-write-guard');
const { isFalseTruncationScore } = require('./lib/rescore-flagging');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage:\n  node scripts/detect-star-band-regressions.js [--tol=2] [--history-days=7] [--apply] [--alert] [--json=PATH] [--replay=SHA[,SHA]]\n  --help, -h   print this usage and exit');
  process.exit(0);
}

const argv = process.argv.slice(2);
const num = (name, dflt) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const str = (name) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const APPLY = argv.includes('--apply');
const ALERT = argv.includes('--alert');
const TOL = num('tol', DEFAULT_TOL);
const HISTORY_DAYS = num('history-days', 7);
const REPLAY = str('replay');
const JSON_OUT = str('json');

const ROOT = path.join(__dirname, '..');
const RT_DIR = path.join(ROOT, 'data', 'review-texts');
const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));

const marketOf = (show) => show.market || show.category;
const scopeShows = new Set(showsArr.filter(s => s && s.id && shouldUseAnchoredMode({ category: marketOf(s), envFlag: false })).map(s => s.id));

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function git(args) { return execFileSync('git', ['-C', RT_DIR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }
function gitShow(rev, rel) { try { return JSON.parse(git(['show', `${rev}:${rel}`])); } catch { return null; } }

const findings = []; // { file, kind, detail, d }

// ── 1. unanchored / out-of-band over the window's shows ──
if (!REPLAY) {
  for (const showId of scopeShows) {
    const show = showById.get(showId);
    const category = show.market || show.category;
    for (const f of glob.sync(path.join(RT_DIR, showId, '*.json'))) {
      const d = readJson(f);
      if (!d) continue;
      const v = starBandVerdict(d, { category, show, filePath: f }, TOL);
      if (v) findings.push({ showId, market: marketOf(show), file: `${showId}/${path.basename(f)}`, abs: f, kind: v.kind, detail: `${v.starsRaw} band ${v.floor}-${v.ceiling}${v.score != null ? ` score ${v.score}` : ''}` });
    }
  }
}

// ── 3. scorer status truncated while contentTier=complete (footer false positive), every show ──
if (!REPLAY) {
  for (const [showId, show] of showById) {
    for (const f of glob.sync(path.join(RT_DIR, showId, '*.json'))) {
      const d = readJson(f);
      if (!d || !isFalseTruncationScore(d, show, f)) continue;
      findings.push({ showId, market: marketOf(show), file: `${showId}/${path.basename(f)}`, abs: f, kind: 'false-truncation', detail: `score ${d.assignedScore} scored with a truncation warning on a complete-tier text` });
    }
  }
}

// ── 2. clobber signature from the review-texts history ──
function commitList() {
  if (REPLAY) return REPLAY.split(',').map(s => s.trim()).filter(Boolean);
  const out = git(['log', `--since=${HISTORY_DAYS} days ago`, '--format=%H']);
  return out.split('\n').filter(Boolean);
}
let historyNote = '';
let historyReach = '';
try {
  const seen = new Set();
  const shas = commitList();
  historyReach = `${shas.length} review-texts commit(s) scanned`;
  try {
    const dates = git(['log', '--format=%cI']).trim().split('\n');
    const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    historyReach += `; checkout reaches back to ${dates[dates.length - 1] || 'n/a'}${shallow ? ' (shallow, older commits are not checked)' : ''}`;
  } catch {}
  for (const sha of shas) {
    let files;
    try { files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${sha}^`, sha]).split('\n').filter(Boolean); } catch { continue; }
    for (const rel of files) {
      if (!rel.endsWith('.json')) continue;
      const showId = rel.split('/')[0];
      if (!REPLAY && !scopeShows.has(showId)) continue;
      const prev = gitShow(`${sha}^`, rel);
      const next = gitShow(sha, rel);
      const r = scoringRegression(prev, next);
      if (!r) continue;
      const cur = readJson(path.join(RT_DIR, rel));
      // Real runs report only files still on the older scoring; a replay shows the commit's own effect.
      if (!REPLAY && (!cur || scoringStamp(cur) >= r.from)) continue;
      const key = `${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ showId, market: marketOf(showById.get(showId) || {}), file: rel, abs: path.join(RT_DIR, rel), kind: 'clobbered', detail: `commit ${sha.slice(0, 9)} scoring stamp ${new Date(r.from).toISOString()} -> ${new Date(r.to).toISOString()}${r.lostBand ? ', anchored band lost' : ''}` });
    }
  }
} catch (e) {
  historyNote = ` (history check skipped: ${e.message.split('\n')[0]})`;
}

// ── repair + report ──
let flagged = 0;
if (APPLY) {
  for (const f of findings) {
    // The BRO-4804 inventory (thousands of files) is drained in staged, A/B-checked waves via
    // false-truncation-flag.yml, so the standing run only REPORTS it unless explicitly enabled.
    if (f.kind === 'false-truncation' && process.env.FALSE_TRUNCATION_APPLY !== 'true') continue;
    const d = readJson(f.abs);
    if (!d || d.needsRescore === true) continue;
    d.needsRescore = true;
    d.rescoreReason = f.kind === 'false-truncation' ? 'false-truncation-warning' : f.kind === 'unanchored' ? 'late-star-anchor' : `late-star-anchor:${f.kind}`;
    delete d.rescoreCompletedAt;
    d.rescoreFlaggedAt = new Date().toISOString();
    if (f.kind === 'out-of-band') d.starBandFlaggedAt = new Date().toISOString();
    safeWriteReview(f.abs, d, { force: true });
    flagged++;
  }
}

const byKind = {}, byMarket = {}, byShow = {};
for (const f of findings) {
  byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  byMarket[f.market] = (byMarket[f.market] || 0) + 1;
  byShow[f.showId] = (byShow[f.showId] || 0) + 1;
}
console.log(`scope=${scopeShows.size} anchored-market shows (whole corpus) findings=${findings.length} ${JSON.stringify(byKind)} ${APPLY ? `flagged=${flagged}` : '(dry run, pass --apply to flag needsRescore)'}${historyNote}`);
if (byKind['false-truncation'] && process.env.FALSE_TRUNCATION_APPLY !== 'true') console.log(`false-truncation: ${byKind['false-truncation']} file(s) reported, NOT flagged (staged drain via false-truncation-flag.yml, BRO-4804)`);
console.log(`history: ${historyReach || 'not checked'}`);
console.log(`by market: ${JSON.stringify(byMarket)}`);
const topShows = Object.entries(byShow).sort((a, b) => b[1] - a[1]);
console.log(`by show (${topShows.length} shows): ${topShows.slice(0, 25).map(([s, n]) => `${s}=${n}`).join(', ')}${topShows.length > 25 ? ` ...and ${topShows.length - 25} more shows (full list in --json)` : ''}`);
for (const f of findings.slice(0, 20)) console.log(`  [${f.kind}] ${f.file}  ${f.detail}`);
if (findings.length > 20) console.log(`  ...and ${findings.length - 20} more (full list in --json)`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ byKind, byMarket, byShow, findings: findings.map(({ abs, ...rest }) => rest) }, null, 2));

(async () => {
  if (!ALERT || findings.every(f => f.kind === 'false-truncation')) return; // report-only kind, see above
  const { routeAlert } = require('./lib/owner-alert-router');
  await routeAlert({
    conditionKey: 'star-band:regressions',
    title: `Star-band detector: ${findings.length} review(s) ${APPLY ? 'flagged for anchored re-score' : 'found'}`,
    description: `${JSON.stringify(byKind)} across the whole corpus, by market ${JSON.stringify(byMarket)}. ${APPLY ? 'Each was flagged needsRescore and the normal drain repairs it, no action needed.' : 'Dry run, nothing flagged.'}\n` + findings.slice(0, 10).map(f => `- [${f.kind}] ${f.file} ${f.detail}`).join('\n'),
    severity: 'warning',
    disposition: 'digest',
    cooldownHours: 24,
  });
})().catch(e => { console.error(`::warning::alert routing failed: ${e.message}`); });
