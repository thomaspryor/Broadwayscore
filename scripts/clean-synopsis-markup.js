#!/usr/bin/env node
/**
 * One-shot script: Clean raw Wikipedia markup from existing synopses in shows.json.
 *
 * Applies stripWikiMarkup() to all synopses, then re-trims to proper length.
 * Reports what changed. Safe to run multiple times (idempotent).
 *
 * Usage:
 *   node scripts/clean-synopsis-markup.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { stripWikiMarkup, hasWikiMarkup, stripLeadingJunk } = require('./lib/wiki-utils');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Trim text to a clean synopsis: first 1-2 sentences, max 500 chars.
 * (Same logic as enrich-wikipedia-synopsis.js)
 */
function trimToSynopsis(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text.substring(0, 500);

  let synopsis = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 10) continue;
    if (/^(The musical|The play|The show|It) (was|is) (based on|adapted|written|composed|directed|produced|set)/i.test(trimmed) && synopsis.length === 0) {
      synopsis += trimmed + ' ';
    } else if (synopsis.length === 0 || (synopsis.length + trimmed.length) <= 450) {
      synopsis += trimmed + ' ';
    }
    if (synopsis.length >= 300) break;
  }

  synopsis = synopsis.trim();
  if (synopsis.length > 500) {
    synopsis = synopsis.substring(0, 497) + '...';
  }
  return synopsis;
}

function main() {
  const showsData = loadShows();
  const shows = showsData.shows;

  let cleaned = 0;
  let stillDirty = 0;
  const changes = [];

  for (const show of shows) {
    if (!show.synopsis) continue;

    const original = show.synopsis;

    // Step 1: Strip any remaining wiki markup
    let fixed = hasWikiMarkup(original) ? stripWikiMarkup(original) : original;

    // Step 2: Strip leading junk (image captions, scene markers, meta-notes)
    fixed = stripLeadingJunk(fixed);

    // Step 3: Only re-trim if content actually changed (avoids trimToSynopsis edge cases
    // with titles containing periods like "Dana H." or exclamation marks like "Oklahoma!")
    if (fixed !== original) {
      fixed = trimToSynopsis(fixed);
    }

    if (hasWikiMarkup(fixed)) {
      stillDirty++;
      changes.push({ id: show.id, status: 'STILL DIRTY', snippet: fixed.substring(0, 80) });
      if (!DRY_RUN) {
        show.synopsis = '';
      }
      continue;
    }

    if (fixed !== original) {
      cleaned++;
      changes.push({ id: show.id, status: 'CLEANED', snippet: fixed.substring(0, 80) });
      if (!DRY_RUN) {
        show.synopsis = fixed;
      }
    }
  }

  console.log('='.repeat(60));
  console.log('SYNOPSIS MARKUP CLEANUP');
  console.log('='.repeat(60));
  console.log(`Total shows: ${shows.length}`);
  console.log(`With synopsis: ${shows.filter(s => s.synopsis).length}`);
  console.log(`Cleaned: ${cleaned}`);
  console.log(`Still dirty (cleared): ${stillDirty}`);
  console.log(`DRY RUN: ${DRY_RUN}`);

  if (changes.length > 0) {
    console.log('\nChanges:');
    for (const c of changes) {
      console.log(`  ${c.status}: ${c.id} — ${c.snippet}...`);
    }
  }

  if (!DRY_RUN && (cleaned > 0 || stillDirty > 0)) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  }
}

main();
