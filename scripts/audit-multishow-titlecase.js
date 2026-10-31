#!/usr/bin/env node
/**
 * audit-multishow-titlecase.js — read-only (BRO-5373).
 *
 * content-quality detectMultiShowContent counted show titles that are ordinary
 * words ("Tender", "Local", "The Estate") wherever they appeared in lowercase
 * prose, and assessTextQuality then called real reviews garbage when the body
 * also never printed the show's title (Standing at the Sky's Edge 2023,
 * Telegraph and The Stage: both describe Park Hill without naming the show).
 *
 * For every review file with fullText this runs assessTextQuality with the
 * show's real title twice, with and without requireTitleCase, and reports the
 * files whose verdict changes: show, file, outlet, length, verdict before and
 * after, and the titles that stop counting. Ids, outlets and titles only, no
 * review text.
 *
 * Files the old rule does not flag are skipped (the option only removes
 * matches, so their verdict cannot change). --shard=i/n splits the shows so
 * a full-corpus run fits the run-script time limit.
 *
 * --rule=url (BRO-5395) compares instead without and with the review's own url
 * and Theatre Record filing as show-identity evidence (qualityOptsFor); files
 * whose text already names the show are skipped, since the evidence is only
 * consulted when it does not.
 *
 * --rule=flag (BRO-5395) lists files carrying showNotMentioned that the url
 * evidence would clear (validateShowMentionedOrNamedByUrl valid, plain
 * validateShowMentioned not), i.e. what backfill-review-flags would clear.
 * Each row also names what would STILL exclude the file once showNotMentioned
 * is cleared (explainExclusion on a copy without it): 14 of the 43 rows
 * BRO-5395 cleared by hand stayed out on a second flag (wrongShow from the same
 * missing-title check, a duplicate copy, a stale rejectedAt), which the first
 * sort did not see.
 *
 * Usage: node scripts/audit-multishow-titlecase.js [--rule=titlecase|url|flag] [--show=a,b] [--shard=i/n] [--limit=N] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stillExcludedBy } = require('./lib/still-excluded-by');
const { assessTextQuality, detectMultiShowContent, validateShowMentioned, validateShowMentionedOrNamedByUrl, qualityOptsFor } = require('./lib/content-quality');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const onlyShows = val('show') ? val('show').split(',') : null;
const limit = Number(val('limit') || 200);
const asJson = args.includes('--json');
const rule = val('rule') || 'titlecase';
if (!['titlecase', 'url', 'flag'].includes(rule)) { console.error('--rule must be titlecase, url or flag'); process.exit(2); }
const shardArg = val('shard');
const [shardIdx, shardCount] = shardArg ? shardArg.split('/').map(Number) : [0, 1];
if (!(shardCount >= 1 && shardIdx >= 0 && shardIdx < shardCount)) { console.error('--shard must be i/n with 0 <= i < n'); process.exit(2); }

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showList = Array.isArray(raw) ? raw : (raw.shows || []);
  const titleById = Object.fromEntries(showList.map((s) => [s.id, s.title]));
  const showById = Object.fromEntries(showList.map((s) => [s.id, s]));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const shows = (onlyShows || fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
    .filter((_, i) => i % shardCount === shardIdx);

  let scanned = 0;
  const transitions = {};
  const flips = [];
  for (const show of shows) {
    const dir = path.join(textsDir, show);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const text = typeof r.fullText === 'string' ? r.fullText : '';
      if (text.length < 200) continue;
      scanned++;
      const title = titleById[show] || null;
      let wasFound;
      let before;
      let after;
      if (rule === 'flag') {
        if (!r.showNotMentioned || validateShowMentioned(text, title, show).valid) continue;
        if (!validateShowMentionedOrNamedByUrl(text, title, show, r).valid) continue;
        wasFound = { showsFound: [] };
        before = { quality: 'showNotMentioned', issues: [] };
        after = { quality: 'cleared', issues: [] };
      } else if (rule === 'url') {
        if (validateShowMentioned(text, title, show).valid) continue;
        wasFound = { showsFound: [] };
        before = assessTextQuality(text, show, title, { requireTitleCase: false, useShowEvidence: false });
        after = assessTextQuality(text, show, title, { requireTitleCase: false, useShowEvidence: true, ...qualityOptsFor(r) });
      } else {
        wasFound = detectMultiShowContent(text, show, { requireTitleCase: false });
        if (!wasFound.detected) continue;
        before = assessTextQuality(text, show, title, { requireTitleCase: false });
        after = assessTextQuality(text, show, title, { requireTitleCase: true });
      }
      if (before.quality === after.quality) continue;
      const key = `${before.quality} -> ${after.quality}`;
      transitions[key] = (transitions[key] || 0) + 1;
      const was = wasFound.showsFound;
      const now = new Set(rule === 'url' ? [] : detectMultiShowContent(text, show, { requireTitleCase: true }).showsFound);
      flips.push({
        show, file, outlet: r.outletId || null, chars: text.length,
        before: before.quality, after: after.quality,
        beforeIssue: (before.issues || [])[0] || null,
        droppedTitles: was.filter((t) => !now.has(t)).slice(0, 8),
        url: rule !== 'titlecase' ? `${r.publishDate || 'no-date'} ${r.url || 'no-url'}` : undefined,
        stillExcludedBy: rule === 'flag' ? stillExcludedBy(r, showById[show], path.join(dir, file)) : undefined,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ scanned, flips: flips.length, transitions, rows: flips.slice(0, limit) }, null, 2));
    return;
  }
  console.log(`files with fullText scanned: ${scanned}${shardArg ? ` (shard ${shardArg})` : ''}`);
  console.log(`verdict changes with ${rule === 'titlecase' ? 'requireTitleCase' : rule === 'flag' ? 'url evidence (showNotMentioned cleared)' : 'url evidence'}: ${flips.length}`);
  console.log('by transition:', JSON.stringify(transitions));
  console.log('\nshow | file | outlet | chars | before -> after | titles that stop counting');
  for (const f of flips.slice(0, limit)) {
    console.log(`${f.show} | ${f.file} | ${f.outlet} | ${f.chars} | ${f.before} -> ${f.after} | ${rule !== 'titlecase' ? `${f.beforeIssue} | ${f.url}` : f.droppedTitles.join(', ')}${rule === 'flag' ? ` | still excluded by: ${f.stillExcludedBy || 'nothing'}` : ''}`);
  }
}

if (require.main === module) main();
