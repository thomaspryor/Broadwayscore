#!/usr/bin/env node
/**
 * One-shot backfill: rename review-text files where criticName was overwritten
 * by an HC author override (criticEnrichedFrom: html-override:*) but the file
 * was never renamed to match the new criticName.
 *
 * Designed AFTER PR #290 was reverted on 2026-04-26. Independent of the
 * runtime helper in collect-review-texts.js so the runtime stays
 * conflict-only (no inline merge — that surface caused the line-5069
 * corruption bug). The backfill DOES merge on conflict because the
 * collisions found in the catalog are durable and need an opinionated
 * merge to clear them; but the merge is gated by:
 *   - PROTECTED_FIELDS preserved via safeWriteReview (lockedOverride too)
 *   - Source corruption filter (8 flags from validate-review-texts skip-set)
 *   - Predicate `existingData[key] === undefined` instead of `!existingData[key]`
 *     so manually-cleared falsy flags (wrongShow:false, isCriticsPick:false)
 *     are not clobbered by a truthy source value.
 *
 * Sister-store updates:
 *   - data/llm-scores/<show>/<file>.json  → renamed/merged in lockstep
 *   - sibling files with duplicateTextOf pointing at the old filename → updated
 *
 * Usage:
 *   node scripts/backfill-html-override-rename.js --dry-run   # report (default)
 *   node scripts/backfill-html-override-rename.js --apply     # mutate
 */

const fs = require('fs');
const path = require('path');
const {
  safeWriteReview,
  safeRenameReview,
  safeUnlinkReview,
} = require('./lib/review-write-guard');
const { generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const LLM_SCORES = path.join(ROOT, 'data', 'llm-scores');

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A source file is unsafe to merge/rename when the override fired on bad
 * URL content — the criticName override pulled the byline from an unrelated
 * page, so the file's other fields would corrupt a clean destination if
 * merged. Mirrors validate-review-texts.js's skip-set (line 185 + the
 * cross-attribution flags).
 */
function isSourceCorrupt(data) {
  if (data.wrongShow === true) return true;
  if (data.wrongProduction === true) return true;
  if (data.wrongUrl === true) return true;
  if (data.wrongAttribution === true) return true;
  if (data.contentTier === 'invalid') return true;
  if (data.contentVerification && data.contentVerification.wrongArticle === true) return true;
  if (data.contentVerification && data.contentVerification.wrongProduction === true) return true;
  if (data.fabricatedEntry === true) return true;
  if (data.isRoundupArticle === true) return true;
  if (data.suspectedMisattribution === true) return true;
  if (data.fullTextWrongAuthor === true) return true;
  return false;
}

function findCandidates() {
  if (!fs.existsSync(REVIEW_TEXTS)) return [];
  const candidates = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS)
    .filter(f => {
      try { return fs.statSync(path.join(REVIEW_TEXTS, f)).isDirectory(); }
      catch { return false; }
    });
  for (const showDir of showDirs) {
    const dir = path.join(REVIEW_TEXTS, showDir);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); }
    catch { continue; }
    for (const f of files) {
      if (f === 'failed-fetches.json') continue;
      const m = f.match(/^(.+)--(.+)\.json$/);
      if (!m) continue;
      const [, , filenameCriticSlug] = m;
      if (filenameCriticSlug === 'unknown') continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { continue; }
      if (!data.criticName || data.criticName === 'Unknown') continue;
      if (!data.criticEnrichedFrom || !data.criticEnrichedFrom.startsWith('html-override')) continue;
      const dataSlug = slugify(data.criticName);
      if (dataSlug === filenameCriticSlug) continue;
      const skip = isSourceCorrupt(data);
      candidates.push({ showDir, dir, oldFile: f, data, skip });
    }
  }
  return candidates;
}

/**
 * Merge fields from source into dest using the PR #290 ship-check predicate:
 * `existingData[key] === undefined` — NOT `!existingData[key]`.
 *
 * The wrong predicate was the second-opinion finding on PR #290: a manually-
 * cleared `wrongShow: false` is falsy, so `!existingData.wrongShow` is true,
 * so a truthy source `wrongShow: true` would clobber the cleared flag. Using
 * strict-undefined preserves anything the operator/auditor explicitly set,
 * including falsy values.
 *
 * Returns the merged object (NEW reference; does not mutate inputs).
 */
function mergeIntoDestStrict(existingData, sourceData) {
  const merged = { ...existingData };
  for (const [key, val] of Object.entries(sourceData || {})) {
    if (val === null || val === undefined) continue;
    if (merged[key] === undefined) {
      merged[key] = val;
    }
  }
  return merged;
}

function updateDuplicateTextOfPointers(showDir, oldFilename, newFilename) {
  const updated = [];
  const dir = path.join(REVIEW_TEXTS, showDir);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== newFilename); }
  catch { return updated; }
  for (const f of files) {
    const fp = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { continue; }
    if (data.duplicateTextOf === oldFilename) {
      data.duplicateTextOf = newFilename;
      if (APPLY) {
        // Route through safeWriteReview — sibling files might be _locked or
        // have other PROTECTED state we don't want to clobber. The pointer
        // update itself is non-protected so it goes through.
        safeWriteReview(fp, data);
      }
      updated.push(f);
    }
  }
  return updated;
}

function moveLlmScoreSidecar(showDir, oldFilename, newFilename) {
  const oldScorePath = path.join(LLM_SCORES, showDir, oldFilename);
  const newScorePath = path.join(LLM_SCORES, showDir, newFilename);
  if (!fs.existsSync(oldScorePath)) return { action: 'absent' };
  if (fs.existsSync(newScorePath)) {
    if (APPLY) {
      try {
        const existing = JSON.parse(fs.readFileSync(newScorePath, 'utf8'));
        const incoming = JSON.parse(fs.readFileSync(oldScorePath, 'utf8'));
        const merged = mergeIntoDestStrict(existing, incoming);
        fs.writeFileSync(newScorePath, JSON.stringify(merged, null, 2) + '\n');
        fs.unlinkSync(oldScorePath);
      } catch (e) {
        return { action: 'error', error: e.message };
      }
    }
    return { action: 'merge' };
  }
  if (APPLY) {
    try {
      fs.mkdirSync(path.dirname(newScorePath), { recursive: true });
      fs.renameSync(oldScorePath, newScorePath);
    } catch (e) {
      return { action: 'error', error: e.message };
    }
  }
  return { action: 'rename' };
}

function processCandidate(c) {
  const { showDir, dir, oldFile, data, skip } = c;
  const outletId = normalizeOutlet(data.outletId || data.outlet);
  const newFilename = generateReviewFilename(outletId, data.criticName);
  if (newFilename === oldFile) {
    return { showDir, oldFile, newFile: newFilename, action: 'noop-already-correct' };
  }

  if (skip) {
    return { showDir, oldFile, newFile: newFilename, action: 'skip-corrupt-source' };
  }

  const oldPath = path.join(dir, oldFile);
  const newPath = path.join(dir, newFilename);

  if (!fs.existsSync(newPath)) {
    // Clean rename: route through safeRenameReview (honors source _locked,
    // moves llm-scores sidecar, rewrites duplicateTextOf siblings).
    if (DRY_RUN) {
      return { showDir, oldFile, newFile: newFilename, action: 'would-rename' };
    }
    const r = safeRenameReview(oldPath, newPath, { newData: data });
    if (r.skipped === 'locked') {
      return { showDir, oldFile, newFile: newFilename, action: 'skip-source-locked' };
    }
    if (r.skipped === 'conflict') {
      // TOCTOU: dest appeared mid-flight. Re-route to merge branch.
      // (Falls through below.)
    } else if (!r.wrote) {
      return { showDir, oldFile, newFile: newFilename, action: `skip-${r.skipped}`, error: r.error };
    } else {
      return {
        showDir,
        oldFile,
        newFile: newFilename,
        action: 'renamed',
        sisterStoreMoved: r.sisterStoreMoved,
        siblingPointersUpdated: r.siblingPointersUpdated,
      };
    }
  }

  // Merge case: dest exists. Use the strict-undefined predicate to merge
  // unique fields from source into dest, then route the merged write
  // through safeWriteReview (honors dest _locked) and unlink source via
  // safeUnlinkReview (honors source _locked).
  let existing;
  try { existing = JSON.parse(fs.readFileSync(newPath, 'utf8')); }
  catch (e) {
    return { showDir, oldFile, newFile: newFilename, action: 'error-dest-unreadable', error: e.message };
  }

  const merged = mergeIntoDestStrict(existing, data);

  if (DRY_RUN) {
    const newKeys = Object.keys(data).filter(k => existing[k] === undefined && data[k] !== null && data[k] !== undefined);
    return {
      showDir,
      oldFile,
      newFile: newFilename,
      action: 'would-merge',
      newKeysIntoDest: newKeys,
    };
  }

  const writeResult = safeWriteReview(newPath, merged);
  if (writeResult.lockedSkipped) {
    // Dest is locked — its PROTECTED fields stay untouched. We still wrote
    // any non-protected fields we had. Don't unlink source (operator triage).
    return { showDir, oldFile, newFile: newFilename, action: 'merge-dest-locked-partial', preserved: writeResult.preserved };
  }

  const sister = moveLlmScoreSidecar(showDir, oldFile, newFilename);
  const pointers = updateDuplicateTextOfPointers(showDir, oldFile, newFilename);

  const unlinkResult = safeUnlinkReview(oldPath);
  if (!unlinkResult.wrote) {
    if (unlinkResult.lockedSkipped) {
      return {
        showDir,
        oldFile,
        newFile: newFilename,
        action: 'merge-source-locked',
        sisterStoreAction: sister.action,
        siblingPointersUpdated: pointers.length,
      };
    }
    return {
      showDir,
      oldFile,
      newFile: newFilename,
      action: `merge-then-unlink-skipped-${unlinkResult.skipped}`,
      sisterStoreAction: sister.action,
      siblingPointersUpdated: pointers.length,
    };
  }

  return {
    showDir,
    oldFile,
    newFile: newFilename,
    action: 'merged-and-unlinked',
    sisterStoreAction: sister.action,
    siblingPointersUpdated: pointers.length,
  };
}

function main() {
  const candidates = findCandidates();
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`Candidates: ${candidates.length}`);

  const results = candidates.map(processCandidate);
  const counts = {};
  for (const r of results) {
    counts[r.action] = (counts[r.action] || 0) + 1;
  }

  console.log(`\nResult counts:`);
  for (const [action, n] of Object.entries(counts).sort()) {
    console.log(`  ${action}: ${n}`);
  }

  if (results.length > 0) {
    console.log(`\nDetail:`);
    for (const r of results) {
      console.log(`  ${r.showDir}/${r.oldFile} → ${r.newFile}: ${r.action}${r.error ? ` (${r.error})` : ''}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry-run only. Re-run with --apply to mutate.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  isSourceCorrupt,
  mergeIntoDestStrict,
  findCandidates,
  processCandidate,
};
