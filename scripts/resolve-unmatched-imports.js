#!/usr/bin/env node
/**
 * Nightly self-heal resolver for the My Shows import flow.
 *
 * ImportShows.tsx logs every unmatched/low-confidence row (a show not in
 * diary-shows.json, or not confident enough) to the unmatched_imports table.
 * This script looks each one up on Mezzanine (theaterdiary.com) and, when it
 * finds a real production, appends it to data/diary-shows.json — so the next
 * time the same user re-imports the same export, it matches.
 *
 * Rows with mezz_show_id (from a Mezzanine export — entry.show.id) look up
 * that Show's Productions directly. Title-only rows (Show Score has no
 * Mezzanine id) search Mezzanine by normalized title instead.
 *
 * Usage:
 *   node scripts/resolve-unmatched-imports.js [--dry-run] [--limit=N] [--verbose]
 *
 * Environment variables:
 *   MEZZANINE_APP_ID, MEZZANINE_SESSION_TOKEN — Mezzanine Parse API
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase REST
 *
 * Exit codes: 0 success, 1 unexpected error, 2 Mezzanine auth failure
 * (session token expired — rotate via mitmproxy, see memory/feedback_mac_studio_cookies.md).
 */

const fs = require('fs');
const path = require('path');
const { selectRows, updateRows, deleteRows } = require('./lib/supabase-service-rest.js');
const { findProductionsForShow, findShowsByTitle, getObject, queryParse, sleep } = require('./lib/mezzanine-parse-client.js');
const { productionToDiaryEntry, buildDiarySlug } = require('./lib/mezzanine-classify.js');
const { normalizeTitle } = require('./lib/title-match.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 200;
const MAX_ATTEMPTS = 5;

const dataDir = path.join(__dirname, '..', 'data');
const showsPath = path.join(dataDir, 'shows.json');
const diaryShowsPath = path.join(dataDir, 'diary-shows.json');

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Pick the best-matching production out of several candidates for a row. */
function pickBestProduction(productions, row) {
  if (productions.length <= 1) return productions[0] || null;

  if (row.venue) {
    const wantVenue = row.venue.toLowerCase();
    const venueMatch = productions.find(p => {
      const name = (p.theater?.name || '').toLowerCase();
      return name && (name.includes(wantVenue) || wantVenue.includes(name));
    });
    if (venueMatch) return venueMatch;
  }

  if (row.date_seen) {
    const want = new Date(row.date_seen).getTime();
    let best = null, bestDiff = Infinity;
    for (const p of productions) {
      const opened = p.opened || p.firstPreview;
      const iso = typeof opened === 'string' ? opened : opened?.iso;
      if (!iso) continue;
      const diff = Math.abs(new Date(iso).getTime() - want);
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    if (best) return best;
  }

  // Multiple candidates, no venue or date signal to disambiguate them --
  // unlike ImportShows.tsx's interactive matcher (which shows the user a
  // preview to confirm), this runs unattended overnight. Guessing productions[0]
  // (arbitrary API order) risks silently cataloging the wrong revival/market;
  // leaving it unresolved for a human/re-import to sort out is the safer
  // failure mode (ship-check finding).
  return null;

  return productions[0];
}

/** Resolve one unmatched_imports row against Mezzanine. Mutates `ctx` on success. */
async function resolveRow(row, ctx) {
  let productions = [];

  if (row.mezz_show_id) {
    const show = await getObject('Show', row.mezz_show_id);
    if (!show) return { outcome: 'no-show' };
    productions = await findProductionsForShow(row.mezz_show_id);
  } else {
    // Mezzanine's searchableName field keeps a single space between words
    // (verified live 2026-07-14 while building card 174: 'cocktailmagique'
    // finds 0 shows, 'cocktail magique' finds 10) — stripping all whitespace
    // here silently broke every multi-word Show Score title resolution
    // since #170 shipped.
    const normalized = normalizeTitle(row.title);
    if (!normalized) return { outcome: 'no-title' };
    const candidateShows = await findShowsByTitle(normalized);
    if (candidateShows.length === 0) return { outcome: 'no-match' };
    for (const s of candidateShows.slice(0, 5)) {
      const prods = await findProductionsForShow(s.objectId);
      productions.push(...prods);
      await sleep(150);
    }
  }

  if (productions.length === 0) return { outcome: 'no-productions' };

  const best = pickBestProduction(productions, row);
  if (!best) return { outcome: 'no-productions' };

  if (ctx.existingMezzIds.has(best.objectId)) {
    const existing = ctx.diaryShows.find((s) => s.mezzanineId === best.objectId);
    return { outcome: 'already-cataloged', showId: existing?.id || null };
  }

  const entry = productionToDiaryEntry(best);
  if (!entry) return { outcome: 'broadway-skip' }; // belongs in shows.json, not diary-shows.json

  const slug = buildDiarySlug(entry.title, entry.category, entry.mezzanineId, ctx.usedSlugs);
  entry.id = slug;
  entry.slug = slug;

  ctx.diaryShows.push(entry);
  ctx.usedSlugs.add(slug);
  ctx.existingMezzIds.add(entry.mezzanineId);

  return { outcome: 'resolved', showId: slug };
}

/**
 * Drain user_show_stubs (card 174 Phase 2): a live-search "add this show"
 * click already wrote its id/title/venue to a stub row for instant
 * rendering. This turns it into a permanent diary-shows.json entry by
 * re-fetching the Production from Mezzanine (fresh ratingsCount/averageRating
 * for tierSearchResults ranking, rather than trusting client-supplied
 * numbers) and reusing the SAME id the stub was created with — any
 * review/watchlist row a user already wrote against that id keeps resolving
 * after promotion. Mutates `ctx` the same way resolveRow does.
 */
async function drainStub(row, ctx) {
  if (ctx.existingMezzIds.has(row.mezz_prod_id)) {
    return { outcome: 'already-cataloged' }; // another row/import already added this production
  }
  const res = await queryParse('Production', {
    where: { objectId: row.mezz_prod_id },
    include: 'show,theater',
    limit: 1,
    _method: 'GET',
  });
  const production = res.results?.[0];
  if (!production) return { outcome: 'no-production' };

  const entry = productionToDiaryEntry(production);
  // Defensive — mezzanine-search already filters Broadway candidates out of
  // search results, so this should be unreachable in practice. But if
  // Mezzanine's own classification of the production changes between
  // candidate-time and drain-time, this stub can NEVER resolve to a diary
  // entry — treat it like 'already-cataloged' (safe to delete) instead of
  // leaving it to be silently re-fetched and re-skipped every night forever.
  if (!entry) return { outcome: 'broadway-skip' };

  entry.id = row.id;
  entry.slug = row.id;

  ctx.diaryShows.push(entry);
  ctx.usedSlugs.add(entry.id);
  ctx.existingMezzIds.add(entry.mezzanineId);

  return { outcome: 'resolved' };
}

async function main() {
  console.log('Resolve Unmatched Imports');
  console.log('==========================\n');
  console.log(`Dry run: ${dryRun}, limit: ${LIMIT}\n`);

  const showsData = loadJson(showsPath, { shows: [] });
  const existingIds = new Set(showsData.shows.map((s) => s.id));
  const existingSlugs = new Set(showsData.shows.map((s) => s.slug));

  const diaryData = loadJson(diaryShowsPath, { shows: [] });
  const diaryShows = diaryData.shows;
  const existingMezzIds = new Set(diaryShows.map((s) => s.mezzanineId).filter(Boolean));
  const usedSlugs = new Set([...existingIds, ...existingSlugs, ...diaryShows.map((s) => s.slug)]);
  const ctx = { diaryShows, existingMezzIds, usedSlugs };

  const rows = await selectRows(
    'unmatched_imports',
    `select=*&resolved_at=is.null&attempt_count=lt.${MAX_ATTEMPTS}&order=created_at.asc&limit=${LIMIT}`,
  );
  console.log(`Fetched ${rows.length} pending unmatched_imports row(s)\n`);

  const stats = { resolved: 0, alreadyCataloged: 0, noMatch: 0, error: 0 };
  let authFailed = false;

  for (const row of rows) {
    try {
      const result = await resolveRow(row, ctx);
      if (verbose) console.log(`  [${row.id}] "${row.title}" (${row.source}) -> ${result.outcome}`);

      if (result.outcome === 'resolved' || result.outcome === 'already-cataloged') {
        if (result.outcome === 'resolved') stats.resolved++;
        else stats.alreadyCataloged++;
        if (!dryRun) {
          await updateRows('unmatched_imports', `id=eq.${row.id}`, {
            resolved_at: new Date().toISOString(),
            resolved_show_id: result.showId,
            last_attempted_at: new Date().toISOString(),
          });
        }
      } else {
        stats.noMatch++;
        if (!dryRun) {
          await updateRows('unmatched_imports', `id=eq.${row.id}`, {
            last_attempted_at: new Date().toISOString(),
            attempt_count: (row.attempt_count || 0) + 1,
          });
        }
      }
    } catch (err) {
      stats.error++;
      console.error(`  [${row.id}] ERROR: ${err.message}`);
      if (err.authFailed) {
        console.error('AUTH_FAILURE: Mezzanine session token expired.');
        // Break instead of exiting immediately -- rows resolved earlier in
        // this loop already had resolved_at written to Supabase (so they'll
        // never be re-queried), so diary-shows.json MUST be persisted below
        // before the process exits, or those entries vanish permanently.
        authFailed = true;
        break;
      }
    }
    await sleep(200); // be polite to theaterdiary.com
  }

  stats.stubsDrained = 0;
  stats.stubsSkipped = 0;
  // Ids to delete from user_show_stubs ONLY after diary-shows.json is
  // durably written below — deleting per-row inside this loop (the original
  // approach) meant a crash between a DELETE and the batched write below
  // destroyed the source row with nothing on disk to show for it (ship-check
  // finding). Deferring the delete makes a mid-loop crash safe: undeleted
  // stub rows just get re-drained (and re-deduped via existingMezzIds) next
  // run, same recovery story as unmatched_imports' resolved_at pattern.
  const stubIdsToDelete = [];
  if (!authFailed) {
    const stubs = await selectRows('user_show_stubs', 'select=*&order=created_at.asc&limit=200');
    console.log(`\nFetched ${stubs.length} pending user_show_stubs row(s)\n`);
    for (const row of stubs) {
      try {
        const result = await drainStub(row, ctx);
        if (verbose) console.log(`  [stub ${row.id}] -> ${result.outcome}`);
        if (result.outcome === 'resolved' || result.outcome === 'already-cataloged' || result.outcome === 'broadway-skip') {
          stats.stubsDrained++;
          if (!dryRun) stubIdsToDelete.push(row.id);
        } else {
          stats.stubsSkipped++; // left in place — retried next run, never silently dropped
        }
      } catch (err) {
        stats.error++;
        console.error(`  [stub ${row.id}] ERROR: ${err.message}`);
        if (err.authFailed) {
          console.error('AUTH_FAILURE: Mezzanine session token expired.');
          authFailed = true;
          break;
        }
      }
      await sleep(200);
    }
  }

  console.log('\n=== Stats ===');
  console.log(JSON.stringify(stats, null, 2));

  if ((stats.resolved > 0 || stats.stubsDrained > 0) && !dryRun) {
    const output = { shows: diaryShows, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(diaryShowsPath, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${diaryShowsPath} (${diaryShows.length} total shows, +${stats.resolved} resolved, +${stats.stubsDrained} stubs promoted)`);
    // Only now is it safe to delete the drained stub rows — the entries
    // they produced are durably on disk.
    for (const id of stubIdsToDelete) {
      try {
        await deleteRows('user_show_stubs', `id=eq.${encodeURIComponent(id)}`);
      } catch (err) {
        console.error(`  [stub ${id}] delete failed (will retry next run as 'already-cataloged'): ${err.message}`);
      }
    }
  } else if (dryRun) {
    console.log('\n[DRY RUN] No writes to diary-shows.json or Supabase.');
  } else {
    console.log('\nNo new entries -- diary-shows.json unchanged.');
  }

  if (authFailed) process.exit(2);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
