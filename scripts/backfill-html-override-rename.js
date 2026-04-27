#!/usr/bin/env node
/**
 * One-shot backfill: rename review-text files where criticName was overwritten
 * by an HC author override (criticEnrichedFrom: html-override:*) but the file
 * was never renamed to match the new criticName. See
 * memory/feedback_recurring_backfill_means_broken_creator.md.
 *
 * Sister-store updates:
 *   - data/llm-scores/<show>/<file>.json  → renamed in lockstep if present
 *   - sibling files with duplicateTextOf pointing at the old filename → updated
 *
 * Both repos share the same review-text content (broadway-review-texts and
 * data/review-texts/ are mirrors). This script edits data/review-texts/ — the
 * caller must commit the same changes to both repos.
 *
 * Usage:
 *   node scripts/backfill-html-override-rename.js --dry-run   # report
 *   node scripts/backfill-html-override-rename.js --apply     # mutate
 */

const fs = require('fs');
const path = require('path');
const { renameReviewFileToMatchCritic, normalizeOutlet } = require('./lib/review-normalization');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const LLM_SCORES = path.join(ROOT, 'data', 'llm-scores');

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A source file is unsafe to merge/rename when the override fired on bad URL
// content — the criticName override pulled the byline from an unrelated page,
// so the file's other fields (wrongFullText, wrongShowReason, contentTier:
// invalid, etc) would corrupt a clean destination if merged. Audit 2026-04-26
// found 7/8 affected files in this state. Skip them here; manual triage owns
// the corrupt-source cleanup.
function isSourceCorrupt(data) {
  if (data.wrongShow === true) return true;
  if (data.wrongProduction === true) return true;
  if (data.wrongUrl === true) return true;
  if (data.wrongAttribution === true) return true;
  if (data.contentTier === 'invalid') return true;
  if (data.contentVerification && data.contentVerification.wrongArticle === true) return true;
  // Also skip when LLM verifier flagged wrongProduction even if a temporal
  // override neutralized it at the top level — we don't want to propagate
  // ambiguous attribution into a renamed file.
  if (data.contentVerification && data.contentVerification.wrongProduction === true) return true;
  return false;
}

function findCandidates() {
  const candidates = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS, f)).isDirectory());
  for (const showDir of showDirs) {
    const dir = path.join(REVIEW_TEXTS, showDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const m = f.match(/^(.+)--(.+)\.json$/);
      if (!m) continue;
      const [, , filenameCriticSlug] = m;
      if (filenameCriticSlug === 'unknown') continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
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

function updateDuplicateTextOfPointers(showDir, oldFilename, newFilename) {
  const updated = [];
  const dir = path.join(REVIEW_TEXTS, showDir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== newFilename);
  for (const f of files) {
    const fp = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (data.duplicateTextOf === oldFilename) {
      data.duplicateTextOf = newFilename;
      if (APPLY) {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
      updated.push(f);
    }
  }
  return updated;
}

function renameLlmScoreSidecar(showDir, oldFilename, newFilename) {
  // llm-scores sidecar uses the same filename as the review-text file.
  const oldScorePath = path.join(LLM_SCORES, showDir, oldFilename);
  const newScorePath = path.join(LLM_SCORES, showDir, newFilename);
  if (!fs.existsSync(oldScorePath)) return { action: 'absent' };
  if (fs.existsSync(newScorePath)) {
    // Same merge semantics as the review-text helper: take fields source has
    // that destination is missing, then delete source.
    if (APPLY) {
      try {
        const existing = JSON.parse(fs.readFileSync(newScorePath, 'utf8'));
        const incoming = JSON.parse(fs.readFileSync(oldScorePath, 'utf8'));
        let merged = false;
        for (const [k, v] of Object.entries(incoming)) {
          if (v != null && !existing[k]) { existing[k] = v; merged = true; }
        }
        if (merged) fs.writeFileSync(newScorePath, JSON.stringify(existing, null, 2) + '\n');
        fs.unlinkSync(oldScorePath);
      } catch (e) {
        return { action: 'error', error: e.message };
      }
    }
    return { action: 'merge' };
  }
  if (APPLY) {
    try { fs.renameSync(oldScorePath, newScorePath); }
    catch (e) { return { action: 'error', error: e.message }; }
  }
  return { action: 'rename' };
}

function main() {
  const candidates = findCandidates();
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`Candidates: ${candidates.length}`);
  console.log();

  const summary = { rename: 0, merge: 0, noop: 0, error: 0, skipCorrupt: 0, sidecarRenames: 0, sidecarMerges: 0, dupPointersUpdated: 0 };
  for (const c of candidates) {
    const filePath = path.join(c.dir, c.oldFile);
    const oldFilename = c.oldFile;
    if (c.skip) {
      summary.skipCorrupt++;
      console.log(`${c.showDir}/${oldFilename} → SKIP (source has wrongShow/wrongProduction/wrongUrl/contentTier=invalid)`);
      continue;
    }
    let result;
    if (APPLY) {
      result = renameReviewFileToMatchCritic(filePath, c.data);
    } else {
      // Simulate without mutating: compute what action would be taken
      const outletId = normalizeOutlet(c.data.outletId || c.data.outlet);
      const newFilename = `${outletId}--${slugify(c.data.criticName)}.json`;
      const newPath = path.join(c.dir, newFilename);
      const action = newFilename === oldFilename ? 'noop' : (fs.existsSync(newPath) ? 'merge' : 'rename');
      result = { action, newFilePath: newPath };
    }

    summary[result.action] = (summary[result.action] || 0) + 1;
    const newFilename = path.basename(result.newFilePath);
    console.log(`${c.showDir}/${oldFilename} → ${newFilename} [${result.action}]`);

    if (result.action === 'rename' || result.action === 'merge') {
      const sidecar = renameLlmScoreSidecar(c.showDir, oldFilename, newFilename);
      if (sidecar.action === 'rename') summary.sidecarRenames++;
      if (sidecar.action === 'merge') summary.sidecarMerges++;
      if (sidecar.action !== 'absent' && sidecar.action !== 'error') {
        console.log(`    llm-scores sidecar: ${sidecar.action}`);
      }
      if (sidecar.action === 'error') {
        console.log(`    llm-scores sidecar ERROR: ${sidecar.error}`);
      }

      const dupUpdated = updateDuplicateTextOfPointers(c.showDir, oldFilename, newFilename);
      if (dupUpdated.length > 0) {
        summary.dupPointersUpdated += dupUpdated.length;
        console.log(`    duplicateTextOf pointers updated in: ${dupUpdated.join(', ')}`);
      }
    }
    if (result.action === 'error') {
      console.log(`    ERROR: ${result.error}`);
    }
  }

  console.log();
  console.log('Summary:', JSON.stringify(summary, null, 2));
  if (DRY_RUN) {
    console.log('\nDry-run only. Re-run with --apply to mutate.');
  }
}

main();
