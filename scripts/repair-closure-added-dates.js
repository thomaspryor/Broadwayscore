#!/usr/bin/env node
/**
 * One-off repair for the 2026-05-27 closure-addedDate bulk re-stamp
 * (Notion 370637c5). mergeEvents() used to Object.assign(dupe, event) on a
 * source-priority upgrade, which copied event.addedDate=TODAY over the original
 * first-seen date — 7 of 9 closures ended up stamped 2026-05-27. The code fix
 * (write-once addedDate + closure de-dup, scripts/lib/cast-changes-filters.js)
 * stops recurrence; this script repairs the existing rows.
 *
 * addedDate semantics = when the closing was FIRST publicly announced (the date
 * the newsletter "Recently Announced Closings" keys on). Each value below was
 * verified against a primary source; see the per-show citation.
 *
 * NOTE: the closure DATE for the three extended shows (rocky-horror, titanique,
 * moulin-rouge) is independently stale vs broadway.com-audited shows.json
 * (original limited-run date, never superseded on extension). That is a
 * separate bug tracked in its own Notion card — this script only repairs
 * addedDate and the death-becomes-her duplicate.
 *
 * Idempotent: re-running yields 0 changes once applied.
 *
 *   node scripts/repair-closure-added-dates.js [--write]
 */
const fs = require('fs');
const path = require('path');
const { dedupeClosures } = require('./lib/cast-changes-filters');

const FILE = path.join(__dirname, '../data/cast-changes.json');
const WRITE = process.argv.includes('--write');

// showId -> { addedDate, source } — first public announcement of the closing.
const REPAIRS = {
  // Verified closing-announcement articles (sourceUrl IS the closing story):
  'chess-2025': { addedDate: '2026-05-26', source: 'playbill chess-will-close-on-broadway-in-june (published 2026-05-26)' },
  'death-becomes-her-2024': { addedDate: '2026-05-18', source: 'playbill death-becomes-her-will-end-on-broadway-in-june (published 2026-05-18)' },
  'moulin-rouge-2019': { addedDate: '2026-02-05', source: 'broadwayworld MOULIN-ROUGE-Sets-Final-Broadway-Performance-20260205 (first closing announcement; later extended to 2026-08-30)' },
  // Limited engagements — the closing date was published as part of the run
  // announcement; use that article's publish date (the cited sourceUrl):
  'fallen-angels-2026': { addedDate: '2026-05-13', source: 'playbill fallen-angels-to-stream-live-from-broadway-in-june (published 2026-05-13)' },
  'giant-2026': { addedDate: '2026-02-13', source: 'broadwayworld GIANT-Finds-Full-Cast-and-Design-Team (published 2026-02-13; strictly limited 16-week engagement)' },
  'titanique-2026': { addedDate: '2026-02-20', source: 'playbill broadway-titanique-adds-... (published 2026-02-20; original limited run, later extended to 2026-09-20)' },
  'the-rocky-horror-show-2026': { addedDate: '2026-01-28', source: 'playbill meet-rocky-horror-shows-broadway-creatures-of-the-night (published 2026-01-28; original limited engagement, later extended to 2026-11-29)' },
};

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const changes = [];

for (const [showId, rec] of Object.entries(data.shows || {})) {
  if (!Array.isArray(rec.upcoming)) continue;

  // 1. De-dup closures by date (collapses the two death-becomes-her rows; keeps
  //    the richer note and the earliest addedDate — same logic CI will now run).
  const before = rec.upcoming.filter(e => e.type === 'closure').length;
  rec.upcoming = dedupeClosures(rec.upcoming);
  const after = rec.upcoming.filter(e => e.type === 'closure').length;
  if (after < before) changes.push(`${showId}: deduped ${before} closures -> ${after}`);

  // 2. Repair addedDate to the verified first-announcement date.
  const repair = REPAIRS[showId];
  if (!repair) continue;
  for (const e of rec.upcoming) {
    if (e.type !== 'closure') continue;
    if (e.addedDate !== repair.addedDate) {
      changes.push(`${showId}: addedDate ${e.addedDate} -> ${repair.addedDate}  [${repair.source}]`);
      e.addedDate = repair.addedDate;
    }
  }
}

if (changes.length === 0) {
  console.log('No changes — already repaired (idempotent).');
  process.exit(0);
}

console.log(`${changes.length} change(s):`);
for (const c of changes) console.log('  ' + c);

if (WRITE) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nWrote ${FILE}`);
} else {
  console.log('\nDry run. Re-run with --write to apply.');
}
