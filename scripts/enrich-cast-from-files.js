#!/usr/bin/env node
/**
 * Enrich shows.json cast arrays from existing data/cast/*.json files.
 *
 * Reads per-show IBDB cast files and writes simplified {name, role} arrays
 * into shows.json for mobile app and content-matching consumers.
 *
 * Zero network requests — purely local file transformation.
 *
 * Usage:
 *   node scripts/enrich-cast-from-files.js [options]
 *
 * Options:
 *   --dry-run           Show changes without writing
 *   --force             Overwrite existing cast entries
 *   --category=CAT      Filter: broadway, off-broadway, west-end (default: all)
 *   --status=STATUS     Filter: open, previews, closed (default: all)
 *   --max-members=N     Max principals per show (default: 15)
 *   --show-filter=ID    Process a single show by ID
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function getArgValue(prefix) {
  const arg = args.find(a => a.startsWith(prefix));
  if (!arg) return null;
  return arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
}

const categoryFilter = getArgValue('--category');
const statusFilter = getArgValue('--status');
const maxMembers = parseInt(getArgValue('--max-members') || '15', 10);
const showFilter = getArgValue('--show-filter');

// --- Filtering logic ---

// Roles that indicate non-principal cast (regex on full role string)
const NON_PRINCIPAL_ROLE_RE = /^(ensemble|performer|dancer|singer|chorus|swing)$/i;
const NON_PRINCIPAL_ROLE_CONTAINS_RE = /\b(ensemble|swing|standby|understudy|chorus)\b/i;

// Flags that indicate non-principal or excluded cast
const EXCLUDED_FLAGS = new Set([
  'Alternate',
  'Recorded voice only',
  'Movie Cast',
  'Was replaced in previews',
  'Role was cut during previews',
  'Movie Cast/Hollywood Cast',
  'Appeared in film sequence only',
]);
const EXCLUDED_FLAG_PARTIAL = ['at some performances'];

function isPrincipalCast(member, totalSourceSize) {
  const role = (member.role || '').trim();

  // For small casts (≤5 members), skip the exact-match generic role filter.
  // IBDB uses "Ensemble" or "Performer" as actual roles for solo shows (e.g.,
  // Every Brilliant Thing) and comedy specials (e.g., All Out). In big casts,
  // these labels genuinely mean non-principal ensemble.
  const isSmallCast = totalSourceSize <= 5;

  // For solo shows (1 cast member), replace generic roles with "Narrator"
  // One-person shows shouldn't display "Ensemble" — it's misleading
  if (totalSourceSize === 1 && /^(Ensemble|Performer|Cast)$/i.test(role)) {
    member.role = 'Narrator';
  }

  // Exact match on generic non-principal roles (skip for small casts)
  if (!isSmallCast && NON_PRINCIPAL_ROLE_RE.test(role)) return false;

  // Contains swing/standby/understudy/chorus as a word
  // For small casts, only filter on these clearly non-principal keywords
  // (not "ensemble"/"performer" which may be the actual role label)
  if (isSmallCast) {
    if (/\b(swing|standby|understudy|chorus)\b/i.test(role)) return false;
  } else {
    if (NON_PRINCIPAL_ROLE_CONTAINS_RE.test(role)) return false;
  }

  // Check flags
  const flags = member.flags || [];
  for (const flag of flags) {
    if (EXCLUDED_FLAGS.has(flag)) return false;
    for (const partial of EXCLUDED_FLAG_PARTIAL) {
      if (flag.toLowerCase().includes(partial)) return false;
    }
  }

  return true;
}

function extractCast(castData, showStatus) {
  const isOpen = showStatus === 'open' || showStatus === 'previews';

  // Choose source: currentCast for open shows, OBC for closed
  let source;
  if (isOpen && castData.currentCast && castData.currentCast.length > 0) {
    source = castData.currentCast;
  } else if (castData.openingNightCast && castData.openingNightCast.length > 0) {
    source = castData.openingNightCast;
  } else {
    return null; // No usable cast data
  }

  // Revue/ensemble detection: if ALL source members share the same generic role
  // (e.g. "Performer" for Celebrity Autobiography), IBDB is using the label as
  // the actual role name — treat all as principals instead of filtering out.
  const roles = new Set(source.map(m => (m.role || '').trim().toLowerCase()));
  const isUniformGenericRole = roles.size === 1 && NON_PRINCIPAL_ROLE_RE.test([...roles][0]);

  // Filter to principals only (pass total source size for small-cast exception)
  const principals = isUniformGenericRole
    ? source
    : source.filter(m => isPrincipalCast(m, source.length));
  if (principals.length === 0) return null;

  // Deduplicate by name (alternates/replacements may share a role)
  const seen = new Set();
  const deduped = principals.filter(m => {
    const key = m.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap at maxMembers
  const capped = deduped.slice(0, maxMembers);

  // Map to simple {name, role} format
  return capped.map(m => {
    const entry = { name: m.name };
    if (m.role) entry.role = m.role;
    return entry;
  });
}

// --- Main ---

function main() {
  console.log('='.repeat(60));
  console.log('ENRICH SHOWS.JSON CAST FROM CAST FILES');
  console.log('='.repeat(60));

  if (dryRun) console.log('  MODE: dry-run (no writes)');
  if (force) console.log('  MODE: force (overwrite existing)');
  if (categoryFilter) console.log('  Category filter:', categoryFilter);
  if (statusFilter) console.log('  Status filter:', statusFilter);
  if (showFilter) console.log('  Show filter:', showFilter);
  console.log('  Max members per show:', maxMembers);
  console.log('');

  // Load shows.json
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  let shows = showsData.shows;
  console.log(`Total shows in database: ${shows.length}`);

  // Check cast directory exists
  if (!fs.existsSync(CAST_DIR)) {
    console.error('Cast directory not found:', CAST_DIR);
    process.exit(1);
  }

  const castFiles = new Set(
    fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  );
  console.log(`Cast files found: ${castFiles.size}`);

  // Apply filters
  let targets = shows;
  if (showFilter) {
    targets = targets.filter(s => s.id === showFilter || s.slug === showFilter);
    if (targets.length === 0) {
      console.error(`No show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
  }
  if (categoryFilter) {
    targets = targets.filter(s => (s.category || 'broadway') === categoryFilter);
  }
  if (statusFilter) {
    targets = targets.filter(s => s.status === statusFilter);
  }

  console.log(`Shows after filters: ${targets.length}`);

  // Process
  let enriched = 0;
  let skippedExisting = 0;
  let skippedNoCastFile = 0;
  let skippedEmptySource = 0;
  let skippedNoPrincipals = 0;
  const enrichedShows = [];

  for (const show of targets) {
    // Skip if already has cast and not forcing
    if (show.cast && show.cast.length > 0 && !force) {
      skippedExisting++;
      continue;
    }

    // Check for cast file
    if (!castFiles.has(show.id)) {
      skippedNoCastFile++;
      continue;
    }

    // Load cast file
    let castData;
    try {
      castData = JSON.parse(fs.readFileSync(path.join(CAST_DIR, `${show.id}.json`), 'utf8'));
    } catch (e) {
      console.log(`  Warning: Failed to read cast file for ${show.id}: ${e.message}`);
      continue;
    }

    // Extract principal cast
    const cast = extractCast(castData, show.status);
    if (!cast || cast.length === 0) {
      skippedEmptySource++;
      continue;
    }

    // Validate: every entry must have a name string
    const valid = cast.every(c => typeof c.name === 'string' && c.name.length > 0);
    if (!valid) {
      console.log(`  Warning: Invalid cast entries for ${show.id}, skipping`);
      continue;
    }

    if (dryRun) {
      console.log(`  Would enrich: ${show.id} (${show.title}) — ${cast.length} members`);
    }

    show.cast = cast;
    enriched++;
    enrichedShows.push({ id: show.id, title: show.title, count: cast.length });
  }

  // Write
  if (!dryRun && enriched > 0) {
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nWrote shows.json with ${enriched} enriched cast arrays`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Enriched:              ${enriched}`);
  console.log(`  Skipped (existing):    ${skippedExisting}`);
  console.log(`  Skipped (no file):     ${skippedNoCastFile}`);
  console.log(`  Skipped (empty src):   ${skippedEmptySource}`);

  // Category breakdown
  if (!categoryFilter) {
    const byCat = {};
    for (const s of enrichedShows) {
      const show = shows.find(sh => sh.id === s.id);
      const cat = (show && show.category) || 'broadway';
      byCat[cat] = (byCat[cat] || 0) + 1;
    }
    if (Object.keys(byCat).length > 1) {
      console.log('\n  By category:');
      for (const [cat, count] of Object.entries(byCat).sort()) {
        console.log(`    ${cat}: ${count}`);
      }
    }
  }

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `enriched_count=${enriched}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `shows_processed=${targets.length}\n`);
  }

  console.log(`\nDone.`);
}

main();
