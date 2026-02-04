#!/usr/bin/env node
/**
 * cleanup-duplicate-text.js
 *
 * Fixes 14 same-outlet duplicate-text pairs where two files at the same outlet
 * have identical fullText but different critic names. In each case, one critic
 * is correct and the other is a misattribution from an aggregator source.
 *
 * Actions:
 * - Merges useful metadata (fullText, excerpts, scores) from duplicate → original
 * - Deletes the misattributed duplicate file
 * - Clears false-positive duplicateTextOf flags
 *
 * Usage:
 *   node scripts/cleanup-duplicate-text.js --dry-run   # Preview changes
 *   node scripts/cleanup-duplicate-text.js --apply      # Execute changes
 */

const fs = require("fs");
const path = require("path");

const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");

if (!dryRun && !apply) {
  console.log("Usage: node scripts/cleanup-duplicate-text.js [--dry-run | --apply]");
  process.exit(1);
}

const REVIEW_DIR = "data/review-texts";

// Each entry: { show, keep, delete, reason, mergeFullText?, mergeExcerpts? }
const PAIRS = [
  {
    show: "appropriate-2023",
    keep: "deadline--greg-evans.json",
    delete: "deadline--pete-hammond.json",
    reason: "Pete Hammond file scraped republished transfer URL; Greg Evans is the actual critic"
  },
  {
    show: "back-to-the-future-2023",
    keep: "variety--frank-rizzo.json",
    delete: "variety--aramide-tinubu.json",
    reason: "Aramide Tinubu misattributed; Frank Rizzo is the actual Variety critic",
    mergeFullText: true  // Aramide has the fullText, Frank doesn't
  },
  {
    show: "burn-this-2019",
    keep: "variety--marilyn-stasio.json",
    delete: "variety--fran-rizzo.json",
    reason: "Fran Rizzo is a misspelling/misattribution; Marilyn Stasio is the actual Variety critic"
  },
  {
    show: "dana-h-2021",
    keep: "variety--frank-rizzo.json",
    delete: "variety--aramide-tinubu.json",
    reason: "Aramide Tinubu misattributed; Frank Rizzo is the actual Variety critic"
  },
  // grey-house-2023: NOT a true duplicate pair. Murray's garbage text matched Miller's review.
  // Murray's review was never scraped. Both critics are legitimate. Skip.
  {
    show: "hadestown-2019",
    keep: "ew--kristen-baldwin.json",
    delete: "ew--jessica-derschowitz.json",
    reason: "Jessica Derschowitz misattributed; Kristen Baldwin is the actual EW critic (byline confirmed)"
  },
  // hamilton-2015: Frank Scheck already flagged wrongProduction. Skip.
  {
    show: "how-to-dance-in-ohio-2023",
    keep: "variety--frank-rizzo.json",
    delete: "variety--aramide-tinubu.json",
    reason: "Aramide Tinubu misattributed; Frank Rizzo is the actual Variety critic"
  },
  {
    show: "mj-2022",
    keep: "hollywood-reporter--lovia-gyarkye.json",
    delete: "hollywood-reporter--david-rooney.json",
    reason: "David Rooney misattributed; Lovia Gyarkye is the actual THR critic (byline confirmed)"
  },
  {
    show: "oh-mary-2024",
    keep: "hollywood-reporter--david-rooney.json",
    delete: "hollywood-reporter--angie-han.json",
    reason: "Angie Han misattributed; David Rooney is the actual THR critic"
  },
  {
    show: "operation-mincemeat-2025",
    keep: "timeout--adam-feldman.json",
    delete: "timeout--adam.json",
    reason: "Same person (Adam Feldman); truncated filename is the duplicate"
  },
  {
    show: "our-town-2024",
    keep: "vulture--helen-shaw.json",
    delete: "vulture--sara-holdren.json",
    reason: "Sara Holdren misattributed; Helen Shaw is the current Vulture theater critic"
  },
  {
    show: "the-lion-king-1997",
    keep: "variety--greg-evans.json",
    delete: "variety--matt-wolf.json",
    reason: "Matt Wolf misattributed; Greg Evans is the actual Variety critic (DTLI confirmed)"
  },
  {
    show: "water-for-elephants-2024",
    keep: "nypost--johnny-oleksinski.json",
    delete: "nypost--elisabeth-vincentelli.json",
    reason: "Elisabeth Vincentelli misattributed; Johnny Oleksinski is the actual NY Post critic"
  }
];

// False positive: patriots-2024 deadline pair matched on garbage text, not real review content
const FALSE_POSITIVES = [
  {
    show: "patriots-2024",
    file1: "deadline--greg-evans.json",
    file2: "deadline--pete-hammond.json",
    reason: "Both files have null fullText; duplicateTextOf matched on scraped footer junk, not review content"
  }
];

let deletedCount = 0;
let mergedCount = 0;
let falsePositivesClearedCount = 0;

console.log(`\n=== Duplicate-Text Cleanup (${dryRun ? "DRY RUN" : "APPLYING"}) ===\n`);

// Process deletions
for (const pair of PAIRS) {
  const keepPath = path.join(REVIEW_DIR, pair.show, pair.keep);
  const deletePath = path.join(REVIEW_DIR, pair.show, pair.delete);

  if (!fs.existsSync(keepPath)) {
    console.log(`  SKIP ${pair.show}: keep file not found: ${pair.keep}`);
    continue;
  }
  if (!fs.existsSync(deletePath)) {
    console.log(`  SKIP ${pair.show}: delete file not found: ${pair.delete}`);
    continue;
  }

  const keepData = JSON.parse(fs.readFileSync(keepPath, "utf8"));
  const deleteData = JSON.parse(fs.readFileSync(deletePath, "utf8"));

  // Merge useful data from duplicate → original
  let merged = false;

  // Merge fullText if keep file lacks it and delete file has it
  if (pair.mergeFullText && !keepData.fullText && deleteData.fullText) {
    if (!dryRun) {
      keepData.fullText = deleteData.fullText;
      keepData.isFullReview = true;
      if (deleteData.textWordCount) keepData.textWordCount = deleteData.textWordCount;
      if (deleteData.wordCount) keepData.wordCount = deleteData.wordCount;
      if (deleteData.textFetchedAt) keepData.textFetchedAt = deleteData.textFetchedAt;
      if (deleteData.fetchMethod) keepData.fetchMethod = deleteData.fetchMethod;
      if (deleteData.fetchAttempts) keepData.fetchAttempts = deleteData.fetchAttempts;
      if (deleteData.archivePath) keepData.archivePath = deleteData.archivePath;
      keepData.needsRescore = true;
      keepData.rescoreReason = "fullText merged from misattributed duplicate";
    }
    console.log(`  MERGE fullText: ${pair.show}/${pair.delete} → ${pair.keep}`);
    merged = true;
    mergedCount++;
  }

  // Merge excerpts if keep file lacks them
  for (const field of ["dtliExcerpt", "bwwExcerpt", "showScoreExcerpt", "nycTheatreExcerpt"]) {
    if (!keepData[field] && deleteData[field]) {
      if (!dryRun) keepData[field] = deleteData[field];
      console.log(`  MERGE ${field}: ${pair.show}/${pair.delete} → ${pair.keep}`);
      merged = true;
    }
  }

  // Merge thumb data if keep file lacks it
  for (const field of ["dtliThumb", "bwwThumb"]) {
    if (!keepData[field] && deleteData[field]) {
      if (!dryRun) keepData[field] = deleteData[field];
      console.log(`  MERGE ${field}: ${pair.show}/${pair.delete} → ${pair.keep}`);
      merged = true;
    }
  }

  // Merge source URLs (playbillVerdictUrl, etc.)
  for (const field of ["playbillVerdictUrl", "dtliUrl", "bwwRoundupUrl"]) {
    if (!keepData[field] && deleteData[field]) {
      if (!dryRun) keepData[field] = deleteData[field];
      merged = true;
    }
  }

  // Merge sources array
  if (deleteData.sources && Array.isArray(deleteData.sources)) {
    if (!keepData.sources) keepData.sources = [];
    if (!Array.isArray(keepData.sources)) keepData.sources = [keepData.sources];
    for (const s of deleteData.sources) {
      if (!keepData.sources.includes(s)) {
        if (!dryRun) keepData.sources.push(s);
      }
    }
  }

  // Clear duplicateTextOf from the keep file (it pointed to the file we're deleting)
  if (keepData.duplicateTextOf === pair.delete) {
    if (!dryRun) delete keepData.duplicateTextOf;
    console.log(`  CLEAR duplicateTextOf on ${pair.show}/${pair.keep}`);
  }

  // Write updated keep file
  if (!dryRun) {
    fs.writeFileSync(keepPath, JSON.stringify(keepData, null, 2) + "\n");
  }

  // Delete the duplicate
  console.log(`  DELETE ${pair.show}/${pair.delete} — ${pair.reason}`);
  if (!dryRun) {
    fs.unlinkSync(deletePath);
  }
  deletedCount++;
}

// Process false positives — clear duplicateTextOf flags
console.log("\n--- False Positives (clearing duplicateTextOf flags) ---\n");
for (const fp of FALSE_POSITIVES) {
  const file1Path = path.join(REVIEW_DIR, fp.show, fp.file1);
  const file2Path = path.join(REVIEW_DIR, fp.show, fp.file2);

  for (const [fPath, fName] of [[file1Path, fp.file1], [file2Path, fp.file2]]) {
    if (!fs.existsSync(fPath)) {
      console.log(`  SKIP ${fp.show}/${fName}: file not found`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(fPath, "utf8"));
    if (data.duplicateTextOf) {
      console.log(`  CLEAR duplicateTextOf on ${fp.show}/${fName} — ${fp.reason}`);
      if (!dryRun) {
        delete data.duplicateTextOf;
        fs.writeFileSync(fPath, JSON.stringify(data, null, 2) + "\n");
      }
      falsePositivesClearedCount++;
    }
  }
}

// Also clear duplicateTextOf from grey-house-2023 matthew-murray (not a true dup pair)
const greyHouseMurray = path.join(REVIEW_DIR, "grey-house-2023", "talkinbroadway--matthew-murray.json");
if (fs.existsSync(greyHouseMurray)) {
  const data = JSON.parse(fs.readFileSync(greyHouseMurray, "utf8"));
  if (data.duplicateTextOf) {
    console.log(`  CLEAR duplicateTextOf on grey-house-2023/talkinbroadway--matthew-murray.json — not a true duplicate (scraped wrong critic's review)`);
    if (!dryRun) {
      delete data.duplicateTextOf;
      fs.writeFileSync(greyHouseMurray, JSON.stringify(data, null, 2) + "\n");
    }
    falsePositivesClearedCount++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Files deleted: ${deletedCount}`);
console.log(`Metadata merged: ${mergedCount} fullText transfers`);
console.log(`False positive flags cleared: ${falsePositivesClearedCount}`);
console.log(`\n${dryRun ? "Run with --apply to execute." : "Done."}`);
