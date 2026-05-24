#!/usr/bin/env node
/**
 * fix-show-statuses.js — One-time script to fix WE & OB show statuses and dates
 * Part of the March 2026 data integrity audit
 */

const fs = require('fs');
const path = require('path');
const { writeClosingDate } = require('./lib/closing-date-guard');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));

let changes = 0;

// Manifest of fixes
const statusFixes = [
  // 10 shows: open → previews (preview date was being used as opening date)
  { id: 'bigfoot-off-broadway-2026', status: 'previews', openingDate: '2026-03-01', previewDate: '2026-02-11' },
  { id: 'bughouse-off-broadway-2026', status: 'previews', openingDate: '2026-03-11', previewDate: '2026-02-24' },
  { id: 'what-we-did-before-our-moth-days-off-broadway-2026', status: 'previews', openingDate: '2026-03-05', previewDate: '2026-02-04' },
  { id: 'spare-parts-off-broadway-2026', status: 'previews', openingDate: '2026-03-08', previewDate: '2026-02-26' },
  { id: 'calf-scramble-off-broadway-2026', status: 'previews', openingDate: '2026-03-10', previewDate: '2026-02-28' },
  { id: 'spread-off-broadway-2026', status: 'previews', openingDate: '2026-03-02', previewDate: '2026-02-21' },
  { id: 'lost-in-del-valle-off-broadway-2026', status: 'previews', openingDate: '2026-04-09', previewDate: '2026-02-23' },
  { id: 'pied-a-terre-off-broadway-2026', status: 'previews', openingDate: '2026-03-04', previewDate: '2026-02-22' },
  { id: 'zack-off-broadway-2026', status: 'previews', openingDate: '2026-03-08', previewDate: '2026-02-21' },
  { id: 'my-joy-is-heavy-off-broadway-2025', status: 'previews', openingDate: '2026-03-17', previewDate: '2026-02-25' },

  // 1 show: closed
  { id: 'eva-luna-off-broadway-2022', status: 'closed', closingDate: '2022-12-16' },

  // 7 shows: wrong dates, set to upcoming with null openingDate
  { id: 'animal-wisdom-off-broadway-2022', status: 'upcoming', openingDate: null },
  { id: 'girls-chance-music-off-broadway-2024', status: 'upcoming', openingDate: null },
  { id: 'indian-princesses-off-broadway-2025', status: 'upcoming', openingDate: null },
  { id: 'the-emporium-off-broadway-2025', status: 'upcoming', openingDate: null },
  { id: 'bocking-off-broadway-2026', status: 'upcoming', openingDate: null },
  { id: 'imitation-of-life-off-broadway-2026', status: 'upcoming', openingDate: null },
  { id: 'jackals-off-broadway-2026', status: 'upcoming', openingDate: null },
];

for (const fix of statusFixes) {
  const show = data.shows.find(s => s.id === fix.id);
  if (!show) {
    console.error(`❌ Show not found: ${fix.id}`);
    continue;
  }

  const oldStatus = show.status;
  const oldOpening = show.openingDate;

  show.status = fix.status;
  if (fix.openingDate !== undefined) show.openingDate = fix.openingDate;
  if (fix.previewDate) show.previewDate = fix.previewDate;
  // Explicit-manual script: force-write through guard so audit-trail fields
  // (closingDateSource, closingDateUpdatedAt) get populated. The force flag
  // bypasses humanCorrectedClosingDate — appropriate for a one-time manual
  // operator script.
  if (fix.closingDate) writeClosingDate(show, fix.closingDate, 'fix-show-statuses (manual)', { force: true });

  console.log(`✓ ${fix.id}: ${oldStatus} → ${fix.status}` +
    (fix.openingDate !== undefined ? ` | opening: ${oldOpening} → ${fix.openingDate}` : '') +
    (fix.previewDate ? ` | preview: ${fix.previewDate}` : '') +
    (fix.closingDate ? ` | closing: ${fix.closingDate}` : ''));
  changes++;
}

fs.writeFileSync(SHOWS_PATH, JSON.stringify(data, null, 2) + '\n');
console.log(`\nDone. ${changes} shows updated in shows.json`);
