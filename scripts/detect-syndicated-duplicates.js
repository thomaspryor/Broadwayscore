#!/usr/bin/env node
/**
 * Detect Syndicated Duplicate Reviews
 *
 * Finds reviews where the same critic publishes substantially similar text
 * at multiple outlets (syndication). Marks the secondary outlet's copy with
 * `isSyndicatedDuplicate: true` + `syndicatedPrimaryFile` so rebuild skips it.
 *
 * The primary outlet is chosen by: higher tier > more text > alphabetical.
 * Known syndication pairs are hardcoded for determinism.
 *
 * Usage:
 *   node scripts/detect-syndicated-duplicates.js [options]
 *
 * Options:
 *   --dry-run       Log what would change without writing files
 *   --show=SLUG     Only process one show
 *   --threshold=N   Similarity threshold 0-100 (default: 50)
 *   --verbose       Extra logging
 *   --report        Generate audit report only (implies --dry-run)
 */
const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('--report');
const REPORT = args.includes('--report');
const VERBOSE = args.includes('--verbose');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const THRESHOLD = parseInt((args.find(a => a.startsWith('--threshold=')) || '').split('=')[1]) || 50;

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_DIR = path.join(__dirname, '../data/audit');

// --- Known syndication pairs ---
// Maps critic → { primary: outlet, secondary: [outlets] }
// Primary is the outlet we keep; secondary copies get flagged.
const KNOWN_SYNDICATION = {
  'chris jones': { primary: 'chicagotribune', secondary: ['nydailynews'] },
  'kathleen campion': { primary: 'nytg', secondary: ['front-row-center'] },
  'tulis mccall': { primary: 'nytg', secondary: ['front-row-center'] },
  'stanford friedman': { primary: 'nytg', secondary: ['front-row-center'] },
  'david rooney': { primary: 'hollywood-reporter', secondary: ['reuters'] },
  'alexandra lipari': { primary: 'newsday', secondary: ['entertainmenthour'] },
  'zachary stewart': { primary: 'theatermania', secondary: ['whatsonstage'] },
  'david gordon': { primary: 'theatermania', secondary: ['whatsonstage'] },
};

// Outlet tier lookup — reads from outlet-registry.json (source of truth)
const { getTier } = require('./lib/outlet-tiers');

// --- Text similarity (word trigram Jaccard) ---
function trigramSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const words1 = text1.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const words2 = text2.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (words1.length < 10 || words2.length < 10) return 0;

  const trigrams1 = new Set();
  const trigrams2 = new Set();
  for (let i = 0; i < words1.length - 2; i++) trigrams1.add(words1.slice(i, i + 3).join(' '));
  for (let i = 0; i < words2.length - 2; i++) trigrams2.add(words2.slice(i, i + 3).join(' '));

  let intersection = 0;
  for (const t of trigrams1) if (trigrams2.has(t)) intersection++;
  return Math.round(100 * intersection / (trigrams1.size + trigrams2.size - intersection));
}

// --- Main ---
console.log('=== Detect Syndicated Duplicate Reviews ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | Threshold: ${THRESHOLD}%`);
if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
console.log('');

// Load reviews.json for critic+outlet+show mapping
const reviewsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reviews.json'), 'utf8'));
const reviews = reviewsData.reviews;

// Group reviews by critic+show (excluding Unknown)
const criticShowGroups = {};
reviews.forEach(r => {
  if (!r.criticName || r.criticName === 'Unknown') return;
  if (SHOW_FILTER && r.showId !== SHOW_FILTER) return;
  const key = `${r.criticName.toLowerCase()}|${r.showId}`;
  if (!criticShowGroups[key]) criticShowGroups[key] = [];
  criticShowGroups[key].push(r);
});

// Filter to multi-outlet only
const multiOutlet = Object.entries(criticShowGroups).filter(([, revs]) => {
  const outlets = new Set(revs.map(r => r.outletId));
  return outlets.size >= 2;
});

console.log(`Found ${multiOutlet.length} critic+show combos with 2+ outlets\n`);

// Find source files for each review
function findSourceFile(showId, outletId, criticName) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  try {
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      if (!file.startsWith(outletId + '--')) continue;
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.criticName && data.criticName.toLowerCase() === criticName.toLowerCase()) {
          return { path: filePath, filename: file, data };
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* show dir issues */ }
  return null;
}

// Determine which outlet to keep for a given pair
function choosePrimary(critic, outlet1, outlet2) {
  const normCritic = critic.toLowerCase();
  const known = KNOWN_SYNDICATION[normCritic];
  if (known) {
    if (known.secondary.includes(outlet1)) return outlet2;
    if (known.secondary.includes(outlet2)) return outlet1;
  }
  // Fallback: higher tier wins, then alphabetical
  const t1 = getTier(outlet1);
  const t2 = getTier(outlet2);
  if (t1 !== t2) return t1 < t2 ? outlet1 : outlet2;
  return outlet1 < outlet2 ? outlet1 : outlet2;
}

const flagged = [];
const alreadyFlagged = [];
let filesWritten = 0;

for (const [key, revs] of multiOutlet) {
  const outlets = [...new Set(revs.map(r => r.outletId))];
  const critic = revs[0].criticName;

  // Compare all outlet pairs
  for (let i = 0; i < outlets.length; i++) {
    for (let j = i + 1; j < outlets.length; j++) {
      const o1 = outlets[i];
      const o2 = outlets[j];

      const f1 = findSourceFile(revs[0].showId, o1, critic);
      const f2 = findSourceFile(revs[0].showId, o2, critic);
      if (!f1 || !f2) continue;

      const t1 = f1.data.fullText;
      const t2 = f2.data.fullText;
      const sim = trigramSimilarity(t1, t2);

      if (sim < THRESHOLD) continue;

      // This is syndication
      const primaryOutlet = choosePrimary(critic, o1, o2);
      const secondaryOutlet = primaryOutlet === o1 ? o2 : o1;
      const primaryFile = primaryOutlet === o1 ? f1 : f2;
      const secondaryFile = primaryOutlet === o1 ? f2 : f1;

      // Check if already flagged
      if (secondaryFile.data.isSyndicatedDuplicate) {
        alreadyFlagged.push({
          critic, showId: revs[0].showId, primaryOutlet, secondaryOutlet, similarity: sim
        });
        continue;
      }

      const r1 = revs.find(r => r.outletId === primaryOutlet);
      const r2 = revs.find(r => r.outletId === secondaryOutlet);

      flagged.push({
        critic: r1 ? r1.criticName : critic,
        showId: revs[0].showId,
        primaryOutlet,
        secondaryOutlet,
        primaryFile: primaryFile.filename,
        secondaryFile: secondaryFile.filename,
        similarity: sim,
        primaryScore: r1 ? r1.assignedScore : null,
        secondaryScore: r2 ? r2.assignedScore : null,
        scoreDiff: Math.abs((r1?.assignedScore || 0) - (r2?.assignedScore || 0)),
      });

      // Write the flag to the secondary file
      if (!DRY_RUN) {
        secondaryFile.data.isSyndicatedDuplicate = true;
        secondaryFile.data.syndicatedPrimaryFile = `${primaryFile.data.showId || revs[0].showId}/${primaryFile.filename}`;
        secondaryFile.data.syndicationSimilarity = sim;
        fs.writeFileSync(secondaryFile.path, JSON.stringify(secondaryFile.data, null, 2) + '\n');
        filesWritten++;
      }
    }
  }
}

// --- Results ---
console.log(`\n=== RESULTS ===`);
console.log(`New syndicated duplicates found: ${flagged.length}`);
console.log(`Already flagged: ${alreadyFlagged.length}`);
if (!DRY_RUN) console.log(`Files written: ${filesWritten}`);

if (flagged.length > 0) {
  console.log('\n--- Flagged ---');
  const byCritic = {};
  flagged.forEach(f => {
    if (!byCritic[f.critic]) byCritic[f.critic] = [];
    byCritic[f.critic].push(f);
  });

  for (const [critic, items] of Object.entries(byCritic).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${critic} (${items.length} syndicated):`);
    console.log(`    Pattern: keep ${items[0].primaryOutlet}, flag ${items[0].secondaryOutlet}`);
    if (VERBOSE) {
      items.forEach(f => {
        console.log(`    ${f.showId}: sim=${f.similarity}% scores=${f.primaryScore}/${f.secondaryScore} (diff=${f.scoreDiff})`);
      });
    } else {
      const avgSim = Math.round(items.reduce((s, f) => s + f.similarity, 0) / items.length);
      const avgDiff = (items.reduce((s, f) => s + f.scoreDiff, 0) / items.length).toFixed(1);
      console.log(`    Avg similarity: ${avgSim}% | Avg score diff: ${avgDiff} pts`);
    }
  }
}

// --- Score impact summary ---
if (flagged.length > 0) {
  const totalScoreDiff = flagged.reduce((s, f) => s + f.scoreDiff, 0);
  console.log('\n--- Score Impact ---');
  console.log(`Total pairs: ${flagged.length}`);
  console.log(`Avg score diff: ${(totalScoreDiff / flagged.length).toFixed(1)} pts`);
  console.log(`Same score: ${flagged.filter(f => f.scoreDiff === 0).length}`);
  console.log(`>5 pt diff: ${flagged.filter(f => f.scoreDiff > 5).length}`);
  console.log(`>10 pt diff: ${flagged.filter(f => f.scoreDiff > 10).length}`);
}

// --- Write audit report ---
const report = {
  generatedAt: new Date().toISOString(),
  threshold: THRESHOLD,
  summary: {
    totalSyndicatedPairs: flagged.length + alreadyFlagged.length,
    newlyFlagged: flagged.length,
    alreadyFlagged: alreadyFlagged.length,
    criticsAffected: [...new Set(flagged.map(f => f.critic))].length,
    showsAffected: [...new Set(flagged.map(f => f.showId))].length,
    avgSimilarity: flagged.length ? Math.round(flagged.reduce((s, f) => s + f.similarity, 0) / flagged.length) : 0,
    avgScoreDiff: flagged.length ? parseFloat((flagged.reduce((s, f) => s + f.scoreDiff, 0) / flagged.length).toFixed(1)) : 0,
  },
  syndicationPairs: Object.entries(KNOWN_SYNDICATION).map(([critic, config]) => ({
    critic,
    primaryOutlet: config.primary,
    secondaryOutlets: config.secondary,
    count: flagged.filter(f => f.critic.toLowerCase() === critic).length,
  })),
  flagged: flagged.sort((a, b) => a.critic.localeCompare(b.critic) || a.showId.localeCompare(b.showId)),
};

if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
const reportPath = path.join(AUDIT_DIR, 'syndicated-duplicates.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\nAudit report: ${reportPath}`);
console.log('\nDone.');
