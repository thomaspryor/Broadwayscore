#!/usr/bin/env node
/**
 * Audit Tony eligibility data in awards.json.
 *
 * Finds shows that may need a human eligibility ruling — either because:
 *   - They have a tony.season but zero nominations and no explicit ruling
 *   - They have eligible:false with no note explaining the ruling
 *   - They have conflicting fields (nominations + eligible:false)
 *
 * Output is a human-readable report to stdout. Read-only — makes no writes.
 *
 * Usage:
 *   node scripts/audit-tony-eligibility.js [--season 2025-26]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const AWARDS_FILE = path.join(__dirname, '..', 'data', 'awards.json');
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

function main() {
  const args = process.argv.slice(2);
  const seasonFilter = args.includes('--season') ? args[args.indexOf('--season') + 1] : null;

  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  let showsById = new Map();
  if (fs.existsSync(SHOWS_FILE)) {
    const showsRaw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
    const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
    showsById = new Map(showsArr.map(s => [s.id || s.slug, s]));
  }

  const awardsShows = awardsData.shows || {};

  const issues = {
    missingNote: [],      // eligible:false but no note
    contradiction: [],    // nominated/won AND eligible:false
    unruledZeroNom: [],   // tony.season set, zero noms, no explicit ruling
  };

  for (const [showId, show] of Object.entries(awardsShows)) {
    const tony = show.tony;
    if (!tony || !tony.season) continue;
    if (seasonFilter && tony.season !== seasonFilter) continue;

    const nominatedFor = tony.nominatedFor || [];
    const wins = Array.isArray(tony.wins) ? tony.wins : [];
    const nominations = tony.nominations || 0;
    const eligible = tony.eligible;
    const note = tony.note;
    const meta = showsById.get(showId) || {};

    // Contradiction: explicitly ineligible but has nominations or wins
    if (eligible === false && (nominations > 0 || nominatedFor.length > 0 || wins.length > 0)) {
      issues.contradiction.push({
        showId,
        season: tony.season,
        title: meta.title || showId,
        eligible,
        nominations,
        wins,
        nominatedFor: nominatedFor.slice(0, 3),
        note,
      });
    }

    // Missing note on ineligible ruling
    if (eligible === false && !note) {
      issues.missingNote.push({
        showId,
        season: tony.season,
        title: meta.title || showId,
      });
    }

    // Unruled zero-nom: has a season but no nominations and no explicit ruling
    // These are candidates for human review — they might need eligible:false added
    // Use == null to catch both undefined and JSON null
    if (eligible == null && nominations === 0 && nominatedFor.length === 0 && wins === 0) {
      issues.unruledZeroNom.push({
        showId,
        season: tony.season,
        title: meta.title || showId,
        type: meta.type,
        openingDate: meta.openingDate,
        status: meta.status,
      });
    }
  }

  let totalIssues = 0;

  console.log('=== Tony Eligibility Audit ===\n');

  if (issues.contradiction.length > 0) {
    console.log(`CONTRADICTIONS (eligible:false + nominations > 0) — ${issues.contradiction.length} show(s):`);
    for (const item of issues.contradiction) {
      console.log(`  [${item.season}] ${item.showId} — "${item.title}"`);
      console.log(`    nominations=${item.nominations} wins=${item.wins} nominatedFor=${JSON.stringify(item.nominatedFor)}`);
      console.log(`    note="${item.note || '(none)'}"`);
    }
    console.log();
    totalIssues += issues.contradiction.length;
  }

  if (issues.missingNote.length > 0) {
    console.log(`MISSING NOTE (eligible:false but no note) — ${issues.missingNote.length} show(s):`);
    for (const item of issues.missingNote) {
      console.log(`  [${item.season}] ${item.showId} — "${item.title}"`);
    }
    console.log();
    totalIssues += issues.missingNote.length;
  }

  if (issues.unruledZeroNom.length > 0) {
    console.log(`UNRULED ZERO-NOM (tony.season set, no nominations, no explicit ruling) — ${issues.unruledZeroNom.length} show(s):`);
    console.log('  These may need eligible:false if they were excluded by the Tony Administration Committee.\n');
    for (const item of issues.unruledZeroNom) {
      const status = item.status ? ` [${item.status}]` : '';
      const type = item.type ? ` (${item.type})` : '';
      const opened = item.openingDate ? ` opened ${item.openingDate}` : '';
      console.log(`  [${item.season}] ${item.showId} — "${item.title}"${type}${status}${opened}`);
    }
    console.log();
  }

  if (totalIssues === 0 && issues.unruledZeroNom.length === 0) {
    console.log('No issues found — all eligibility rulings are consistent.\n');
  }

  const totalAudited = Object.values(awardsShows).filter(s => s.tony?.season).length;
  console.log(`Audited ${totalAudited} shows with tony.season${seasonFilter ? ` in ${seasonFilter}` : ''}.`);
  console.log(`Contradictions: ${issues.contradiction.length} | Missing notes: ${issues.missingNote.length} | Unruled zero-nom: ${issues.unruledZeroNom.length}`);

  if (totalIssues > 0) {
    process.exit(1);
  }
}

main();
