#!/usr/bin/env node
/**
 * Repair scrape-artifact show titles in shows.json (BRO-3863 / BRO-3920).
 *
 * Auto-fixes ONE artifact:
 *   - a venue/producing company the source appended as a disambiguator
 *     "The Cherry Orchard (Park Avenue Armory)" -> "The Cherry Orchard"
 *
 * DETECTS but does not auto-fix a second artifact:
 *   - a shouted heading ("AMERICA, WHO HURT YOU?") that isn't the source's
 *     true casing. BRO-3920 retired the algorithmic title-caser that used to
 *     "fix" these — it already shipped wrong titles by guessing from the
 *     shouted string alone ("JUST FOR US" -> "Just for US"). These rows are
 *     reported as DEFERRED: look up the source's structured metadata
 *     (JSON-LD `name` / og:title, never a rendered heading) and correct the
 *     title by hand, or add the id to KEEP_SHOUTED_IDS in
 *     scripts/lib/title-display-case.js if the caps are genuinely branding.
 *
 * Report-only by default — rewriting a title is a visible, user-facing edit.
 * Pass --apply to write (venue-suffix repairs only; DEFERRED rows are never
 * written by this script).
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
const { hasHelpFlag } = require('./lib/cli-help.js');

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

const USAGE = `Repair scrape-artifact show titles in shows.json (BRO-3863).

Usage:
  node scripts/fix-show-titles.js            # report (exit 1 if work remains)
  node scripts/fix-show-titles.js --apply    # write shows.json
  node scripts/fix-show-titles.js --json
`;

function main() {
  if (hasHelpFlag(process.argv)) { console.log(USAGE); return; }
  const doc = loadShows();
  const shows = doc.shows || doc;

  // Oracle 2 (see title-venue-suffix.js) needs the whole corpus, and it is
  // built from the PRE-EDIT titles deliberately: stripping as we go must not
  // shrink the vocabulary that later rows are matched against.
  const venueVocabulary = buildVenueVocabulary(shows);

  const changes = [];
  const deferred = [];
  const nearMisses = [];
  const akaBackfills = [];

  // Search matches on `title` and `akaTitles` only (scripts/lib/show-search-match.js).
  // Stripping "(Park Avenue Armory)" therefore silently removes a string real
  // users type — and the venue is exactly how someone distinguishes one of
  // five Cherry Orchards. Keep the pre-normalisation title as an alias so
  // search coverage does not regress (adversarial review finding).
  // Self-healing and idempotent: it repairs rows an earlier run already
  // rewrote, not just the ones this run touches.
  function rememberOldTitle(show, oldTitle) {
    if (!oldTitle || oldTitle === show.title) return false;
    const aka = Array.isArray(show.akaTitles) ? show.akaTitles : [];
    if (aka.some(t => String(t).trim().toLowerCase() === oldTitle.trim().toLowerCase())) return false;
    if (APPLY) show.akaTitles = [...aka, oldTitle];
    return true;
  }

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

    // Repair rows a previous run rewrote before aliasing existed.
    if (!result.changed && show.titleNormalizedFrom) {
      if (rememberOldTitle(show, show.titleNormalizedFrom)) {
        akaBackfills.push({ id: show.id, aka: show.titleNormalizedFrom });
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

    const oldTitle = show.title;
    if (APPLY) {
      // Breadcrumb so a later scrape of the same source can't silently shout
      // or re-venue it again without anyone noticing the flip-flop.
      show.titleNormalizedFrom = oldTitle;
      show.titleNormalizedAt = new Date().toISOString();
      show.title = result.title;
      rememberOldTitle(show, oldTitle);
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
      console.log(`\n${deferred.length} title(s) DEFERRED — shouted, never auto-fixed (BRO-3920). Look up the source's structured metadata (JSON-LD/og:title) and correct by hand, or add to KEEP_SHOUTED_IDS in lib/title-display-case.js if the caps are real branding:`);
      for (const d of deferred) console.log(`  ${d.id}  "${d.title}"`);
    }
    if (akaBackfills.length) {
      console.log(`\n${akaBackfills.length} row(s) had their pre-normalisation title restored to akaTitles (search coverage):`);
      for (const a of akaBackfills) console.log(`  ${a.id}  aka "${a.aka}"`);
    }
    if (nearMisses.length) {
      console.log(`\n${nearMisses.length} trailing parenthetical(s) left alone — check if any is a venue we can't recognise:`);
      for (const n of nearMisses) console.log(`  ${n.id}  "${n.title}"   (${n.paren})`);
    }
  }

  if (APPLY && (changes.length || akaBackfills.length)) {
    saveShows(doc);
    console.log(`\nWrote ${changes.length} title(s) + ${akaBackfills.length} alias backfill(s) via shows-write-guard.`);
  }

  // Non-zero when actionable offenders remain, so this can gate CI.
  // DEFERRED and NEAR-MISS rows are not failures: there is no automatic fix
  // for them, so failing on them would be a build nobody can turn green.
  process.exit(!APPLY && (changes.length || akaBackfills.length) ? 1 : 0);
}

main();
