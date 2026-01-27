#!/usr/bin/env node
/**
 * Identify unknown outlets that need to be added to the scoring database
 *
 * Usage: node scripts/identify-unknown-outlets.js
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Known outlets from src/config/scoring.ts (and common variants)
// These are the outlet IDs that have tier assignments
const KNOWN_OUTLET_IDS = new Set([
  // Tier 1
  'nyt', 'nytimes', 'thenewyork', 'newyorktimes',
  'washpost', 'wapo', 'washington-post',
  'latimes', 'lat', 'los-angeles-times',
  'wsj', 'wall-street-journal',
  'ap', 'associated-press',
  'variety',
  'thr', 'thehollywo', 'hollywood-reporter', 'the-hollywood-reporter',
  'vult', 'vulture', 'vu', 'nymag', 'new-york-magazine',
  'guardian',
  'timeoutny', 'timeout', 'time-out-new-york', 'timeoutnew',
  'bwaynews', 'broadway-news',

  // Tier 2
  'chtrib', 'chitrib', 'chicago-tribune',
  'usatoday', 'usa-today', 'usat',
  'nydn', 'new-york-daily-news', 'daily-news',
  'nyp', 'nypost', 'new-york-post', 'newyorkpos',
  'wrap', 'thewrap', 'the-wrap',
  'ew', 'entertainment-weekly',
  'indiewire',
  'deadline',
  'slant', 'slant-magazine',
  'tdb', 'daily-beast', 'the-daily-beast', 'thedailybe',
  'observer',
  'nythtr', 'nyt-theater', 'new-york-theater', 'nyth',
  'nytg', 'new-york-theatre-guide', 'nytheatreguide',
  'nysr', 'new-york-stage-review',
  'tman', 'theatermania', 'theaterman', 'theatrely',
  'thly', 'theatrely',

  // Tier 3
  'amny', 'am-new-york',
  'citi', 'cititour',
  'csce', 'culture-sauce',
  'frontmezz', 'front-mezzanine-junkies', 'frontmezzjunkies', 'fmj',
  'therecs', 'the-recs',
  'omc', 'one-minute-critic',
  'bww', 'broadwayworld', 'broadway-world',

  // Also known outlets from mapOutlet in scraper
  'forward',
  'stage-and-cinema', 'stageandcinema', 'stgcnma',
  'talkin-broadway', 'talkin--broadway', 'talkinbway', 'talkinbroadway',
  'dc-theatre-arts', 'dctheatrearts',
  'new-yorker', 'newyorker',

  // Additional known - Tier 2
  'newsday',
  'time', 'time-magazine',
  'rolling-stone', 'rollstone', 'rollingstone',
  'bloomberg',
  'vox',
  'slate',
  'people',
  'parade',
  'billboard',

  // Additional known - Tier 3
  'ny1',
  'curtainup',
  'theaterscene', 'theater-scene',
  'njcom', 'nj-com',
  'stagezine',
  'mashable',
  'huffpost', 'huffington-post',
  'backstage',
  'village-voice', 'villagevoice',
  'nbc', 'nbcny', 'nbc-new-york',
  'wnyc',
  'queerty',
  'medium',
  'exeunt',
  'towleroad',
  'northjersey',
]);

// Outlets that should be ignored (not real critic outlets)
const IGNORE_PATTERNS = [
  /^unknown$/i,
  /^advertisement$/i,
  /^the-times$/i,        // Usually refers to UK Times, not Broadway
  /^-uk$/i,              // UK outlets
  /-uk--/i,              // UK outlets
  /guardian-uk/i,
  /telegraph-uk/i,
  /times-uk/i,
  /independent-uk/i,
  /stage-uk/i,
  /london/i,
  /whatsonstage/i,
];

function shouldIgnore(outletId) {
  return IGNORE_PATTERNS.some(pattern => pattern.test(outletId));
}

function normalizeOutletId(id) {
  return id.toLowerCase()
    .replace(/^the-/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function main() {
  console.log('Scanning for unknown outlets in review-texts...\n');

  const unknownOutlets = new Map(); // outletId -> { files: [], outlets: Set, critics: Set }

  const showDirs = fs.readdirSync(reviewTextsDir)
    .filter(f => fs.statSync(path.join(reviewTextsDir, f)).isDirectory());

  for (const showId of showDirs) {
    const showDir = path.join(reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const match = file.match(/^([^-]+)--(.+)\.json$/);
      if (!match) continue;

      const [, outletId, criticId] = match;
      const normalized = normalizeOutletId(outletId);

      // Skip if known or should be ignored
      if (KNOWN_OUTLET_IDS.has(normalized) || KNOWN_OUTLET_IDS.has(outletId.toLowerCase())) {
        continue;
      }
      if (shouldIgnore(outletId)) {
        continue;
      }

      // Read file to get outlet name
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const outletName = data.outlet || outletId;

        if (!unknownOutlets.has(normalized)) {
          unknownOutlets.set(normalized, {
            files: [],
            outlets: new Set(),
            critics: new Set(),
          });
        }

        const entry = unknownOutlets.get(normalized);
        entry.files.push(`${showId}/${file}`);
        entry.outlets.add(outletName);
        entry.critics.add(data.criticName || criticId);
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  if (unknownOutlets.size === 0) {
    console.log('All outlets are known! No unknown outlets found.');
    return;
  }

  // Sort by number of files (most common first)
  const sorted = [...unknownOutlets.entries()]
    .sort((a, b) => b[1].files.length - a[1].files.length);

  console.log(`Found ${sorted.length} unknown outlets:\n`);
  console.log('=' .repeat(80));

  for (const [outletId, data] of sorted) {
    const outletNames = [...data.outlets].join(', ');
    const critics = [...data.critics].slice(0, 5).join(', ');
    const moreCount = data.critics.size > 5 ? ` (+${data.critics.size - 5} more)` : '';

    console.log(`\n${outletId.toUpperCase()} (${data.files.length} reviews)`);
    console.log(`  Names: ${outletNames}`);
    console.log(`  Critics: ${critics}${moreCount}`);
    console.log(`  Sample files:`);
    for (const file of data.files.slice(0, 3)) {
      console.log(`    - ${file}`);
    }
    if (data.files.length > 3) {
      console.log(`    ... and ${data.files.length - 3} more`);
    }
  }

  // Generate suggested additions to scoring.ts
  console.log('\n' + '=' .repeat(80));
  console.log('\nSuggested additions to src/config/scoring.ts:\n');
  console.log('// Add to OUTLET_TIERS (choose appropriate tier):');

  for (const [outletId, data] of sorted) {
    if (data.files.length >= 3) {
      const name = [...data.outlets][0] || outletId;
      const key = outletId.toUpperCase().replace(/-/g, '');
      console.log(`  '${key}': { tier: 3, name: '${name}', scoreFormat: 'text_bucket' },`);
    }
  }

  console.log('\n// Less common outlets (fewer than 3 reviews - may not need to add):');
  for (const [outletId, data] of sorted) {
    if (data.files.length < 3) {
      const name = [...data.outlets][0] || outletId;
      console.log(`  // ${outletId}: "${name}" (${data.files.length} review${data.files.length > 1 ? 's' : ''})`);
    }
  }
}

main();
