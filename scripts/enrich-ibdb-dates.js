#!/usr/bin/env node
/**
 * IBDB Date & Creative Team Enrichment Script
 *
 * Enriches shows.json with accurate preview, opening, and closing dates
 * and creative team data from IBDB (Internet Broadway Database).
 *
 * Usage:
 *   node scripts/enrich-ibdb-dates.js [options]
 *
 * Options:
 *   --dry-run       Show what would change without modifying files
 *   --show=SLUG     Only process a specific show by slug
 *   --missing-only  Only fill in null/missing dates (default behavior)
 *   --verify        Compare IBDB dates vs shows.json, report discrepancies (no writes)
 *   --force         Overwrite all dates/creative team with IBDB values
 *   --status=STATUS   Filter by show status; comma-separated OK (open,previews,announced)
 *   --merge-credits   Merge new IBDB roles into existing creative teams (add missing roles only)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { lookupIBDBDates, batchLookupIBDBDates } = require('./lib/ibdb-dates');
const { cleanup } = require('./lib/scraper');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');
const { ibdbYearMismatch, expectedShowYear } = require('./lib/ibdb-year-guard');
const showsWriteGuard = require('./lib/shows-write-guard');
const { parseErrorLines, evaluateCommitDecision } = require('./lib/validation-setdiff');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-ibdb-dates.js — IBDB Date & Creative Team Enrichment Script.

Usage:
  node scripts/enrich-ibdb-dates.js [options]
  node scripts/enrich-ibdb-dates.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js's risky-call regex matches this file's own local saveShows(data) wrapper DECLARATION (`function saveShows(data) {`), not a call — the wrapper is only invoked from inside main(), well after the --help guard. Verified: node <this file> --help exits immediately with no fs/network side effects.
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const force = args.includes('--force');
const mergeCredits = args.includes('--merge-credits');
const missingOnly = !force; // Default: only fill missing

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

const statusArg = args.find(a => a.startsWith('--status='));
const statusFilter = statusArg ? statusArg.split('=')[1] : null;

function loadShows() {
  return showsWriteGuard.loadShows();
}

function saveShows(data) {
  showsWriteGuard.saveShows(data);
}

const REPO_ROOT = path.join(__dirname, '..');

// Runs validate-data.js as a subprocess and returns its combined output plus
// exit code, regardless of exit code — used to build error sets for the
// set-diff below (task #649). validate-data.js always process.exit()s, so it
// can't be require()'d as a library; execSync + catching the throw is the
// only way to capture output on a non-zero exit. The exit code feeds
// evaluateCommitDecision's crash-safety net: a crash/format-change that
// exits non-zero but prints nothing matching "❌ ERROR:" must not read as a
// clean pass.
function runValidateCapture() {
  try {
    const output = execSync('node scripts/validate-data.js', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { output, exitCode: 0 };
  } catch (e) {
    return { output: `${e.stdout || ''}${e.stderr || ''}`, exitCode: typeof e.status === 'number' ? e.status : 1 };
  }
}

// Mirrors the path validate-data.js and .github/actions/push-core-data use
// for the push-refusal sentinel. validate-data.js writes this file whenever
// it exits with ANY error, pre-existing or not — so when this run's
// post-enrichment error set introduces nothing new over the baseline, we
// must explicitly clear it ourselves or push-core-data's `if: always()`
// step stays blocked by a failure this run didn't cause (task #649).
function clearPushRefusalSentinel() {
  const sentinel = path.join(process.env.RUNNER_TEMP || '/tmp', '.skip-push-core-data');
  try {
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
  } catch (_) { /* non-fatal */ }
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('IBDB DATE ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${verify ? 'VERIFY' : dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('⚠️  FORCE mode: will overwrite existing dates');
  if (mergeCredits) console.log('🔀 MERGE mode: will add missing roles to existing creative teams');
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  if (statusFilter) console.log(`Status filter: ${statusFilter}`);
  console.log('');

  const data = loadShows();
  let shows = data.shows;

  // Apply filters
  if (showSlug) {
    shows = shows.filter(s => s.slug === showSlug || s.id === showSlug);
    if (shows.length === 0) {
      console.error(`❌ No show found with slug/id: ${showSlug}`);
      process.exit(1);
    }
  }

  if (statusFilter) {
    const wanted = statusFilter.split(',').map(s => s.trim()).filter(Boolean);
    shows = shows.filter(s => wanted.includes(s.status));
  }

  // Skip non-Broadway shows — IBDB only covers Broadway productions
  const preskip = shows.length;
  shows = shows.filter(s => !s.category || s.category === 'broadway');
  if (shows.length < preskip) {
    console.log(`Skipped ${preskip - shows.length} non-Broadway shows (IBDB is Broadway-only)`);
  }

  // If missing-only mode, filter to shows with incomplete dates or empty creative team
  if (missingOnly && !mergeCredits && !verify && !showSlug) {
    shows = shows.filter(s =>
      !s.previewsStartDate || !s.openingDate || !s.closingDate ||
      !s.creativeTeam || s.creativeTeam.length === 0
    );
  }

  console.log(`Shows to process: ${shows.length}`);
  console.log('');

  if (shows.length === 0) {
    console.log('✅ No shows need date enrichment');
    return;
  }

  // Prepare batch lookup
  const lookupList = shows.map(s => ({
    title: s.title,
    openingYear: s.openingDate ? parseInt(s.openingDate.split('-')[0]) : null,
    venue: s.venue,
    slug: s.slug,
    id: s.id,
    ibdbUrl: s.ibdbUrl || null  // Pass stored URL to avoid re-searching wrong production
  }));

  const ibdbResults = await batchLookupIBDBDates(lookupList);

  // Process results
  const changes = [];
  const discrepancies = [];
  let updated = 0;

  for (const show of shows) {
    const ibdb = ibdbResults.get(show.title);
    if (!ibdb) continue;

    // Wrong-production guard: IBDB matches by TITLE, so a new revival can match its ORIGINAL
    // production (a-few-good-men-2026 matched the 1989 staging and got stamped 1989 dates +
    // openingDateSource:ibdb, 2026-06-28). If the IBDB opening year is implausibly far from
    // this show's expected year, the whole match is the wrong production — skip it entirely
    // (dates AND ibdbUrl AND creativeTeam all belong to the other staging).
    if (ibdbYearMismatch(show, ibdb.openingDate)) {
      console.log(`  ⛔ ${show.title} (${show.id}): IBDB opening ${ibdb.openingDate} is implausible for this production (expected ~${expectedShowYear(show)}) — wrong-production match, skipping.`);
      continue;
    }

    // Allow processing if IBDB returned creative team even without dates
    const hasCreativeTeamData = ibdb.creativeTeam && ibdb.creativeTeam.length > 0;
    if (!ibdb.found && !hasCreativeTeamData) continue;

    const showChanges = [];

    // Store IBDB URL for audit trail (prevents re-matching wrong production on future runs)
    if (ibdb.ibdbUrl && ibdb.ibdbUrl !== show.ibdbUrl) {
      showChanges.push({
        field: 'ibdbUrl',
        old: show.ibdbUrl || 'null',
        new: ibdb.ibdbUrl
      });
    }

    // Check previewsStartDate
    if (ibdb.previewsStartDate) {
      if (!show.previewsStartDate) {
        showChanges.push({
          field: 'previewsStartDate',
          old: show.previewsStartDate,
          new: ibdb.previewsStartDate
        });
      } else if (show.previewsStartDate !== ibdb.previewsStartDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'previewsStartDate',
          current: show.previewsStartDate,
          ibdb: ibdb.previewsStartDate
        });
        if (force) {
          showChanges.push({
            field: 'previewsStartDate',
            old: show.previewsStartDate,
            new: ibdb.previewsStartDate
          });
        }
      }
    }

    // Check openingDate
    if (ibdb.openingDate) {
      if (!show.openingDate) {
        showChanges.push({
          field: 'openingDate',
          old: show.openingDate,
          new: ibdb.openingDate
        });
      } else if (show.openingDate !== ibdb.openingDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'openingDate',
          current: show.openingDate,
          ibdb: ibdb.openingDate
        });
        if (force) {
          showChanges.push({
            field: 'openingDate',
            old: show.openingDate,
            new: ibdb.openingDate
          });
        }
      }
    }

    // Check closingDate
    if (ibdb.closingDate) {
      if (!show.closingDate) {
        showChanges.push({
          field: 'closingDate',
          old: show.closingDate,
          new: ibdb.closingDate
        });
      } else if (show.closingDate !== ibdb.closingDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'closingDate',
          current: show.closingDate,
          ibdb: ibdb.closingDate
        });
        if (force) {
          showChanges.push({
            field: 'closingDate',
            old: show.closingDate,
            new: ibdb.closingDate
          });
        }
      }
    }

    // Check creativeTeam
    if (ibdb.creativeTeam && ibdb.creativeTeam.length > 0) {
      const hasCreativeTeam = show.creativeTeam && show.creativeTeam.length > 0;

      if (mergeCredits && hasCreativeTeam) {
        // Merge mode: add roles from IBDB that don't already exist
        const existingRoles = new Set((show.creativeTeam || []).map(e => e.role));
        const newRoles = ibdb.creativeTeam.filter(e => !existingRoles.has(e.role));

        if (newRoles.length > 0) {
          // Build merged array: insert new roles after Director, before design
          const designRoles = new Set([
            'Scenic Design', 'Costume Design', 'Lighting Design', 'Sound Design',
            'Projection Design', 'Video Design', 'Orchestrations',
            'Music Supervision', 'Music Direction', 'Original Score'
          ]);
          const existing = show.creativeTeam;
          let insertIdx = existing.length;
          for (let j = 0; j < existing.length; j++) {
            if (designRoles.has(existing[j].role)) { insertIdx = j; break; }
          }
          const dirIdx = existing.findLastIndex(e => e.role === 'Director');
          if (dirIdx >= 0 && dirIdx + 1 <= insertIdx) insertIdx = dirIdx + 1;

          const merged = [
            ...existing.slice(0, insertIdx),
            ...newRoles,
            ...existing.slice(insertIdx)
          ];
          showChanges.push({
            field: 'creativeTeam',
            old: `${existing.length} role(s)`,
            new: merged,
            newLabel: `${merged.length} role(s) (+${newRoles.length} merged: ${newRoles.map(r => r.role).join(', ')})`
          });
        }
      } else if (!hasCreativeTeam || force) {
        showChanges.push({
          field: 'creativeTeam',
          old: hasCreativeTeam ? `${show.creativeTeam.length} role(s)` : 'empty',
          new: ibdb.creativeTeam,
          newLabel: `${ibdb.creativeTeam.length} role(s)`
        });
      }
    }

    // Data integrity guards
    const filteredChanges = showChanges.filter(c => {
      // Never set previewsStartDate >= openingDate
      if (c.field === 'previewsStartDate' && ibdb.openingDate) {
        if (c.new >= ibdb.openingDate) {
          console.log(`  ⚠️  Skipping ${show.title}: previewsStartDate (${c.new}) >= openingDate (${ibdb.openingDate})`);
          return false;
        }
      }

      // Never overwrite non-null with null (unless --force)
      if (c.new === null && c.old !== null && !force) {
        return false;
      }

      return true;
    });

    if (filteredChanges.length > 0) {
      changes.push({ show: show.title, slug: show.slug, changes: filteredChanges });
    }
  }

  // Report discrepancies
  if (discrepancies.length > 0) {
    console.log('');
    console.log('📊 Date Discrepancies (shows.json vs IBDB):');
    console.log('-'.repeat(60));
    for (const d of discrepancies) {
      console.log(`  ${d.show} (${d.slug})`);
      console.log(`    ${d.field}: current=${d.current} → IBDB=${d.ibdb}`);
    }
    console.log('');
  }

  // Report planned changes
  if (changes.length > 0) {
    console.log('');
    console.log(`📝 ${verify ? 'Potential' : 'Planned'} Changes:`);
    console.log('-'.repeat(60));
    for (const c of changes) {
      console.log(`  ${c.show} (${c.slug}):`);
      for (const ch of c.changes) {
        const displayNew = ch.newLabel || ch.new;
        console.log(`    ${ch.field}: ${ch.old || 'null'} → ${displayNew}`);
      }
    }
    console.log('');
  }

  // Apply changes (unless dry-run or verify)
  if (!dryRun && !verify && changes.length > 0) {
    // Baseline BEFORE this run writes anything — lets the post-write check
    // below tell "this run introduced a new validation error" apart from "a
    // peripheral file was already broken" (same set-diff pattern as
    // update-show-status.yml's discovery gate). Scoped to the write branch
    // so a no-op run (changes.length === 0) never spends the extra
    // validate-data.js invocation or risks writing a sentinel this run
    // didn't earn (task #649).
    console.log('');
    console.log('Running baseline data validation (pre-enrichment)...');
    const baselineErrors = parseErrorLines(runValidateCapture().output);
    if (baselineErrors.length > 0) {
      console.log(`ℹ️  ${baselineErrors.length} pre-existing validation error(s) — will not block this run's commit unless it introduces NEW ones.`);
    }

    for (const c of changes) {
      const showRecord = data.shows.find(s => s.slug === c.slug);
      if (!showRecord) continue;

      for (const ch of c.changes) {
        if (ch.field === 'creativeTeam') {
          const { result } = splitCombinedCredits(ch.new);
          showRecord.creativeTeam = result; // ch.new is the array from IBDB, split combined names
        } else if (ch.field === 'closingDate') {
          // Route through guard so humanCorrectedClosingDate is honored.
          if (!writeClosingDate(showRecord, ch.new, 'IBDB enrichment')) {
            console.log(`    🔒 ${showRecord.id}: closingDate skipped (humanCorrectedClosingDate=true)`);
          }
        } else {
          showRecord[ch.field] = ch.new;
          // Stamp provenance alongside the date. Without this the show keeps
          // whatever (or no) source label it had, and date-source-confidence.js
          // puts null/''/undefined in ALWAYS_UNCONFIRMED — so an IBDB-confirmed
          // date is re-queued for correction forever and the currentSource
          // column in date-enrichment-corrections.json is unreliable for triage.
          // 71 shows carry an openingDate with no openingDateSource (2026-07-30).
          if (ch.field === 'openingDate') showRecord.openingDateSource = 'ibdb';
        }
      }
      updated++;
    }

    saveShows(data);
    console.log(`✅ Updated ${updated} show(s) in shows.json`);

    // Run validation, compared against the baseline above (task #649).
    // validate-data.js itself writes the push-refusal sentinel whenever
    // errors.length > 0 — pre-existing or not — so a run that introduces no
    // NEW error must explicitly clear it, or the workflow's
    // `if: always()` push-core-data step stays blocked by a failure this
    // run didn't cause.
    console.log('');
    console.log('Running data validation...');
    const { output: postOutput, exitCode: postExitCode } = runValidateCapture();
    const postErrors = parseErrorLines(postOutput);
    const { shouldCommit, newErrors, reason } = evaluateCommitDecision({ preErrors: baselineErrors, postErrors, postExitCode });
    if (shouldCommit) {
      console.log(`✅ Validation passed (${reason})`);
      if (postErrors.length > 0) {
        console.log('ℹ️  Clearing the push-refusal sentinel so the commit still lands (pre-existing errors are unrelated to this run).');
        clearPushRefusalSentinel();
      }
    } else {
      console.error(`❌ Validation failed! ${reason}`);
      newErrors.forEach((e, i) => console.error(`   ${i + 1}. ${e}`));
      process.exit(1);
    }
  } else if (changes.length === 0) {
    console.log('✅ No changes needed');
  } else {
    console.log(`ℹ️  ${changes.length} change(s) would be applied (${dryRun ? 'dry run' : 'verify mode'})`);
  }

  // Summary
  console.log('');
  console.log('📊 Summary:');
  console.log(`   Shows processed: ${shows.length}`);
  console.log(`   IBDB matches: ${Array.from(ibdbResults.values()).filter(r => r.found).length}`);
  console.log(`   Discrepancies: ${discrepancies.length}`);
  console.log(`   Changes ${verify || dryRun ? 'identified' : 'applied'}: ${changes.reduce((acc, c) => acc + c.changes.length, 0)}`);

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `shows_processed=${shows.length}\n`);
    fs.appendFileSync(outputFile, `ibdb_matches=${Array.from(ibdbResults.values()).filter(r => r.found).length}\n`);
    fs.appendFileSync(outputFile, `discrepancies=${discrepancies.length}\n`);
    fs.appendFileSync(outputFile, `changes_applied=${verify || dryRun ? 0 : changes.reduce((acc, c) => acc + c.changes.length, 0)}\n`);
  }
}

main()
  .catch(e => {
    console.error('IBDB enrichment failed:', e);
    process.exit(1);
  })
  .finally(() => {
    cleanup().catch(() => {});
  });
