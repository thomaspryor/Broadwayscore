'use strict';

// BRO-3634: triage hints, never exclusion decisions. An absent title alone
// cannot distinguish a legitimate excerpt from another production's article.
// Keep evidence to field names/enums/counts so the public audit never copies
// copyrighted fullText, quotes, or verifier reasoning out of review-texts.
function classifyUnmatchedReview(record, haystackLength) {
  let bucket = 'unresolved';
  const evidence = [];
  const tier = record.contentTier;
  const quality = record.textQuality;
  if (record.wrongProduction === true || record.wrongShow === true) {
    bucket = 'wrong-production';
    if (record.wrongProduction === true) evidence.push('wrongProduction=true');
    if (record.wrongShow === true) evidence.push('wrongShow=true');
  } else if (record.isRoundupArticle === true) {
    bucket = 'roundup';
    evidence.push('isRoundupArticle=true');
  } else if (haystackLength < 80) {
    bucket = 'stub';
    evidence.push('combinedTextLength<80');
  } else if (tier === 'excerpt') {
    bucket = 'excerpt';
    evidence.push('contentTier=excerpt');
  } else if (tier === 'truncated') {
    bucket = 'truncated';
    evidence.push('contentTier=truncated');
  } else if (tier === 'stub') {
    bucket = 'stub';
    evidence.push('contentTier=stub');
  } else if (!tier && ['excerpt', 'truncated', 'partial', 'stub'].includes(quality)) {
    bucket = quality === 'partial' ? 'truncated' : quality;
    evidence.push(`textQuality=${quality}`);
  } else {
    // A complete/invalid tier is not proof of either a correct or wrong
    // article. In particular, do not treat every short review as a roundup,
    // infer a production from a URL, or override a tier with stale legacy data.
    evidence.push('no-conclusive-triage-metadata');
  }

  const nextStep = {
    'wrong-production': 'verify-production-and-existing-flags',
    roundup: 'verify-roundup-attribution',
    excerpt: 'recover-full-article-and-verify-attribution',
    truncated: 'recover-full-article-and-verify-attribution',
    stub: 'recover-readable-content-and-verify-attribution',
    unresolved: 'read-article-and-verify-title-and-production',
  }[bucket];
  return { bucket, evidence, nextStep, requiresArticleReview: true };
}

// Called by the existing lifetime sweep. Per-outlet draft work plans travel
// inside its already-persisted snapshot and --json output, so the daily cron
// produces a fresh queue without another fetch, workflow, or report writer.
// These are deliberately NOT executable approved-fix plans: only an article
// check can justify field-edit actions and their compare-and-set oldValues.
function summarizeFulltextHits(hits) {
  const outlets = new Map();
  const counts = {};
  let total = 0;
  for (const hit of hits) {
    for (const violation of hit.violations) {
      const outletId = violation.outletId || 'unknown';
      const triage = violation.triage || {
        bucket: 'unresolved', evidence: ['triage-metadata-unavailable'],
        nextStep: 'read-article-and-verify-title-and-production', requiresArticleReview: true,
      };
      if (!outlets.has(outletId)) {
        outlets.set(outletId, { outletId, total: 0, counts: {}, requiresArticleReview: true, candidates: [] });
      }
      const plan = outlets.get(outletId);
      plan.total++;
      total++;
      plan.counts[triage.bucket] = (plan.counts[triage.bucket] || 0) + 1;
      counts[triage.bucket] = (counts[triage.bucket] || 0) + 1;
      plan.candidates.push({ file: `${hit.showId}/${violation.filename}`, ...triage });
    }
  }
  const outletPlans = [...outlets.values()].sort((a, b) => a.outletId.localeCompare(b.outletId));
  for (const plan of outletPlans) plan.candidates.sort((a, b) => a.file.localeCompare(b.file));
  return { triage: { total, counts, outletPlans } };
}

module.exports = { classifyUnmatchedReview, summarizeFulltextHits };
