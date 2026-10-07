#!/usr/bin/env node
/**
 * backfill-merged-duplicate-urls.js (BRO-4414)
 *
 * Reconstructs `mergedDuplicateUrls` on survivors of past merge commits, whose
 * deleted duplicates left no record of their URL (see lib/merged-duplicate-urls.js).
 * Also reports deleted files that held the only real text (deleted fullText >= 500
 * chars while the survivor has < 500): the merge kept the wrong copy.
 *
 * Usage:
 *   node scripts/backfill-merged-duplicate-urls.js --repo=<review-texts git repo> --commits=<sha,sha> [--apply]
 *
 * Survivor = a remaining same-outlet file in the show dir, picked by identical
 * fullText, then identical normalized URL, then "the only same-outlet file".
 * Anything else is reported as ambiguous and left alone.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { recordMergedDuplicateUrl } = require('./lib/merged-duplicate-urls');
const { normalizeUrl } = require('./lib/review-normalization');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-merged-duplicate-urls.js — record deleted duplicates' URLs on survivors.

Usage:
  node scripts/backfill-merged-duplicate-urls.js --repo=<path> --commits=<sha,sha> [--apply]
  node scripts/backfill-merged-duplicate-urls.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const repo = arg('repo');
const commits = arg('commits').split(',').filter(Boolean);
if (!repo || !commits.length) { console.error(USAGE); process.exit(2); }

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const outletOf = (f) => f.split('--')[0];

const report = { recorded: [], alreadyHad: [], ambiguous: [], noSurvivor: [], wrongCopy: [], noUrl: 0 };

for (const c of commits) {
  const deleted = git('diff-tree', '--no-commit-id', '--name-only', '--diff-filter=D', '-r', c).split('\n').filter((f) => f.endsWith('.json'));
  for (const rel of deleted) {
    const [show, file] = rel.split('/');
    if (!file || file.includes('/')) continue;
    let loser;
    try { loser = JSON.parse(git('show', `${c}^:${rel}`)); } catch { continue; }
    const dir = path.join(repo, show);
    if (!fs.existsSync(dir)) { report.noSurvivor.push(rel); continue; }
    const cands = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && outletOf(f) === outletOf(file) && f !== file)
      .map((f) => ({ f, p: path.join(dir, f), d: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
    if (!cands.length) { report.noSurvivor.push(rel); continue; }
    const same = (pred) => cands.filter(pred);
    let pick = null;
    for (const pred of [
      (x) => loser.fullText && x.d.fullText === loser.fullText,
      (x) => loser.url && x.d.url && normalizeUrl(x.d.url) === normalizeUrl(loser.url),
    ]) { const m = same(pred); if (m.length === 1) { pick = m[0]; break; } }
    if (!pick && cands.length === 1) pick = cands[0];
    if (!pick) { report.ambiguous.push(`${rel} -> ${cands.map((x) => x.f).join(', ')}`); continue; }

    if ((loser.fullText || '').length >= 500 && (pick.d.fullText || '').length < 500) {
      report.wrongCopy.push(`${rel} (${loser.fullText.length} chars) -> survivor ${pick.f} (${(pick.d.fullText || '').length})`);
    }
    // previousUrl / urlCorrectedFrom on the loser are URLs it also answered to.
    let any = false;
    for (const u of [loser.url, loser.previousUrl, loser.urlCorrectedFrom]) {
      if (!u) continue;
      if (recordMergedDuplicateUrl(pick.d, u)) any = true;
    }
    if (!loser.url) report.noUrl++;
    if (any) {
      report.recorded.push(`${show}/${pick.f} <- ${loser.url}`);
      if (APPLY) fs.writeFileSync(pick.p, JSON.stringify(pick.d, null, 2) + '\n');
    } else report.alreadyHad.push(`${show}/${pick.f}`);
  }
}

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  recorded: report.recorded.length, alreadyHad: report.alreadyHad.length,
  ambiguous: report.ambiguous.length, noSurvivor: report.noSurvivor.length, noUrl: report.noUrl,
  wrongCopy: report.wrongCopy,
  ambiguousList: report.ambiguous, noSurvivorList: report.noSurvivor.slice(0, 30),
}, null, 1));
