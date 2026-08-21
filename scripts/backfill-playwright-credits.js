#!/usr/bin/env node
/**
 * Backfill Playwright Credits
 *
 * Enriches plays in shows.json with Playwright credits from IBDB.
 * Also normalizes role names and optionally splits combined credits.
 *
 * Usage:
 *   node scripts/backfill-playwright-credits.js [options]
 *
 * Options:
 *   --dry-run        Show what would change without modifying files
 *   --show=SLUG      Only process a specific show by slug
 *   --limit=N        Process at most N shows
 *   --split-credits  Also run credit splitting pass on all shows
 */

const fs = require('fs');
const path = require('path');
const { lookupIBDBDates } = require('./lib/ibdb-dates');
const { cleanup } = require('./lib/scraper');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { verifyCreativeTeamViaSerp } = require('./lib/creative-team-verify');
const showsWriteGuard = require('./lib/shows-write-guard');
const { pushWithRetry } = require('./lib/push-with-retry.js');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-playwright-credits.js — Backfill Playwright Credits.

Usage:
  node scripts/backfill-playwright-credits.js [options]
  node scripts/backfill-playwright-credits.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js's risky-call regex matches this file's own local saveShows(data) wrapper DECLARATION (`function saveShows(data) {`), not a call — the wrapper is only invoked from inside main(), well after the --help guard. Verified: node <this file> --help exits immediately with no fs/network side effects.
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const splitCreditsFlag = args.includes('--split-credits');

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

const CHECKPOINT_INTERVAL = 25;

function loadShows() {
  return showsWriteGuard.loadShows();
}

function saveShows(data) {
  showsWriteGuard.saveShows(data);
}

// ---------------------------------------------------------------------------
// Git checkpoint (CI only)
// ---------------------------------------------------------------------------

function gitCheckpoint(count, total, label) {
  if (!process.env.GITHUB_ACTIONS) return;

  const { execSync } = require('child_process');
  try {
    execSync('git add data/shows.json', { stdio: 'pipe' });
    const staged = execSync('git diff --cached --name-only', { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean).length;
    if (staged > 0) {
      execSync(`git commit -m "data: Playwright backfill checkpoint ${count}/${total} — ${label}"`, { stdio: 'pipe' });
      // Push through the shared helper (task #420). The hand-rolled push →
      // `git pull --rebase -X theirs` retry loop that lived here carried no
      // depth bound; backfill-playwright-credits.yml checks out at the default
      // fetch-depth: 1, and from a shallow clone that pull makes upload-pack
      // send the whole ~2.1 GB repo instead of the delta (#466).
      const { ok, stderr } = pushWithRetry({ branch: 'HEAD:main', retries: 5 });
      if (ok) {
        console.log(`  [GIT] Checkpoint ${count}/${total}: pushed (${label})`);
      } else {
        console.log(`  [GIT] Checkpoint ${count}/${total} push failed: ${stderr.split('\n').slice(-2).join(' ')}`);
      }
    }
  } catch (e) {
    console.log(`  [GIT] Checkpoint failed: ${e.message.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Role normalization
// ---------------------------------------------------------------------------

/**
 * Normalize role names to canonical forms.
 * Only applies to plays for playwright-related renames.
 */
function normalizeRoles(creativeTeam, showType) {
  if (!creativeTeam || creativeTeam.length === 0) return { team: [], changes: [] };

  const changes = [];
  const result = [];

  for (const entry of creativeTeam) {
    const role = entry.role;
    let newRole = role;

    // Playwright-related normalizations (plays only)
    if (showType === 'play') {
      if (role === 'Written By' || role === 'Writer') {
        newRole = 'Playwright';
      } else if (role === 'Book Writer') {
        newRole = 'Playwright';
      }
    }

    if (newRole !== role) {
      changes.push({ name: entry.name, from: role, to: newRole });
      result.push({ name: entry.name, role: newRole });
    } else {
      result.push(entry);
    }
  }

  return { team: result, changes };
}

// ---------------------------------------------------------------------------
// Creative team merging
// ---------------------------------------------------------------------------

/**
 * Merge new IBDB credits into existing creative team.
 * Only adds roles that don't already exist. Inserts after Director.
 */
function mergeCreativeTeam(existing, ibdbTeam, targetRole) {
  if (!ibdbTeam || ibdbTeam.length === 0) return { merged: existing, added: [] };

  // Find entries matching target role from IBDB
  const newEntries = ibdbTeam.filter(e => e.role === targetRole);
  if (newEntries.length === 0) return { merged: existing, added: [] };

  // Check if role already exists in current team
  const hasRole = existing.some(e => e.role === targetRole);
  if (hasRole) return { merged: existing, added: [] };

  // Find insertion point: after last Director entry, before design credits
  const designRoles = new Set([
    'Scenic Design', 'Costume Design', 'Lighting Design', 'Sound Design',
    'Projection Design', 'Video Design', 'Hair Design', 'Wig Design',
    'Orchestrations', 'Music Supervision', 'Music Direction',
    'Original Score'
  ]);

  let insertIdx = existing.length; // default: end
  for (let i = 0; i < existing.length; i++) {
    if (designRoles.has(existing[i].role)) {
      insertIdx = i;
      break;
    }
  }

  // Also try after Director
  const dirIdx = existing.findLastIndex(e => e.role === 'Director');
  if (dirIdx >= 0 && dirIdx + 1 <= insertIdx) {
    insertIdx = dirIdx + 1;
  }

  const merged = [
    ...existing.slice(0, insertIdx),
    ...newEntries,
    ...existing.slice(insertIdx)
  ];

  return { merged, added: newEntries };
}

// BRO-102 follow-up (task #1863): SERP-verifies IBDB-scraped Playwright
// credits before merging — the IBDB regex extraction can grab the wrong
// table cell or carry stale data, same failure class as the other
// ibdb.creativeTeam consumers. Returns { merged, added: [] } (no-op) when
// nothing survives verification. Splits combined names first — a combined
// "John Doe & Jane Smith" credit would otherwise be SERP-queried as one
// literal phrase and silently fail to confirm (same reasoning as
// discover-new-shows.js/enrich-ibdb-dates.js, ship-check 2026-08-20).
async function verifyAndMergePlaywright(show, ibdbCreativeTeam, year) {
  const playwrightEntries = (ibdbCreativeTeam || []).filter(e => e.role === 'Playwright');
  if (playwrightEntries.length === 0) return { merged: show.creativeTeam || [], added: [] };

  const { result: splitEntries } = splitCombinedCredits(playwrightEntries);
  const verified = await verifyCreativeTeamViaSerp(show, splitEntries, year, 'serp-verified-ibdb-playwright-backfill');
  if (verified.length === 0) return { merged: show.creativeTeam || [], added: [] };

  return mergeCreativeTeam(show.creativeTeam || [], verified, 'Playwright');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('PLAYWRIGHT CREDIT BACKFILL');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  if (limit) console.log(`Limit: ${limit}`);
  if (splitCreditsFlag) console.log('Credit splitting: enabled');
  console.log('');

  const data = loadShows();

  // --- Phase 1: Role normalization ---
  console.log('Phase 1: Role Normalization');
  console.log('-'.repeat(40));

  let normCount = 0;
  for (const show of data.shows) {
    if (showSlug && show.slug !== showSlug && show.id !== showSlug) continue;

    const { team, changes } = normalizeRoles(show.creativeTeam, show.type);
    if (changes.length > 0) {
      normCount += changes.length;
      console.log(`  ${show.title}:`);
      for (const c of changes) {
        console.log(`    "${c.name}": ${c.from} → ${c.to}`);
      }
      if (!dryRun) {
        show.creativeTeam = team;
      }
    }
  }
  console.log(`\nNormalized ${normCount} role(s)`);
  console.log('');

  // --- Phase 2: Playwright backfill from IBDB ---
  console.log('Phase 2: IBDB Playwright Backfill');
  console.log('-'.repeat(40));

  // Filter to plays missing Playwright credit
  let playsToEnrich = data.shows.filter(s => {
    if (s.type !== 'play') return false;
    if (showSlug && s.slug !== showSlug && s.id !== showSlug) return false;

    const ct = s.creativeTeam || [];
    const hasPlaywright = ct.some(e =>
      e.role === 'Playwright' || e.role === 'Written By' || e.role === 'Writer'
    );
    return !hasPlaywright;
  });

  if (limit && playsToEnrich.length > limit) {
    playsToEnrich = playsToEnrich.slice(0, limit);
  }

  console.log(`Plays missing Playwright credit: ${playsToEnrich.length}`);
  console.log('');

  if (playsToEnrich.length === 0) {
    console.log('No plays need Playwright backfill.');
  } else {
    let enriched = 0;
    let notFound = 0;
    let errors = 0;

    for (let i = 0; i < playsToEnrich.length; i++) {
      const show = playsToEnrich[i];
      const num = i + 1;

      console.log(`\n[${num}/${playsToEnrich.length}] "${show.title}" (${show.id})`);

      try {
        const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;

        const ibdb = await lookupIBDBDates(show.title, {
          openingYear,
          venue: show.venue
        });

        if (!ibdb.found && (!ibdb.creativeTeam || ibdb.creativeTeam.length === 0)) {
          console.log(`  ❌ No IBDB data found`);
          notFound++;
          continue;
        }

        // Look for Playwright in IBDB results
        const playwrightEntries = (ibdb.creativeTeam || []).filter(e => e.role === 'Playwright');

        if (playwrightEntries.length === 0) {
          console.log(`  ⚠️  IBDB found but no Playwright credit extracted`);
          notFound++;
          continue;
        }

        console.log(`  ✅ Found: ${playwrightEntries.map(e => e.name).join(', ')}`);

        if (!dryRun) {
          // Find the actual show record in data.shows
          const showRecord = data.shows.find(s => s.id === show.id);
          if (!showRecord) continue;

          const { merged, added } = await verifyAndMergePlaywright(
            showRecord,
            ibdb.creativeTeam,
            openingYear || 'upcoming'
          );

          if (added.length > 0) {
            showRecord.creativeTeam = merged;
            enriched++;
          }
        } else {
          enriched++;
        }
      } catch (e) {
        console.log(`  ⚠️  Error: ${e.message.slice(0, 80)}`);
        errors++;
      }

      // Checkpoint every CHECKPOINT_INTERVAL shows
      if (!dryRun && num % CHECKPOINT_INTERVAL === 0) {
        saveShows(data);
        gitCheckpoint(num, playsToEnrich.length, `${enriched} enriched`);
      }

      // Rate limit
      if (i < playsToEnrich.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Final save
    if (!dryRun && enriched > 0) {
      saveShows(data);
      gitCheckpoint(playsToEnrich.length, playsToEnrich.length, `${enriched} enriched (final)`);
    }

    console.log('');
    console.log('Phase 2 Summary:');
    console.log(`  Plays processed: ${playsToEnrich.length}`);
    console.log(`  Playwright added: ${enriched}`);
    console.log(`  Not found on IBDB: ${notFound}`);
    console.log(`  Errors: ${errors}`);
  }

  // --- Phase 3: Credit splitting (optional) ---
  if (splitCreditsFlag) {
    console.log('');
    console.log('Phase 3: Credit Splitting');
    console.log('-'.repeat(40));

    let splitTotal = 0;
    for (const show of data.shows) {
      if (showSlug && show.slug !== showSlug && show.id !== showSlug) continue;

      const { result, splitCount } = splitCombinedCredits(show.creativeTeam);
      if (splitCount > 0) {
        console.log(`  ${show.title}: ${splitCount} combined entry/entries split`);
        if (!dryRun) {
          show.creativeTeam = result;
        }
        splitTotal += splitCount;
      }
    }

    console.log(`\nSplit ${splitTotal} combined entries`);

    if (!dryRun && splitTotal > 0) {
      saveShows(data);
    }
  }

  // --- Final summary ---
  console.log('');
  console.log('='.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(60));

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `normalized=${normCount}\n`);
    fs.appendFileSync(outputFile, `plays_processed=${playsToEnrich ? playsToEnrich.length : 0}\n`);
  }
}

if (require.main === module) {
  main()
    .catch(e => {
      console.error('Backfill failed:', e);
      process.exit(1);
    })
    .finally(() => {
      cleanup().catch(() => {});
    });
}

// Exports for unit tests (task #1863) — verifyAndMergePlaywright is the
// SERP-verification gate for this file's IBDB Playwright-credit writes;
// tests exercise it directly against a mocked verifyCreativeTeamViaSerp
// rather than re-implementing its decision logic (CLAUDE.md rule 15).
module.exports = { verifyAndMergePlaywright, mergeCreativeTeam };
