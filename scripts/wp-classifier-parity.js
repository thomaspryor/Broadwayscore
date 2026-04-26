#!/usr/bin/env node
/**
 * Wrong-Production Classifier Parity Harness (Sprint 2 — S2-T1)
 *
 * MOTIVATION
 * ----------
 * Catalog audit found ~3,700 review-text files where `fullText.length === 0`
 * but a valid `llmScore` (or `originalScore`) is present. Some are wrong-production
 * attribution (URL points to a different production), others had text stripped during
 * a content-quality migration. Before applying any `--fix` to flip these to
 * `wrongProduction: true`, we need to validate that the three existing classifiers
 * don't disagree on the same files (split-brain risk caught by plan-review pre-mortem).
 *
 * THREE CLASSIFIERS
 * -----------------
 * 1. `scripts/audit-wrong-production.js` — comprehensive 6-signal audit (date guard,
 *    director cross-check, TV/film signals, off-Broadway/London signals, year mismatch,
 *    cast cross-check). Output: `data/audit/wrong-production-audit.json` with per-file
 *    `findings` array (wraps every flagged review).
 * 2. `scripts/audit-wrong-production-reviews.js` — hand-curated KNOWN_WRONG_INDICATORS
 *    map (Our Town 2024, Suffs 2024, Tommy 2024, Cabaret 2024, Doubt 2024, Merrily 2023,
 *    Wiz 2024, etc.). Output: `data/audit/wrong-production-reviews.json` with `flagged`
 *    array per show/file.
 * 3. `scripts/classify-wrong-production.js` — LLM (Gemini/Claude) classifier targeted
 *    at the medium-confidence pre-2005 audit results. Output:
 *    `data/audit/wrong-production-classified.json` with `results` array. Currently
 *    empty (0 classifications) — pre-2005 audit hasn't been populated.
 *
 * NORMALIZATION
 * -------------
 * For every P3 cohort file we build a verdict tuple per classifier:
 *   - 'flag': classifier said wrong-production
 *   - 'safe': classifier explicitly cleared the file (only audit-wp can — it
 *     iterates every catalog file and not-finding-it implies safe; wp-reviews
 *     also iterates files in covered shows, so non-flag ⇒ safe within scope;
 *     wp-classify only sees pre-fed files, so no signal ⇒ unseen)
 *   - 'unseen': classifier doesn't have an opinion (didn't iterate this file)
 *
 * SCOPE NUANCES
 * -------------
 * - wp_audit: iterates every showId dir present in review-texts. A file in cohort
 *   that's not in `findings` ⇒ 'safe'. Caveat: audit-wp short-circuits when
 *   `data.wrongProduction || data.wrongShow` is already true (`alreadyFlagged` stat
 *   counts these). For our cohort (P3), already-flagged files count as 'flag'.
 * - wp_reviews: only audits ~69 shows (revivals + KNOWN_WRONG_INDICATORS keys).
 *   For files outside that scope: 'unseen'. For files inside: flagged ⇒ 'flag',
 *   else 'safe' iff there's text to examine (fullText / dtliExcerpt / bwwExcerpt /
 *   showScoreExcerpt). Files with NO examinable text → 'unseen' (the classifier
 *   requires text content to evaluate KNOWN_WRONG_INDICATORS; absence of text
 *   means absence-of-evidence, not clearance — see triage commit 4caf00fc6c).
 *   Plus its `baseline_pending` skip list — those become 'unseen'.
 * - wp_classify: empty corpus today. Every file → 'unseen' unless we find it in
 *   the `results` array.
 *
 * OUTPUT
 * ------
 * `data/audit/wp-classifier-disagreements.json`:
 *   {
 *     _meta: { generatedAt, cohortSize, limit, classifiersScope: {...} },
 *     partitions: {
 *       unanimous_flag: [...],     // 2+ flag, 0 safe
 *       unanimous_safe: [...],     // 2+ safe, 0 flag
 *       majority_flag: [...],      // most flag, one safe (skewed disagreement)
 *       majority_safe: [...],      // most safe, one flag (skewed safe)
 *       outlier_flag: [...],       // exactly 1 flag, others unseen
 *       outlier_safe: [...],       // exactly 1 safe explicitly, others unseen
 *       all_unseen: [...],         // no classifier has an opinion
 *     },
 *     summary: { unanimous_flag_count, ..., total }
 *   }
 *
 * USAGE
 * -----
 *   node scripts/wp-classifier-parity.js --cohort=p3 [--limit=N]
 */

const fs = require('fs');
const path = require('path');

// ---------- CLI ----------
const args = process.argv.slice(2);
const COHORT = (args.find(a => a.startsWith('--cohort=')) || '--cohort=p3').split('=')[1];
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

if (COHORT !== 'p3') {
  console.error(`Unknown cohort: ${COHORT}. Only --cohort=p3 supported.`);
  process.exit(1);
}

// ---------- Paths ----------
const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_WP_PATH = path.join(ROOT, 'data', 'audit', 'wrong-production-audit.json');
const WP_REVIEWS_PATH = path.join(ROOT, 'data', 'audit', 'wrong-production-reviews.json');
const WP_CLASSIFY_PATH = path.join(ROOT, 'data', 'audit', 'wrong-production-classified.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'audit', 'wp-classifier-disagreements.json');

// ---------- Cohort builder ----------
/**
 * P3 = files where fullText.length === 0 AND (llmScore?.score != null OR originalScore != null)
 */
function buildP3Cohort() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`Missing review-texts directory: ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    if (d.startsWith('_')) return false;
    try {
      return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory();
    } catch (e) {
      return false;
    }
  });

  const cohort = [];
  for (const showId of showDirs) {
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch (e) { continue; }
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (e) { continue; }
      const noText = !data.fullText || data.fullText.length === 0;
      const hasScore = (data.llmScore && data.llmScore.score != null) || data.originalScore != null;
      // wp_reviews scans these text fields (see audit-wrong-production-reviews.js
      // textFields collection at L413-419). If ALL are empty, it has nothing to
      // examine and any non-flag verdict is absence-of-evidence, not clearance.
      const hasExaminableText = !!(
        (data.fullText && data.fullText.length > 0) ||
        (data.dtliExcerpt && data.dtliExcerpt.length > 0) ||
        (data.bwwExcerpt && data.bwwExcerpt.length > 0) ||
        (data.showScoreExcerpt && data.showScoreExcerpt.length > 0)
      );
      if (noText && hasScore) {
        cohort.push({
          showId,
          file,
          url: data.url || null,
          publishDate: data.publishDate || null,
          llmScore: data.llmScore?.score ?? null,
          originalScore: data.originalScore ?? null,
          hasExaminableText,
          existingFlags: {
            wrongProduction: !!data.wrongProduction,
            wrongShow: !!data.wrongShow,
            wrongProductionManualClear: data.wrongProductionManualClear === true,
            wrongProductionOverride: data.wrongProductionOverride === true,
            humanReviewedWrongProduction: data.humanReviewedWrongProduction,
          },
        });
      }
    }
  }
  return cohort;
}

// ---------- Classifier verdict loaders ----------

/**
 * audit-wp: flag if (showId, file) is in findings; safe if showId iterated but file
 * not in findings; unseen if showId not in catalog (rare).
 *
 * Caveat: audit-wp `alreadyFlagged` (data.wrongProduction || data.wrongShow) entries
 * are skipped from `findings` — they are NOT re-flagged. We treat any file that
 * already carries `wrongProduction: true` in the source data as 'flag' from audit-wp,
 * since the audit's pre-condition matches the rule.
 */
function loadAuditWPVerdicts() {
  if (!fs.existsSync(AUDIT_WP_PATH)) {
    console.warn(`Missing ${AUDIT_WP_PATH} — wp_audit will return 'unseen' for all files`);
    return { findings: new Map(), iteratedShows: new Set(), totalFlagged: 0 };
  }
  const audit = JSON.parse(fs.readFileSync(AUDIT_WP_PATH, 'utf8'));
  const findings = new Map(); // key = showId/file, value = signals
  const iteratedShows = new Set();
  for (const f of audit.findings || []) {
    const key = `${f.showId}/${f.file}`;
    findings.set(key, {
      severity: (f.findings || []).map(x => x.severity),
      types: (f.findings || []).map(x => x.type),
      details: (f.findings || []).map(x => x.detail),
    });
    iteratedShows.add(f.showId);
  }
  // The audit iterates every show dir, so iteratedShows technically should cover
  // all directories. But the script only saves shows where SOMETHING was found.
  // For "safe" we rely on the assumption that audit-wp has been run over the full
  // catalog (which it has — see stats.totalReviews 36,090).
  return {
    findings,
    iteratedShows,
    totalFlagged: audit.findings?.length ?? 0,
    totalScanned: audit.stats?.totalReviews ?? 0,
  };
}

/**
 * wp-reviews: flag if (showId, file) is in flagged; safe if showId is in shows_audited
 * but the file isn't in flagged; unseen if showId is in baseline_pending or not present.
 */
function loadWPReviewsVerdicts() {
  if (!fs.existsSync(WP_REVIEWS_PATH)) {
    console.warn(`Missing ${WP_REVIEWS_PATH} — wp_reviews will return 'unseen' for all files`);
    return { flagged: new Map(), auditedShows: new Set(), totalFlagged: 0 };
  }
  const wp = JSON.parse(fs.readFileSync(WP_REVIEWS_PATH, 'utf8'));
  const flagged = new Map();
  for (const f of wp.flagged || []) {
    const key = `${f.showId}/${f.file}`;
    flagged.set(key, {
      indicators: f.indicators_found || [],
      classification: f.classification,
      confidence: f.confidence,
      isDateMismatch: !!f.isDateMismatch,
    });
  }
  const auditedShows = new Set();
  for (const s of wp.shows_audited || []) auditedShows.add(s.showId);
  return {
    flagged,
    auditedShows,
    totalFlagged: wp.flagged?.length ?? 0,
  };
}

/**
 * wp-classify: flag if WRONG_PRODUCTION verdict; safe if CORRECT/ORIGINAL; unseen
 * otherwise. Only files in `results` have any opinion.
 */
function loadWPClassifyVerdicts() {
  if (!fs.existsSync(WP_CLASSIFY_PATH)) {
    console.warn(`Missing ${WP_CLASSIFY_PATH} — wp_classify will return 'unseen' for all files`);
    return { verdicts: new Map(), totalClassified: 0 };
  }
  const cls = JSON.parse(fs.readFileSync(WP_CLASSIFY_PATH, 'utf8'));
  const verdicts = new Map();
  for (const r of cls.results || []) {
    const key = `${r.showId}/${r.file}`;
    verdicts.set(key, {
      verdict: r.verdict,
      confidence: r.confidence,
      reasoning: r.reasoning,
      targetShowId: r.targetShowId,
    });
  }
  return {
    verdicts,
    totalClassified: cls.results?.length ?? 0,
    metaTotal: cls._meta?.total ?? 0,
  };
}

// ---------- Per-file verdict assembly ----------
function getVerdict(file, auditWP, wpReviews, wpClassify) {
  const key = `${file.showId}/${file.file}`;

  // wp_audit
  let wp_audit = 'safe';
  let auditSignals = null;
  if (auditWP.findings.has(key)) {
    wp_audit = 'flag';
    auditSignals = auditWP.findings.get(key);
  } else if (file.existingFlags.wrongProduction || file.existingFlags.wrongShow) {
    // The audit short-circuits on already-flagged. It would have flagged this had
    // it not been pre-flagged. Treat as 'flag'.
    wp_audit = 'flag';
    auditSignals = { source: 'pre-existing-wrongProduction' };
  }
  // If audit ran on 0 files (empty), revert to unseen
  if (auditWP.totalScanned === 0) wp_audit = 'unseen';

  // wp_reviews
  // Structural caveat: audit-wrong-production-reviews.js requires textual content
  // (fullText / dtliExcerpt / bwwExcerpt / showScoreExcerpt) to find KNOWN_WRONG_INDICATORS.
  // For P3 cohort files (fullText.length === 0 by definition), wp_reviews has nothing
  // to inspect — its non-flag is absence-of-evidence, NOT actual clearance. Treat
  // such files as 'unseen' so they don't spuriously oppose other classifiers' flags.
  // (See triage commit 4caf00fc6c.)
  let wp_reviews;
  let wpRevSignals = null;
  if (wpReviews.flagged.has(key)) {
    wp_reviews = 'flag';
    wpRevSignals = wpReviews.flagged.get(key);
  } else if (wpReviews.auditedShows.has(file.showId) && file.hasExaminableText) {
    wp_reviews = 'safe';
  } else {
    wp_reviews = 'unseen';
  }

  // wp_classify
  let wp_classify;
  let wpClsSignals = null;
  if (wpClassify.verdicts.has(key)) {
    const v = wpClassify.verdicts.get(key);
    if (v.verdict === 'WRONG_PRODUCTION') wp_classify = 'flag';
    else if (v.verdict === 'CORRECT' || v.verdict === 'ORIGINAL') wp_classify = 'safe';
    else wp_classify = 'unseen'; // UNCERTAIN — no opinion
    wpClsSignals = v;
  } else {
    wp_classify = 'unseen';
  }

  return {
    verdicts: { wp_audit, wp_reviews, wp_classify },
    signals: { wp_audit: auditSignals, wp_reviews: wpRevSignals, wp_classify: wpClsSignals },
  };
}

// ---------- Partition logic ----------
function partition(verdicts) {
  const { wp_audit, wp_reviews, wp_classify } = verdicts;
  const all = [wp_audit, wp_reviews, wp_classify];
  const flags = all.filter(v => v === 'flag').length;
  const safes = all.filter(v => v === 'safe').length;
  const unseens = all.filter(v => v === 'unseen').length;

  if (unseens === 3) return 'all_unseen';
  if (flags >= 2 && safes === 0) return 'unanimous_flag';
  if (safes >= 2 && flags === 0) return 'unanimous_safe';
  if (flags >= 2 && safes >= 1) return 'majority_flag';
  if (safes >= 2 && flags >= 1) return 'majority_safe';
  if (flags === 1 && safes === 0) return 'outlier_flag';
  if (safes === 1 && flags === 0) return 'outlier_safe';
  // Tie: 1 flag + 1 safe + 1 unseen — call it majority_safe (conservative side).
  // Actually this is genuine disagreement with no majority. Tag as majority_safe
  // when we can't choose; document in pre-mortem.
  if (flags === 1 && safes === 1) return 'majority_safe';
  return 'all_unseen';
}

// ---------- Main ----------
function main() {
  console.log(`=== WP Classifier Parity Harness ===`);
  console.log(`Cohort: ${COHORT}`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT}`);
  console.log('');

  // Step 1: Cohort
  let cohort = buildP3Cohort();
  console.log(`P3 cohort size (full): ${cohort.length}`);
  if (LIMIT > 0 && cohort.length > LIMIT) {
    cohort = cohort.slice(0, LIMIT);
    console.log(`Limited to: ${cohort.length}`);
  }

  // Step 2: Load classifier outputs
  const auditWP = loadAuditWPVerdicts();
  const wpReviews = loadWPReviewsVerdicts();
  const wpClassify = loadWPClassifyVerdicts();
  console.log(`Loaded wp_audit: ${auditWP.totalFlagged} findings (${auditWP.totalScanned} reviews scanned)`);
  console.log(`Loaded wp_reviews: ${wpReviews.totalFlagged} flagged across ${wpReviews.auditedShows.size} shows`);
  console.log(`Loaded wp_classify: ${wpClassify.totalClassified} classifications`);
  console.log('');

  // Step 3: Per-file verdict
  const partitions = {
    unanimous_flag: [],
    unanimous_safe: [],
    majority_flag: [],
    majority_safe: [],
    outlier_flag: [],
    outlier_safe: [],
    all_unseen: [],
  };

  for (const file of cohort) {
    const { verdicts, signals } = getVerdict(file, auditWP, wpReviews, wpClassify);
    const part = partition(verdicts);
    partitions[part].push({
      showId: file.showId,
      file: file.file,
      url: file.url,
      publishDate: file.publishDate,
      llmScore: file.llmScore,
      originalScore: file.originalScore,
      existingFlags: file.existingFlags,
      verdicts,
      signals,
    });
  }

  // Step 4: Summary
  const summary = {};
  for (const p of Object.keys(partitions)) {
    summary[`${p}_count`] = partitions[p].length;
  }
  summary.total = cohort.length;

  console.log('=== Partition counts ===');
  for (const [p, items] of Object.entries(partitions)) {
    console.log(`  ${p}: ${items.length}`);
  }
  console.log(`  total: ${cohort.length}`);
  console.log('');

  // Step 5: Output
  const out = {
    _meta: {
      generatedAt: new Date().toISOString(),
      cohortSize: cohort.length,
      limit: LIMIT > 0 ? LIMIT : null,
      classifiersScope: {
        wp_audit: `${auditWP.totalScanned} reviews scanned, ${auditWP.totalFlagged} flagged`,
        wp_reviews: `${wpReviews.auditedShows.size} shows audited, ${wpReviews.totalFlagged} flagged`,
        wp_classify: `${wpClassify.totalClassified} files classified`,
      },
    },
    partitions,
    summary,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
