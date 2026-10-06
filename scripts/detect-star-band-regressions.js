#!/usr/bin/env node
'use strict';
/**
 * detect-star-band-regressions.js (BRO-4770) — standing detector for shows that
 * opened in the last N days (default 14). It finds, and with --apply repairs by
 * flagging needsRescore so the normal drain re-scores in anchored mode:
 *
 *   1. unanchored / out-of-band   a high-reliability star or grade whose review
 *                                 is not anchored, or whose score sits outside
 *                                 its band by more than --tol (default 2)
 *   2. clobbered                  a later whole-file write reverted a newer
 *                                 scoring group (scripts/lib/scoring-recency.js
 *                                 carries the fix, this catches any that slip
 *                                 through). Read from the review-texts git
 *                                 history, only reported while the CURRENT file
 *                                 is still on the older scoring.
 *
 * (A review on the BWW/Playbill roundup but missing from the live show JSON
 * after 6 hours is covered by the hourly audit-aggregator-gap.yml run of
 * scripts/audit-show-review-gap.js, which ingests the missing URL directly.)
 *
 * With --alert, anything found goes through owner-alert-router (digest). The
 * repair is automatic, so the alert is a record, not a task.
 *
 * Usage: node scripts/detect-star-band-regressions.js [--window=14] [--tol=2]
 *          [--history-days=14] [--apply] [--alert] [--json=PATH] [--help]
 *   --replay=SHA[,SHA]   dry-run the clobber check on specific review-texts
 *                        commits (ignores the window and the "still reverted"
 *                        filter), used to prove the detector on a known case
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

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage:\n  node scripts/detect-star-band-regressions.js [--window=14] [--tol=2] [--history-days=14] [--apply] [--alert] [--json=PATH] [--replay=SHA[,SHA]]\n  --help, -h   print this usage and exit');
  process.exit(0);
}

const argv = process.argv.slice(2);
const num = (name, dflt) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const str = (name) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const APPLY = argv.includes('--apply');
const ALERT = argv.includes('--alert');
const WINDOW = num('window', 14);
const TOL = num('tol', DEFAULT_TOL);
const HISTORY_DAYS = num('history-days', WINDOW);
const REPLAY = str('replay');
const JSON_OUT = str('json');

const ROOT = path.join(__dirname, '..');
const RT_DIR = path.join(ROOT, 'data', 'review-texts');
const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));

const DAY = 86400000;
const now = Date.now();
function inWindow(show) {
  const t = Date.parse(show.openingDate || '');
  return Number.isFinite(t) && t >= now - WINDOW * DAY && t <= now + DAY;
}
const windowShows = new Set(showsArr.filter(s => s && s.id && inWindow(s) && shouldUseAnchoredMode({ category: s.market || s.category, envFlag: false })).map(s => s.id));

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function git(args) { return execFileSync('git', ['-C', RT_DIR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }
function gitShow(rev, rel) { try { return JSON.parse(git(['show', `${rev}:${rel}`])); } catch { return null; } }

const findings = []; // { file, kind, detail, d }

// ── 1. unanchored / out-of-band over the window's shows ──
if (!REPLAY) {
  for (const showId of windowShows) {
    const show = showById.get(showId);
    const category = show.market || show.category;
    for (const f of glob.sync(path.join(RT_DIR, showId, '*.json'))) {
      const d = readJson(f);
      if (!d) continue;
      const v = starBandVerdict(d, { category, show, filePath: f }, TOL);
      if (v) findings.push({ file: `${showId}/${path.basename(f)}`, abs: f, kind: v.kind, detail: `${v.starsRaw} band ${v.floor}-${v.ceiling}${v.score != null ? ` score ${v.score}` : ''}` });
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
try {
  const seen = new Set();
  for (const sha of commitList()) {
    let files;
    try { files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${sha}^`, sha]).split('\n').filter(Boolean); } catch { continue; }
    for (const rel of files) {
      if (!rel.endsWith('.json')) continue;
      const showId = rel.split('/')[0];
      if (!REPLAY && !windowShows.has(showId)) continue;
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
      findings.push({ file: rel, abs: path.join(RT_DIR, rel), kind: 'clobbered', detail: `commit ${sha.slice(0, 9)} scoring stamp ${new Date(r.from).toISOString()} -> ${new Date(r.to).toISOString()}${r.lostBand ? ', anchored band lost' : ''}` });
    }
  }
} catch (e) {
  historyNote = ` (history check skipped: ${e.message.split('\n')[0]})`;
}

// ── repair + report ──
let flagged = 0;
if (APPLY) {
  for (const f of findings) {
    const d = readJson(f.abs);
    if (!d || d.needsRescore === true) continue;
    d.needsRescore = true;
    d.rescoreReason = f.kind === 'unanchored' ? 'late-star-anchor' : `late-star-anchor:${f.kind}`;
    delete d.rescoreCompletedAt;
    if (f.kind === 'out-of-band') d.starBandFlaggedAt = new Date().toISOString();
    safeWriteReview(f.abs, d, { force: true });
    flagged++;
  }
}

const byKind = {};
for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
console.log(`window=${WINDOW}d shows=${windowShows.size} findings=${findings.length} ${JSON.stringify(byKind)} ${APPLY ? `flagged=${flagged}` : '(dry run, pass --apply to flag needsRescore)'}${historyNote}`);
for (const f of findings.slice(0, 50)) console.log(`  [${f.kind}] ${f.file}  ${f.detail}`);
if (findings.length > 50) console.log(`  ...and ${findings.length - 50} more`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(findings.map(({ abs, ...rest }) => rest), null, 2));

(async () => {
  if (!ALERT || findings.length === 0) return;
  const { routeAlert } = require('./lib/owner-alert-router');
  await routeAlert({
    conditionKey: 'star-band:regressions',
    title: `Star-band detector: ${findings.length} review(s) ${APPLY ? 'flagged for anchored re-score' : 'found'}`,
    description: `${JSON.stringify(byKind)} in shows opened in the last ${WINDOW} days. ${APPLY ? 'Each was flagged needsRescore and the normal drain repairs it, no action needed.' : 'Dry run, nothing flagged.'}\n` + findings.slice(0, 10).map(f => `- [${f.kind}] ${f.file} ${f.detail}`).join('\n'),
    severity: 'warning',
    disposition: 'digest',
    cooldownHours: 24,
  });
})().catch(e => { console.error(`::warning::alert routing failed: ${e.message}`); });
