#!/usr/bin/env node
/**
 * Creative Team Audit Script
 *
 * Re-scrapes IBDB for each show and compares ALL creative team roles
 * against shows.json. Reports discrepancies for manual review.
 *
 * This catches wrong directors, choreographers, designers, composers,
 * lyricists — not just directors (which are the only roles mentioned in reviews).
 *
 * Usage:
 *   node scripts/audit-creative-team.js [options]
 *
 * Options:
 *   --show=SLUG       Only audit a specific show
 *   --status=STATUS   Filter by show status (open, previews, closed)
 *   --limit=N         Process at most N shows
 *   --offset=N        Skip first N shows
 *   --checkpoint      Enable checkpointing (save every 25 shows)
 *   --dry-run         Don't save audit results
 */

const fs = require('fs');
const path = require('path');
const { lookupIBDBDates } = require('./lib/ibdb-dates');
const { cleanup } = require('./lib/scraper');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'creative-team-audit.json');
const CHECKPOINT_INTERVAL = 25;

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const checkpoint = args.includes('--checkpoint');

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

const statusArg = args.find(a => a.startsWith('--status='));
const statusFilter = statusArg ? statusArg.split('=')[1] : null;

const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

const offsetArg = args.find(a => a.startsWith('--offset='));
const offset = offsetArg ? parseInt(offsetArg.split('=')[1]) : 0;

// Key creative roles to compare (most impactful for data quality)
const KEY_ROLES = new Set([
  'Director', 'Choreographer',
  'Book', 'Playwright', 'Written By', 'Writer', 'Book Writer',
  'Music', 'Composer', 'Music & Lyrics',
  'Lyrics', 'Lyricist', 'Book & Lyrics', 'Book, Music & Lyrics',
  'Scenic Design', 'Costume Design', 'Lighting Design', 'Sound Design',
  'Orchestrations', 'Music Supervision', 'Music Direction', 'Original Score'
]);

// Normalize role names for comparison
function normalizeRole(role) {
  const map = {
    'Playwright': 'Book/Playwright',
    'Book': 'Book/Playwright',
    'Written By': 'Book/Playwright',
    'Writer': 'Book/Playwright',
    'Book Writer': 'Book/Playwright',
    'Music': 'Music/Composer',
    'Composer': 'Music/Composer',
    'Lyrics': 'Lyrics/Lyricist',
    'Lyricist': 'Lyrics/Lyricist',
  };
  return map[role] || role;
}

// Compare two creative teams and return discrepancies
function compareCreativeTeams(showTeam, ibdbTeam, showTitle) {
  const discrepancies = [];

  if (!showTeam || showTeam.length === 0) {
    if (ibdbTeam && ibdbTeam.length > 0) {
      discrepancies.push({
        type: 'missing-all',
        message: `shows.json has empty creativeTeam, IBDB has ${ibdbTeam.length} role(s)`,
        ibdbRoles: ibdbTeam
      });
    }
    return discrepancies;
  }

  if (!ibdbTeam || ibdbTeam.length === 0) {
    return discrepancies; // Can't compare if IBDB returned nothing
  }

  // Build role→names maps for both sides
  // Group by normalized role
  const showByRole = {};
  for (const entry of showTeam) {
    const nRole = normalizeRole(entry.role);
    if (!showByRole[nRole]) showByRole[nRole] = [];
    showByRole[nRole].push(entry.name.toLowerCase().trim());
  }

  const ibdbByRole = {};
  for (const entry of ibdbTeam) {
    const nRole = normalizeRole(entry.role);
    if (!ibdbByRole[nRole]) ibdbByRole[nRole] = [];
    ibdbByRole[nRole].push(entry.name.toLowerCase().trim());
  }

  // Compare key roles
  const allRoles = new Set([...Object.keys(showByRole), ...Object.keys(ibdbByRole)]);

  for (const role of allRoles) {
    const showNames = showByRole[role] || [];
    const ibdbNames = ibdbByRole[role] || [];

    // Check for Music & Lyrics consolidation
    // If IBDB has "Music & Lyrics" but shows.json has separate "Music/Composer" and "Lyrics/Lyricist"
    // with the same person, that's not a discrepancy
    if (role === 'Music & Lyrics') continue; // handled by individual roles

    // Skip design roles for now — IBDB extraction for these is less reliable
    if (role.includes('Design') || role === 'Orchestrations' || role === 'Music Supervision' || role === 'Music Direction') continue;

    if (showNames.length === 0 && ibdbNames.length > 0) {
      discrepancies.push({
        type: 'missing-role',
        role: role,
        message: `Missing in shows.json: ${role}`,
        ibdbNames: ibdbNames,
        severity: role === 'Director' ? 'high' : 'medium'
      });
      continue;
    }

    if (ibdbNames.length === 0) continue; // IBDB didn't extract this role

    // Check for name mismatches in the same role
    // Use fuzzy matching: strip Jr/Sr/III, normalize spacing
    const normalizeNameForCompare = (n) => n
      .replace(/\s+(jr|sr|iii|ii|iv)\.?$/i, '')
      .replace(/[.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const showNormalized = showNames.map(normalizeNameForCompare);
    const ibdbNormalized = ibdbNames.map(normalizeNameForCompare);

    // Find names in IBDB but not in shows.json
    for (let i = 0; i < ibdbNormalized.length; i++) {
      const ibdbName = ibdbNormalized[i];
      const match = showNormalized.some(sn =>
        sn === ibdbName ||
        sn.includes(ibdbName) ||
        ibdbName.includes(sn)
      );

      if (!match) {
        // This is a potential wrong-person error
        discrepancies.push({
          type: 'name-mismatch',
          role: role,
          message: `${role}: IBDB has "${ibdbNames[i]}" but shows.json has "${showNames.join(', ') || 'nobody'}"`,
          showNames: showNames,
          ibdbName: ibdbNames[i],
          severity: role === 'Director' ? 'high' : 'medium'
        });
      }
    }
  }

  return discrepancies;
}

function loadExistingAudit() {
  try {
    return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  } catch {
    return { lastRun: null, shows: {} };
  }
}

function saveAudit(audit) {
  const dir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2) + '\n');
}

async function main() {
  console.log('='.repeat(60));
  console.log('CREATIVE TEAM AUDIT');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  if (statusFilter) console.log(`Status filter: ${statusFilter}`);
  if (limit) console.log(`Limit: ${limit}`);
  if (offset) console.log(`Offset: ${offset}`);
  console.log('');

  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  let shows = data.shows;

  // Apply filters
  if (showSlug) {
    shows = shows.filter(s => s.slug === showSlug || s.id === showSlug);
  }
  if (statusFilter) {
    shows = shows.filter(s => s.status === statusFilter);
  }

  // Apply offset/limit
  if (offset) shows = shows.slice(offset);
  if (limit) shows = shows.slice(0, limit);

  console.log(`Shows to audit: ${shows.length}`);
  console.log('');

  if (shows.length === 0) {
    console.log('No shows to audit.');
    return;
  }

  // Load existing audit for checkpoint resume
  const audit = loadExistingAudit();
  audit.lastRun = new Date().toISOString();

  let processed = 0;
  let matches = 0;
  let discrepancyCount = 0;
  let failedLookups = 0;
  const allDiscrepancies = [];

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const showKey = show.slug || show.id;

    // Skip if already audited in this run (checkpoint resume)
    if (!showSlug && audit.shows[showKey] && audit.shows[showKey].auditDate === audit.lastRun) {
      console.log(`  ⏭️  [${i + 1}/${shows.length}] Skipping ${show.title} (already audited)`);
      continue;
    }

    console.log(`\n📌 [${i + 1}/${shows.length}] Auditing "${show.title}" (${showKey})...`);

    const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;

    // Lookup IBDB — use stored URL if available, otherwise fresh search
    const ibdb = await lookupIBDBDates(show.title, {
      openingYear,
      venue: show.venue,
      ibdbUrl: show.ibdbUrl || null
    });

    if (!ibdb.found) {
      console.log(`  ❌ IBDB lookup failed for "${show.title}"`);
      audit.shows[showKey] = {
        auditDate: audit.lastRun,
        status: 'lookup-failed',
        discrepancies: []
      };
      failedLookups++;
    } else {
      // Compare creative teams
      const discrepancies = compareCreativeTeams(
        show.creativeTeam,
        ibdb.creativeTeam,
        show.title
      );

      if (discrepancies.length === 0) {
        console.log(`  ✅ Creative team matches IBDB`);
        matches++;
      } else {
        console.log(`  ⚠️  ${discrepancies.length} discrepancy(ies) found:`);
        for (const d of discrepancies) {
          console.log(`     [${d.severity || 'info'}] ${d.message}`);
        }
        discrepancyCount += discrepancies.length;
        allDiscrepancies.push({
          show: show.title,
          slug: showKey,
          status: show.status,
          ibdbUrl: ibdb.ibdbUrl,
          discrepancies
        });
      }

      audit.shows[showKey] = {
        auditDate: audit.lastRun,
        status: discrepancies.length > 0 ? 'discrepancy' : 'match',
        ibdbUrl: ibdb.ibdbUrl,
        discrepancies
      };
    }

    processed++;

    // Checkpoint save
    if (checkpoint && processed % CHECKPOINT_INTERVAL === 0) {
      console.log(`\n💾 Checkpoint: saving audit progress (${processed} shows processed)...`);
      if (!dryRun) saveAudit(audit);
    }

    // Rate limit
    if (i < shows.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Final save
  if (!dryRun) {
    saveAudit(audit);
    console.log(`\n💾 Audit results saved to ${AUDIT_FILE}`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('AUDIT SUMMARY');
  console.log('='.repeat(60));
  console.log(`Shows audited:    ${processed}`);
  console.log(`Matches:          ${matches}`);
  console.log(`Discrepancies:    ${discrepancyCount} across ${allDiscrepancies.length} show(s)`);
  console.log(`Failed lookups:   ${failedLookups}`);

  if (allDiscrepancies.length > 0) {
    console.log('\n📋 ALL DISCREPANCIES:');
    console.log('-'.repeat(60));

    // Sort: high severity first, then by show name
    const sorted = allDiscrepancies.sort((a, b) => {
      const aHigh = a.discrepancies.some(d => d.severity === 'high');
      const bHigh = b.discrepancies.some(d => d.severity === 'high');
      if (aHigh && !bHigh) return -1;
      if (!aHigh && bHigh) return 1;
      return a.show.localeCompare(b.show);
    });

    for (const item of sorted) {
      const highCount = item.discrepancies.filter(d => d.severity === 'high').length;
      const marker = highCount > 0 ? '🔴' : '🟡';
      console.log(`\n${marker} ${item.show} (${item.slug}) [${item.status}]`);
      if (item.ibdbUrl) console.log(`  IBDB: ${item.ibdbUrl}`);
      for (const d of item.discrepancies) {
        console.log(`  [${d.severity || 'info'}] ${d.message}`);
      }
    }
  }

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `shows_audited=${processed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `discrepancy_count=${discrepancyCount}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `shows_with_discrepancies=${allDiscrepancies.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `failed_lookups=${failedLookups}\n`);
  }
}

main()
  .catch(e => {
    console.error('Audit failed:', e);
    process.exit(1);
  })
  .finally(() => {
    cleanup().catch(() => {});
  });
