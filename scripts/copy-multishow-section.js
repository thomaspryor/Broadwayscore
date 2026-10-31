#!/usr/bin/env node
'use strict';
/**
 * copy-multishow-section.js (BRO-5325): file a show's section of a multi-review
 * column stored under another show into that show's own row. Rules:
 * scripts/lib/multishow-section-copy.js. Allowlisted for approved-fix
 * run-script plans; one copy per action.
 *
 *   node scripts/copy-multishow-section.js --from=<show>/<file>.json --to-show=<showId> \
 *     --expect-start=First_four_words --expect-end=last_four_words [--apply]
 *
 * Columns with no venue boxes (an NYT piece reviewing two shows): add
 * --method=markers. The section is then cut from the stored text between the
 * two markers (each must occur exactly once), and --own-start / --own-end cut
 * the source row down to ITS section too, so neither row scores the other
 * show's verdict (BRO-5924). Both rows are queued for a rescore.
 *
 * --dir=<review-texts root> and --shows=<shows.json> point it at fixtures
 * (scripts/copy-multishow-section.test.mjs); production uses the defaults.
 *
 * Markers use `_` for spaces (run-script splits args on spaces). Without
 * --apply it prints the plan. Exit 1 when the copy is refused, so a plan
 * action fails loudly. Then rescore the target show (llm-ensemble-score.yml
 * show_id=<target>, needs_rescore=true).
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { planSectionCopy, sectionByMarkers } = require('./lib/multishow-section-copy');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `copy-multishow-section.js — copy one show's section of a multi-review column into its own row
Usage:
  node scripts/copy-multishow-section.js --from=<show>/<file>.json --to-show=<showId> --expect-start=w1_w2_w3_w4 --expect-end=w1_w2_w3_w4 [--apply]
  ... --method=markers [--own-start=w1_w2_w3_w4 --own-end=w1_w2_w3_w4]   (no venue boxes: cut by markers, optionally trim the source to its own section)
`;

function loadSectionExtractor(showsPath) {
  // The section logic is the scorer's (TypeScript); tsx/cjs lets plain node load it.
  createRequire(__filename)('tsx/cjs');
  const vbs = require('./llm-scoring/venue-box-sections.ts');
  if (!showsPath) return vbs.extractVenueBoxSectionForShowId;
  // --shows=<file> (tests): the same extractor against a fixture shows list.
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = raw.shows || raw;
  return (text, showId) => {
    const target = shows.find((s) => s.id === showId);
    return target ? vbs.extractVenueBoxSection(text, target, shows) : { ok: false, reason: 'unknown show', boxes: 0 };
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const from = arg('from');
  const toShow = arg('to-show');
  if (!from || !toShow || from.includes('..') || toShow.includes('/') || toShow.includes('..')) { console.error(USAGE); return 2; }
  const root = arg('dir') || path.join(__dirname, '..', 'data', 'review-texts');
  const sourceShowId = from.split('/')[0];
  const fileName = path.basename(from);
  const sourcePath = path.join(root, from);
  if (!fs.existsSync(sourcePath)) { console.error(`not found: ${from}`); return 1; }
  const showsPath = arg('shows');
  const { loadLiveShowIds, filterToLiveShowIds } = require('./lib/live-show-ids');
  if (filterToLiveShowIds([toShow], showsPath ? loadLiveShowIds(showsPath) : loadLiveShowIds()).dropped.length) { console.error(`REFUSED ${toShow}: not a show id in shows.json (BRO-5789: no orphan review folders)`); return 1; }
  const targetDir = path.join(root, toShow);
  const targetPath = path.join(targetDir, fileName);

  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const target = fs.existsSync(targetPath) ? JSON.parse(fs.readFileSync(targetPath, 'utf8')) : null;
  const { loadBlocklist, findBlockedEntry } = require('./lib/poller-blocklist');
  if (source.url && fs.existsSync(targetDir) && findBlockedEntry(loadBlocklist(targetDir), source.url)) {
    console.error(`REFUSED ${toShow}/${fileName}: the column url is on ${toShow}'s blocklist`);
    return 1;
  }
  const methodArg = arg('method');
  if (methodArg && !['markers', 'venue-box'].includes(methodArg)) { console.error(`unknown --method=${methodArg} (markers or venue-box)`); return 2; }
  const method = methodArg === 'markers' ? 'markers' : 'venue-box';
  // A re-run after a successful marker split: the source already holds only its own
  // section, so the shared markers are gone. Nothing left to do.
  if (method === 'markers' && source.multiShowSplitParent && source.multiShowSplitMethod === 'markers'
    && target && target.multiShowSectionCopy && target.multiShowSectionCopy.fromShowId === sourceShowId) {
    console.log(`ALREADY FILED ${from} -> ${toShow}/${fileName}: marker split already applied`);
    return 0;
  }
  const section = method === 'markers'
    ? sectionByMarkers(source.fullText || '', arg('expect-start'), arg('expect-end'))
    : loadSectionExtractor(showsPath)(source.fullText || '', toShow);
  const ownStart = arg('own-start');
  const ownEnd = arg('own-end');
  if ((ownStart || ownEnd) && (method !== 'markers' || !ownStart || !ownEnd)) { console.error('--own-start and --own-end go together and need --method=markers'); return 2; }
  // Without its own section the source keeps the whole article and keeps scoring both shows.
  if (method === 'markers' && !ownStart) { console.error('--method=markers needs --own-start and --own-end'); return 2; }
  const ownSection = ownStart ? sectionByMarkers(source.fullText || '', ownStart, ownEnd) : null;
  const plan = planSectionCopy({
    source, sourceShowId, section, target, targetShowId: toShow,
    expectStart: arg('expect-start'), expectEnd: arg('expect-end'), method, ownSection,
  });
  if (!plan.ok) { console.error(`REFUSED ${toShow}/${fileName}: ${plan.reason}`); return 1; }
  const apply = argv.includes('--apply');
  console.log(`${apply ? 'COPIED' : 'WOULD COPY'} ${from} -> ${toShow}/${fileName}: ${plan.reason}`);
  if (!apply) return 0;

  const { safeWriteReview } = require('./lib/review-write-guard');
  fs.mkdirSync(targetDir, { recursive: true });
  // safeWriteReview mutates the record it is handed (the url-change clear).
  const columnDate = plan.row.publishDate || null;
  const w = safeWriteReview(targetPath, { ...plan.row });
  if (w && w.wrote === false) { console.error(`target write refused: ${JSON.stringify(w)}`); return 1; }
  // A url change clears the old record's publishDate even when the column's
  // date is the same day (url-change-invariant: a carried-over date is stale).
  // The date here is the column's own, so set it again now the url is stable.
  const written = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  if (columnDate && !written.publishDate) {
    const d = safeWriteReview(targetPath, { ...written, publishDate: columnDate });
    if (d && d.wrote === false) { console.error(`publishDate write refused: ${JSON.stringify(d)}`); return 1; }
  }
  // A source cut down to its own section replaces the stored row: the whole
  // article's llmScore/ensembleData must not survive the trim.
  const p = ownSection ? safeWriteReview(sourcePath, plan.parent, { merge: false, force: true }) : safeWriteReview(sourcePath, plan.parent);
  if (p && p.wrote === false) { console.error(`source sibling marker write refused: ${JSON.stringify(p)}`); return 1; }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
