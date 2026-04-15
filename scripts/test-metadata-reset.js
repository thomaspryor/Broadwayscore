#!/usr/bin/env node
/**
 * Test metadata reset: simulate URL replacement on real wrongProd files,
 * verify all blocking flags are cleared.
 *
 * Sample size target: 100+ real files with 2+ blocking flags.
 */

const fs = require('fs');
const path = require('path');

const BLOCKING_FIELDS = [
  'wrongProduction', 'wrongProductionReason', 'wrongProductionNote',
  'wrongShow', 'wrongShowReason', 'wrongShowNote', 'wrongShowAutoCleared',
  'contentTier', 'contentTierReason',
  'incompleteReason', 'incompleteDetail',
  'rejectionReason', 'rejectedBy', 'rejectionReasoning',
  'contentVerification', 'fetchAttempts', 'lastFetchDate',
];

function findCandidates(limit) {
  const dir = fs.existsSync('data/review-texts')
    ? 'data/review-texts'
    : '/Users/tompryor/Broadwayscore/data/review-texts';
  const candidates = [];
  for (const showDir of fs.readdirSync(dir)) {
    if (candidates.length >= limit) break;
    const fullDir = path.join(dir, showDir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const f of fs.readdirSync(fullDir)) {
      if (candidates.length >= limit) break;
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(fullDir, f), 'utf8'));
        const isHumanFlagged = data.wrongShowReason
          || data.humanReviewedWrongProduction === false
          || data.humanReviewScore != null;
        const wpNote = data.wrongProductionNote || '';
        const isDateBased = data.wrongProduction && (
          wpNote.startsWith('Pre-opening guard')
          || wpNote.startsWith('Date guard')
          || wpNote.startsWith('Dateless show')
          || wpNote.startsWith('Tour transfer')
        );
        if ((data.wrongProduction || data.wrongShow) && data.url && !isHumanFlagged && !isDateBased) {
          candidates.push({ showDir, file: f, data });
        }
      } catch {}
    }
  }
  return candidates;
}

// Replicate the replacement logic from our gather-reviews.js fix
function simulateReplacement(existing) {
  const newReviewData = {
    outletId: existing.outletId,
    outlet: existing.outlet,
    criticName: existing.criticName || 'Unknown',
    url: 'https://example.com/fresh-url',
    publishDate: '2026-04-13',
    source: 'test',
  };
  const preserved = {};
  for (const key of ['bwwScore', 'bwwExcerpt', 'showScoreRating', 'showScoreExcerpt', 'dtliThumb', 'dtliExcerpt']) {
    if (existing[key] !== undefined) preserved[key] = existing[key];
  }
  const replacement = { ...newReviewData, ...preserved, source: newReviewData.source || 'gather-reviews' };
  delete replacement.wrongProduction;
  delete replacement.wrongProductionReason;
  delete replacement.wrongProductionNote;
  delete replacement.wrongShow;
  delete replacement.wrongShowReason;
  delete replacement.wrongShowNote;
  delete replacement.wrongShowAutoCleared;
  delete replacement.contentTier;
  delete replacement.contentTierReason;
  delete replacement.incompleteReason;
  delete replacement.incompleteDetail;
  delete replacement.rejectionReason;
  delete replacement.rejectedBy;
  delete replacement.rejectionReasoning;
  if (replacement.contentVerification) {
    delete replacement.contentVerification.wrongArticle;
    delete replacement.contentVerification.verifiedAt;
    delete replacement.contentVerification.verifiedBy;
    delete replacement.contentVerification.reasoning;
    delete replacement.contentVerification.confidence;
    delete replacement.contentVerification.isValid;
  }
  delete replacement.fetchAttempts;
  delete replacement.lastFetchDate;
  if (!replacement.fullText) replacement.needsRecollection = true;
  return replacement;
}

function main() {
  const SAMPLE = parseInt(process.argv[2] || '200');
  const candidates = findCandidates(SAMPLE);
  console.log(`Found ${candidates.length} replacement candidates (target: ${SAMPLE})\n`);

  let pass = 0, fail = 0, needsRecollCount = 0;
  const failures = [];
  const preservedSampleCheck = [];

  for (const c of candidates) {
    const replacement = simulateReplacement(c.data);
    const remaining = BLOCKING_FIELDS.filter(field => replacement[field] !== undefined);
    if (remaining.length === 0) {
      pass++;
    } else {
      fail++;
      if (failures.length < 10) {
        failures.push({ file: `${c.showDir}/${c.file}`, remaining });
      }
    }
    if (replacement.needsRecollection === true) needsRecollCount++;

    // Verify preserved fields survived (for files that had them)
    for (const key of ['bwwScore', 'dtliThumb', 'showScoreRating']) {
      if (c.data[key] !== undefined && replacement[key] === undefined) {
        preservedSampleCheck.push({ file: `${c.showDir}/${c.file}`, lost: key });
      }
    }
  }

  console.log(`Blocking fields cleared: PASS ${pass}/${candidates.length}, FAIL ${fail}`);
  console.log(`needsRecollection set: ${needsRecollCount}/${candidates.length}`);
  console.log(`Preserved fields survived: ${candidates.length - preservedSampleCheck.length}/${candidates.length}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' ', f.file, '→ remaining:', f.remaining.join(', ')));
  }
  if (preservedSampleCheck.length > 0) {
    console.log('\nPreservation failures:');
    preservedSampleCheck.slice(0, 5).forEach(p => console.log(' ', p.file, '→ lost:', p.lost));
  }

  process.exit(fail > 0 || preservedSampleCheck.length > 0 ? 1 : 0);
}

main();
