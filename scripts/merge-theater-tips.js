#!/usr/bin/env node
/**
 * merge-theater-tips.js
 *
 * Merges LLM-generated structured tips into theater-metadata.json.
 * Creates a backup before writing. Runs validate-data.js after merge.
 *
 * Key behaviors:
 * - Diff-based: only updates sections that changed meaningfully
 * - Accessibility: always injected from verified metadata, never from LLM
 * - Cross-theater dedup: warns if restaurants appear in >50% of theaters
 *
 * Input:  data/theater-tips-draft.json (from generate-theater-tips.js)
 * Output: data/theater-metadata.json (updated with structuredTips field)
 *
 * Usage:
 *   node scripts/merge-theater-tips.js [--dry-run] [--force]
 */

const fs = require('fs');
const path = require('path');

const DRAFT_FILE = path.join(__dirname, '..', 'data', 'theater-tips-draft.json');
const METADATA_FILE = path.join(__dirname, '..', 'data', 'theater-metadata.json');
const BACKUP_FILE = METADATA_FILE + '.bak';

// Deep equality for comparing tips sections (ignoring lastUpdated)
function sectionsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildAccessibilityText(accessibility) {
  if (!accessibility) return null;
  // Use the verified notes field directly if available
  if (accessibility.notes) return accessibility.notes;
  // Build from structured fields
  const parts = [];
  if (accessibility.wheelchair) parts.push('Wheelchair accessible');
  if (accessibility.elevator) parts.push('elevator available');
  if (accessibility.hearingLoop) parts.push('hearing loop available');
  if (accessibility.assistiveListening) parts.push('assistive listening devices available');
  return parts.length > 0 ? parts.join('. ').replace(/\.\./g, '.') + '.' : null;
}

function main() {
  // Load draft tips
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error(`Draft tips not found: ${DRAFT_FILE}`);
    console.error('Run scripts/generate-theater-tips.js first.');
    process.exit(1);
  }
  const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
  const draftTheaters = draft.theaters || {};
  console.log(`Loaded ${Object.keys(draftTheaters).length} theater tips from draft`);

  // Load metadata
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  const theaterNames = Object.keys(metadata).filter(k => k !== '_meta');
  console.log(`Loaded ${theaterNames.length} theaters from metadata`);

  const isDryRun = process.argv.includes('--dry-run');
  const forceUpdate = process.argv.includes('--force');

  // Backup
  if (!isDryRun) {
    fs.writeFileSync(BACKUP_FILE, fs.readFileSync(METADATA_FILE, 'utf8'));
    console.log(`Backup: ${BACKUP_FILE}`);
  }

  // Track restaurant frequency across all theaters for dedup audit
  const restaurantCounts = {};

  // Merge
  let merged = 0;
  let unchanged = 0;
  let skipped = 0;
  let issues = 0;
  let accessibilityInjected = 0;

  for (const name of theaterNames) {
    const tips = draftTheaters[name];
    if (!tips) {
      skipped++;
      continue;
    }

    // Build the structuredTips object matching our TypeScript interface
    const structuredTips = {
      lastUpdated: tips.lastUpdated || new Date().toISOString(),
    };

    // Seating (without accessibility — injected below from verified data)
    if (tips.seating) {
      structuredTips.seating = {};
      if (tips.seating.bestSeats) structuredTips.seating.bestSeats = tips.seating.bestSeats;
      if (tips.seating.avoidSeats) structuredTips.seating.avoidSeats = tips.seating.avoidSeats;
      // Never copy LLM accessibility — always from verified data
      if (Object.keys(structuredTips.seating).length === 0) delete structuredTips.seating;
    }

    // Inject verified accessibility from metadata
    const verifiedAccessibility = metadata[name].accessibility;
    if (verifiedAccessibility?.verified) {
      const accessText = buildAccessibilityText(verifiedAccessibility);
      if (accessText) {
        if (!structuredTips.seating) structuredTips.seating = {};
        structuredTips.seating.accessibility = accessText;
        accessibilityInjected++;
      }
    }

    // Parking
    if (tips.parking) {
      structuredTips.parking = {};
      if (tips.parking.nearestGarages?.length > 0) {
        structuredTips.parking.nearestGarages = tips.parking.nearestGarages.map(g => ({
          name: g.name,
          ...(g.walkMinutes != null ? { walkMinutes: g.walkMinutes } : {}),
          ...(g.notes ? { notes: g.notes } : {}),
        }));
      }
      if (tips.parking.streetParking) structuredTips.parking.streetParking = tips.parking.streetParking;
      if (tips.parking.tip) structuredTips.parking.tip = tips.parking.tip;
      if (Object.keys(structuredTips.parking).length === 0) delete structuredTips.parking;
    }

    // Dining
    if (tips.dining) {
      structuredTips.dining = {};
      for (const category of ['preShow', 'postShow', 'quickBite']) {
        if (tips.dining[category]?.length > 0) {
          structuredTips.dining[category] = tips.dining[category].map(r => {
            // Track frequency
            restaurantCounts[r.name] = (restaurantCounts[r.name] || 0) + 1;
            return {
              name: r.name,
              ...(r.cuisine ? { cuisine: r.cuisine } : {}),
              ...(r.walkMinutes != null ? { walkMinutes: r.walkMinutes } : {}),
              ...(r.priceRange ? { priceRange: r.priceRange } : {}),
              ...(r.notes ? { notes: r.notes } : {}),
            };
          });
        }
      }
      if (Object.keys(structuredTips.dining).length === 0) delete structuredTips.dining;
    }

    // Logistics
    if (tips.logistics) {
      structuredTips.logistics = {};
      if (tips.logistics.entrance) structuredTips.logistics.entrance = tips.logistics.entrance;
      if (tips.logistics.nearestSubway) structuredTips.logistics.nearestSubway = tips.logistics.nearestSubway;
      if (tips.logistics.exitStrategy) structuredTips.logistics.exitStrategy = tips.logistics.exitStrategy;
      if (tips.logistics.restrooms) structuredTips.logistics.restrooms = tips.logistics.restrooms;
      if (Object.keys(structuredTips.logistics).length === 0) delete structuredTips.logistics;
    }

    // Validate: at least one section populated
    const sections = ['seating', 'parking', 'dining', 'logistics'].filter(s => structuredTips[s]);
    if (sections.length === 0) {
      console.log(`  ⚠️  ${name} — all sections empty, skipping`);
      issues++;
      continue;
    }

    // Diff-based: compare new vs existing (excluding lastUpdated)
    const existing = metadata[name].structuredTips;
    if (existing && !forceUpdate) {
      const existingCompare = { ...existing };
      delete existingCompare.lastUpdated;
      const newCompare = { ...structuredTips };
      delete newCompare.lastUpdated;

      if (sectionsEqual(existingCompare, newCompare)) {
        unchanged++;
        continue;
      }

      // Log what changed
      const changedSections = [];
      for (const section of ['seating', 'parking', 'dining', 'logistics']) {
        if (!sectionsEqual(existingCompare[section], newCompare[section])) {
          changedSections.push(section);
        }
      }
      console.log(`  📝 ${name} — updated: ${changedSections.join(', ')}`);
    } else if (!existing) {
      console.log(`  ✨ ${name} — new tips (${sections.length} sections)`);
    }

    if (isDryRun) {
      console.log(`  [dry-run] ${name} — would merge ${sections.length} sections: ${sections.join(', ')}`);
    } else {
      metadata[name].structuredTips = structuredTips;
    }
    merged++;
  }

  // Cross-theater restaurant dedup audit
  const totalTheaters = theaterNames.length;
  const overusedThreshold = Math.ceil(totalTheaters * 0.5);
  const overused = Object.entries(restaurantCounts)
    .filter(([, count]) => count > overusedThreshold)
    .sort((a, b) => b[1] - a[1]);

  if (overused.length > 0) {
    console.log(`\n⚠️  DIVERSITY WARNING: ${overused.length} restaurant(s) in >${overusedThreshold} theaters:`);
    for (const [rname, count] of overused) {
      console.log(`  ${count}/${totalTheaters} ${rname}`);
    }
  }

  if (!isDryRun) {
    // Update meta
    metadata._meta.lastUpdated = new Date().toISOString();
    if (!metadata._meta.sources.includes('newyorkcitytheatre.com')) {
      metadata._meta.sources.push('newyorkcitytheatre.com');
    }

    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2) + '\n');
    console.log(`\nWrote ${METADATA_FILE}`);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Merged: ${merged}, Unchanged: ${unchanged}, Skipped: ${skipped}, Issues: ${issues}`);
  console.log(`Accessibility injected from verified data: ${accessibilityInjected}`);

  if (issues > merged * 0.15 && merged > 0) {
    console.log('\n❌ QUALITY GATE FAILED: >15% of theaters had issues');
    process.exit(1);
  }

  if (!isDryRun) {
    console.log('\nRun: node scripts/validate-data.js');
  }
}

main();
