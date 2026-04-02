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
  'mark kennedy': { primary: 'ap', secondary: ['abc-news', 'collider', 'washington-times', 'minneapolis-star-tribune'] },
  'jennifer farrar': { primary: 'ap', secondary: ['abc-news', 'minneapolis-star-tribune'] },
};

// --- Known outlet pairs (derived from KNOWN_SYNDICATION) ---
// Maps "outletA|outletB" (sorted) → { primary, secondary, critic }
// Used to detect syndication when critic is "Unknown" — we match by outlet pair instead.
const KNOWN_OUTLET_PAIRS = {};
for (const [critic, config] of Object.entries(KNOWN_SYNDICATION)) {
  for (const sec of config.secondary) {
    const pair = [config.primary, sec].sort().join('|');
    KNOWN_OUTLET_PAIRS[pair] = { primary: config.primary, secondary: sec, critic };
  }
}

// --- AP wire syndication signals ---
// STRICT: requires strong signals that this IS an AP article, not just quoting one.
// Many reviews quote AP excerpts in roundup pages — those are NOT syndication.
const AP_STRONG_SIGNALS = [
  // AP byline at start: "By Mark Kennedy, AP" or "By Mark Kennedy\nAP Drama Writer"
  { regex: /(?:^|\n)\s*(?:by\s+)?(?:Mark Kennedy|Jennifer Farrar|Michael Kuchwara|Jocelyn Noveck),?\s*(?:AP|Associated Press)/im, where: 'head' },
  // "AP Drama/Theater Writer" byline near start
  { regex: /(?:^|\n)\s*(?:by\s+)?\w+ \w+\s*\n\s*AP (?:Drama|Theater|Theatre|Entertainment) (?:Writer|Critic)/im, where: 'head' },
  // AP credit at end: "Mark Kennedy is at twitter.com/KennedyTwits"
  { regex: /Kennedy is at (?:http|twitter)/i, where: 'tail' },
  // AP copyright at end
  { regex: /(?:Copyright|©).*Associated Press/i, where: 'tail' },
];

function detectAPContent(fullText) {
  if (!fullText || fullText.length < 100) return false;
  const head = fullText.slice(0, 300);
  const tail = fullText.slice(-300);
  for (const sig of AP_STRONG_SIGNALS) {
    const text = sig.where === 'head' ? head : tail;
    if (sig.regex.test(text)) return true;
  }
  return false;
}

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

// --- Unknown-critic outlet-pair scan ---
// When critic is "Unknown", match by known outlet pairs within the same show.
console.log('\n--- Unknown-Critic Outlet-Pair Scan ---');
const unknownByShow = {};
reviews.forEach(r => {
  if (r.criticName !== 'Unknown') return;
  if (SHOW_FILTER && r.showId !== SHOW_FILTER) return;
  if (!unknownByShow[r.showId]) unknownByShow[r.showId] = [];
  unknownByShow[r.showId].push(r);
});

let unknownPairsFlagged = 0;
for (const [showId, showRevs] of Object.entries(unknownByShow)) {
  const outlets = [...new Set(showRevs.map(r => r.outletId))];
  // Check all outlet pairs against KNOWN_OUTLET_PAIRS
  for (let i = 0; i < outlets.length; i++) {
    for (let j = i + 1; j < outlets.length; j++) {
      const pair = [outlets[i], outlets[j]].sort().join('|');
      const known = KNOWN_OUTLET_PAIRS[pair];
      if (!known) continue;

      // Find source files for both outlets (critic = Unknown)
      const f1 = findSourceFile(showId, outlets[i], 'Unknown');
      const f2 = findSourceFile(showId, outlets[j], 'Unknown');
      if (!f1 || !f2) continue;

      const sim = trigramSimilarity(f1.data.fullText, f2.data.fullText);
      if (sim < THRESHOLD) continue;

      // Determine primary/secondary from the known pair
      const primaryOutlet = known.primary;
      const secondaryOutlet = known.secondary;
      const primaryFile = outlets[i] === primaryOutlet ? f1 : f2;
      const secondaryFile = outlets[i] === primaryOutlet ? f2 : f1;

      // Skip if already flagged
      if (secondaryFile.data.isSyndicatedDuplicate) {
        alreadyFlagged.push({
          critic: `Unknown (likely ${known.critic})`, showId, primaryOutlet, secondaryOutlet, similarity: sim
        });
        continue;
      }

      flagged.push({
        critic: `Unknown (likely ${known.critic})`,
        showId,
        primaryOutlet,
        secondaryOutlet,
        primaryFile: primaryFile.filename,
        secondaryFile: secondaryFile.filename,
        similarity: sim,
        primaryScore: null,
        secondaryScore: null,
        scoreDiff: 0,
      });

      if (!DRY_RUN) {
        secondaryFile.data.isSyndicatedDuplicate = true;
        secondaryFile.data.syndicatedPrimaryFile = `${showId}/${primaryFile.filename}`;
        secondaryFile.data.syndicationSimilarity = sim;
        secondaryFile.data._matchedByOutletPair = true;
        fs.writeFileSync(secondaryFile.path, JSON.stringify(secondaryFile.data, null, 2) + '\n');
        filesWritten++;
      }
      unknownPairsFlagged++;
    }
  }
}
console.log(`Unknown-critic outlet-pair matches: ${unknownPairsFlagged}`);

// --- AP content scan (catches misattributed AP wire stories) ---
console.log('\n--- AP Content Scan ---');
let apFlagged = 0;
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
  if (SHOW_FILTER && d !== SHOW_FILTER) return false;
  return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory();
});

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    // Skip AP's own files — we only want to catch non-AP outlets with AP content
    if (file.startsWith('ap--')) continue;
    // Skip already-flagged files
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.isSyndicatedDuplicate || data.duplicateOf || data.crossOutletDuplicate) continue;
      if (data.wrongShow || data.wrongProduction) continue;

      if (data.fullText && detectAPContent(data.fullText)) {
        // Find the AP file for this show
        const apFile = files.find(f => f.startsWith('ap--'));
        const apRef = apFile ? `${showId}/${apFile}` : null;

        console.log(`  AP content in non-AP file: ${showId}/${file}${apRef ? ' → primary: ' + apRef : ''}`);

        if (!DRY_RUN) {
          data.isSyndicatedDuplicate = true;
          data.syndicatedPrimaryFile = apRef;
          data._apContentDetected = true;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
          filesWritten++;
        }

        flagged.push({
          critic: 'AP wire',
          showId,
          primaryOutlet: 'ap',
          secondaryOutlet: file.split('--')[0],
          primaryFile: apFile || 'unknown',
          secondaryFile: file,
          similarity: 100,
          primaryScore: null,
          secondaryScore: null,
          scoreDiff: 0,
        });
        apFlagged++;
      }
    } catch { /* skip corrupt files */ }
  }
}
console.log(`AP content detected in ${apFlagged} non-AP files`);

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

// --- Author mismatch scan ---
console.log('\n--- Author Mismatch Scan ---');
const BYLINE_PATTERNS = [
  // "By Name" as standalone line near start (not mid-sentence "by Name")
  { regex: /(?:^|\n)\s*(?:review )?by\s+([A-Z][a-z]{2,} [A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\s*(?:\n|$|,|\|)/m, where: 'head' },
  // "Name is a critic/writer/editor/theater correspondent" at end
  { regex: /([A-Z][a-z]{2,} [A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\s+is (?:a |an |the )?(?:theater |theatre |drama |entertainment )?(?:critic|writer|editor|reviewer|correspondent|columnist|contributor)\b/i, where: 'tail' },
  // "Reviewed by Name" as standalone pattern
  { regex: /\breviewed by\s+([A-Z][a-z]{2,} [A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\s*(?:\n|$|\.)/i, where: 'tail' },
];

let mismatchCount = 0;
const mismatches = [];

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.fullText || data.fullText.length < 100) continue;
      if (data.isSyndicatedDuplicate || data.duplicateOf || data.crossOutletDuplicate) continue;
      if (data.wrongShow || data.wrongProduction || data.isRoundupArticle) continue;

      // Extract critic name from filename
      const parts = file.replace('.json', '').split('--');
      if (parts.length < 2) continue;
      const fileCritic = parts[1].replace(/-/g, ' ').toLowerCase();
      if (fileCritic === 'unknown') continue;

      const head = data.fullText.slice(0, 300);
      const tail = data.fullText.slice(-500);

      for (const pattern of BYLINE_PATTERNS) {
        const textToCheck = pattern.where === 'head' ? head : pattern.where === 'tail' ? tail : data.fullText;
        const match = textToCheck.match(pattern.regex);
        if (!match) continue;

        const detectedAuthor = match[1].toLowerCase().trim();
        // Check if detected author matches file critic (fuzzy — first+last name, nickname tolerance)
        const detectedParts = detectedAuthor.split(/\s+/);
        const fileParts = fileCritic.split(/\s+/);
        const lastNameMatch = detectedParts[detectedParts.length - 1] === fileParts[fileParts.length - 1];
        const firstNameMatch = detectedParts[0] === fileParts[0];
        // Nickname tolerance: "steve" matches "steven", "vicki" matches "victoria", etc.
        const firstNameStartMatch = detectedParts[0].slice(0, 3) === fileParts[0].slice(0, 3);

        // Skip if any name part matches (exact or nickname prefix)
        if (lastNameMatch || firstNameMatch || (firstNameStartMatch && detectedParts[detectedParts.length - 1] === fileParts[fileParts.length - 1])) {
          continue; // Names match — not a mismatch
        }
        {
          mismatchCount++;
          mismatches.push({
            showId, file,
            fileCritic: parts[1],
            detectedAuthor: match[1],
            pattern: pattern.where,
          });
          if (VERBOSE) {
            console.log(`  MISMATCH: ${showId}/${file} — file says "${parts[1]}", text says "${match[1]}"`);
          }
          break; // One mismatch per file is enough
        }
      }
    } catch { /* skip */ }
  }
}

console.log(`Author mismatches found: ${mismatchCount}`);
if (mismatchCount > 0 && !VERBOSE) {
  console.log('  (run with --verbose to see details)');
  // Show first 10
  for (const m of mismatches.slice(0, 10)) {
    console.log(`  ${m.showId}/${m.file}: file="${m.fileCritic}" text="${m.detectedAuthor}"`);
  }
  if (mismatches.length > 10) console.log(`  ... and ${mismatches.length - 10} more`);
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
    count: flagged.filter(f => f.critic.toLowerCase() === critic || f.critic.toLowerCase() === `unknown (likely ${critic})`).length,
  })),
  flagged: flagged.sort((a, b) => a.critic.localeCompare(b.critic) || a.showId.localeCompare(b.showId)),
  authorMismatches: mismatches,
};

if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
const reportPath = path.join(AUDIT_DIR, 'syndicated-duplicates.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\nAudit report: ${reportPath}`);
console.log('\nDone.');
