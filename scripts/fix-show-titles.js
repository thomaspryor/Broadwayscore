#!/usr/bin/env node
/**
 * Repair scrape-artifact show titles in shows.json (BRO-3863).
 *
 * Covers BOTH artifacts, in the order that composes correctly (see
 * scripts/lib/show-title-normalize.js):
 *   1. a venue/producing company the source appended as a disambiguator
 *      "The Cherry Orchard (Park Avenue Armory)" -> "The Cherry Orchard"
 *   2. a heading captured from CSS uppercase
 *      "AMERICA, WHO HURT YOU?" -> "America, Who Hurt You?"
 *
 * Report-only by default — rewriting a title is a visible, user-facing edit.
 * Pass --apply to write.
 *
 * Writes go through scripts/lib/shows-write-guard.js, NOT a bare
 * writeFileSync. ~20 Claude sessions and a fleet of crons share this
 * checkout; an unlocked read-modify-write on shows.json silently drops
 * whatever a concurrent writer committed between our read and our write.
 * The earlier draft of this script used fs.writeFileSync directly and would
 * have done exactly that.
 *
 * Usage:
 *   node scripts/fix-show-titles.js            # report (exit 1 if work remains)
 *   node scripts/fix-show-titles.js --apply    # write shows.json
 *   node scripts/fix-show-titles.js --json
 */

'use strict';

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');
const { classifyVenueSuffix } = require('./lib/title-venue-suffix');

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

function main() {
  const doc = loadShows();
  const shows = doc.shows || doc;

  // Oracle 2 (see title-venue-suffix.js) needs the whole corpus, and it is
  // built from the PRE-EDIT titles deliberately: stripping as we go must not
  // shrink the vocabulary that later rows are matched against.
  const venueVocabulary = buildVenueVocabulary(shows);

  const changes = [];
  const deferred = [];
  const nearMisses = [];

  for (const show of shows) {
    const result = normalizeShowTitle(show, { venueVocabulary });
    if (result.manualReview) deferred.push({ id: show.id, title: show.title });

    // A trailing parenthetical no oracle could classify. Not an error and
    // never auto-edited — reported so a human can judge it. "Othello
    // (Bedlam)" is the live example: a producing company that is also an
    // ordinary English word.
    if (!result.changed && /\([^()]+\)\s*$/.test(show.title || '')) {
      const m = show.title.match(/\(([^()]+)\)\s*$/);
      if (m && classifyVenueSuffix(show.title, { venue: show.venue, venueVocabulary }).action === 'none') {
        nearMisses.push({ id: show.id, title: show.title, paren: m[1] });
      }
    }

    if (!result.changed) continue;
    changes.push({
      id: show.id,
      from: show.title,
      to: result.title,
      steps: result.steps.map(s => s.kind + (s.oracle ? `:${s.oracle}` : '')),
      openingDate: show.openingDate || null,
    });

    if (APPLY) {
      // Breadcrumb so a later scrape of the same source can't silently shout
      // or re-venue it again without anyone noticing the flip-flop.
      show.titleNormalizedFrom = show.title;
      show.titleNormalizedAt = new Date().toISOString();
      show.title = result.title;
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ count: changes.length, applied: APPLY, changes, deferred, nearMisses }, null, 2));
  } else {
    console.log(`Show-title sweep: ${changes.length} show(s)${APPLY ? ' — WRITING' : ' (report-only, pass --apply to write)'}`);
    for (const c of changes) {
      console.log(`  ${c.openingDate || 'no-date'}  ${c.id}  [${c.steps.join(' + ')}]`);
      console.log(`      "${c.from}"`);
      console.log(`   -> "${c.to}"`);
    }
    if (deferred.length) {
      console.log(`\n${deferred.length} title(s) DEFERRED for human casing (MANUAL_REVIEW_IDS in lib/title-display-case.js):`);
      for (const d of deferred) console.log(`  ${d.id}  "${d.title}"`);
    }
    if (nearMisses.length) {
      console.log(`\n${nearMisses.length} trailing parenthetical(s) left alone — check if any is a venue we can't recognise:`);
      for (const n of nearMisses) console.log(`  ${n.id}  "${n.title}"   (${n.paren})`);
    }
  }

  if (APPLY && changes.length) {
    saveShows(doc);
    console.log(`\nWrote ${changes.length} title(s) via shows-write-guard.`);
  }

  // Non-zero when actionable offenders remain, so this can gate CI.
  // DEFERRED and NEAR-MISS rows are not failures: there is no automatic fix
  // for them, so failing on them would be a build nobody can turn green.
  process.exit(!APPLY && changes.length ? 1 : 0);
}

main();
