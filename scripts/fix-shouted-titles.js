#!/usr/bin/env node
/**
 * Repair ALL-CAPS show titles in shows.json (BRO-3863).
 *
 * Several ingestion paths capture a title from a heading the source renders
 * in CSS uppercase, so the shouted form becomes the stored title and ships
 * verbatim to the site and the newsletter.
 *
 * Report-only by default — rewriting a title is a visible, user-facing edit,
 * and a handful of all-caps titles are genuine stylisations. Pass --apply to
 * write. The predicate (3+ words, every letter uppercase) lives in
 * scripts/lib/title-display-case.js and is shared with validate-data.js's
 * gate, so the audit and the guard can never disagree.
 *
 * Usage:
 *   node scripts/fix-shouted-titles.js            # report
 *   node scripts/fix-shouted-titles.js --apply    # write shows.json
 *   node scripts/fix-shouted-titles.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { isShoutedTitle, toDisplayTitleCase, needsManualReview } = require('./lib/title-display-case');

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function main() {
  const raw = fs.readFileSync(SHOWS_PATH, 'utf8');
  const doc = JSON.parse(raw);
  const shows = doc.shows || doc;

  const changes = [];
  const deferred = [];
  for (const show of shows) {
    if (!isShoutedTitle(show.title)) continue;
    if (needsManualReview(show.id)) {
      deferred.push({ id: show.id, title: show.title });
      continue;
    }
    const next = toDisplayTitleCase(show.title);
    if (next === show.title) continue;
    changes.push({ id: show.id, from: show.title, to: next, openingDate: show.openingDate || null });
    if (APPLY) {
      show.title = next;
      // Breadcrumb so a later scrape of the same source doesn't silently
      // shout it again without anyone noticing the flip-flop.
      show.titleCaseNormalizedAt = new Date().toISOString();
      show.titleCaseNormalizedFrom = changes[changes.length - 1].from;
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ count: changes.length, applied: APPLY, changes, deferred }, null, 2));
  } else {
    console.log(`ALL-CAPS title sweep: ${changes.length} show(s)${APPLY ? ' — WRITING' : ' (report-only, pass --apply to write)'}`);
    for (const c of changes) {
      console.log(`  ${c.openingDate || 'no-date'}  ${c.id}`);
      console.log(`      "${c.from}"`);
      console.log(`   -> "${c.to}"`);
    }
  }

  if (deferred.length) {
    console.log(`\n${deferred.length} title(s) DEFERRED for human casing (see MANUAL_REVIEW_IDS in lib/title-display-case.js):`);
    for (const d of deferred) console.log(`  ${d.id}  "${d.title}"`);
  }

  if (APPLY && changes.length) {
    // Preserve the file's trailing-newline convention.
    fs.writeFileSync(SHOWS_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`\nWrote ${SHOWS_PATH}`);
  }

  // Non-zero when untouched offenders remain, so this can gate CI if wanted.
  process.exit(!APPLY && changes.length ? 1 : 0);
}

main();
