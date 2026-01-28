#!/usr/bin/env node
/**
 * Generate commercial data exports (JSON and CSV)
 * Sprint 4, Task 4.1
 *
 * Generates:
 * - public/data/commercial.json - Full commercial data with show metadata
 * - public/data/commercial.csv - Flattened for Excel users
 *
 * Run: node scripts/generate-commercial-export.js
 * Or via: npm run prebuild
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Load data files
const shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
const commercial = JSON.parse(fs.readFileSync(path.join(dataDir, 'commercial.json'), 'utf-8'));

// Helper: Get Broadway season for a date
function getSeason(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth();
  if (month >= 6) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// Build export data
const exportData = {
  _meta: {
    description: 'Broadway commercial/investment data export',
    generatedAt: new Date().toISOString(),
    source: 'Broadway Scorecard (broadwayscorecard.com)',
    dataLastUpdated: commercial._meta.lastUpdated,
    notes: 'Capitalization and running costs marked with isEstimate may be approximations from trade press',
  },
  shows: [],
};

// Create a map of shows for quick lookup
const showMap = new Map();
for (const show of shows.shows) {
  showMap.set(show.slug, show);
}

// Process each commercial entry
for (const [slug, data] of Object.entries(commercial.shows)) {
  const show = showMap.get(slug);

  const entry = {
    slug,
    title: show?.title || slug,
    status: show?.status || 'unknown',
    openingDate: show?.openingDate || null,
    closingDate: show?.closingDate || null,
    season: getSeason(show?.openingDate),
    venue: show?.venue || null,
    designation: data.designation,
    capitalization: data.capitalization,
    capitalizationSource: data.capitalizationSource || null,
    isCapitalizationEstimate: data.isEstimate?.capitalization || false,
    weeklyRunningCost: data.weeklyRunningCost,
    isRunningCostEstimate: data.isEstimate?.weeklyRunningCost || false,
    recouped: data.recouped,
    recoupedDate: data.recoupedDate,
    recoupedWeeks: data.recoupedWeeks,
    recoupedSource: data.recoupedSource || null,
    estimatedRecoupmentPctLow: data.estimatedRecoupmentPct?.[0] || null,
    estimatedRecoupmentPctHigh: data.estimatedRecoupmentPct?.[1] || null,
    notes: data.notes || null,
  };

  exportData.shows.push(entry);
}

// Sort by season (most recent first), then by title
exportData.shows.sort((a, b) => {
  if (a.season && b.season) {
    const seasonCmp = b.season.localeCompare(a.season);
    if (seasonCmp !== 0) return seasonCmp;
  } else if (a.season) {
    return -1;
  } else if (b.season) {
    return 1;
  }
  return a.title.localeCompare(b.title);
});

// Write JSON export
const jsonPath = path.join(outputDir, 'commercial.json');
fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
console.log(`✓ Generated ${jsonPath} (${exportData.shows.length} shows)`);

// Generate CSV
const csvHeaders = [
  'Show',
  'Slug',
  'Season',
  'Status',
  'Venue',
  'Designation',
  'Capitalization',
  'Cap. Estimated',
  'Weekly Running Cost',
  'Running Cost Est.',
  'Recouped',
  'Weeks to Recoup',
  'Recoup Date',
  'Est. Recoupment % Low',
  'Est. Recoupment % High',
  'Notes',
];

const csvRows = [csvHeaders.join(',')];

for (const show of exportData.shows) {
  const row = [
    `"${(show.title || '').replace(/"/g, '""')}"`,
    show.slug,
    show.season || '',
    show.status,
    `"${(show.venue || '').replace(/"/g, '""')}"`,
    show.designation,
    show.capitalization || '',
    show.isCapitalizationEstimate ? 'Yes' : '',
    show.weeklyRunningCost || '',
    show.isRunningCostEstimate ? 'Yes' : '',
    show.recouped === true ? 'Yes' : show.recouped === false ? 'No' : '',
    show.recoupedWeeks || '',
    show.recoupedDate || '',
    show.estimatedRecoupmentPctLow || '',
    show.estimatedRecoupmentPctHigh || '',
    `"${(show.notes || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
  ];
  csvRows.push(row.join(','));
}

const csvPath = path.join(outputDir, 'commercial.csv');
fs.writeFileSync(csvPath, csvRows.join('\n'));
console.log(`✓ Generated ${csvPath}`);

console.log('\nCommercial export complete!');
