#!/usr/bin/env node
/**
 * Audit Non-Review Content in Scored Reviews
 *
 * Scans review-text files that have been scored (llmScore or assignedScore)
 * and flags content that isn't actually a theater review. Catches non-reviews
 * that slipped through before ensemble Step 0 was added (v5.2).
 *
 * Two-layer detection:
 *   Layer 1: Heuristic patterns (free, instant) — catches obvious non-reviews
 *   Layer 2: Gemini Flash classification (~$0.0001/call) — borderline cases
 *
 * Usage:
 *   node scripts/audit-non-reviews.js [options]
 *
 * Options:
 *   --dry-run       Report only, don't modify files
 *   --show=SLUG     Only audit one show
 *   --limit=N       Limit to N files
 *   --skip-llm      Skip LLM classification (heuristics only)
 *   --verbose        Extra logging
 *   --force          Re-check files already flagged
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('--strict');
const STRICT = args.includes('--strict'); // CI gate: report-only, exit 1 on high-confidence non-reviews
const SKIP_LLM = args.includes('--skip-llm') || args.includes('--strict'); // strict uses free heuristics only

const VERBOSE = args.includes('--verbose');
const FORCE = args.includes('--force');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_DIR = path.join(__dirname, '../data/audit');

// ============================================================
// Heuristic Non-Review Detection (Layer 1 — free)
// ============================================================

// Patterns + heuristic classifier now live in a shared lib so the newspapers.com
// extractor reuses the exact same detection (single source of truth). The shared
// version adds the wrong-page newspaper-OCR signals (weather/sports/listings).
const { NON_REVIEW_PATTERNS, REVIEW_INDICATORS, heuristicClassify } = require('./lib/non-review-patterns');
const { GEMINI_FLASH } = require('./lib/models');

// ============================================================
// LLM Classification (Layer 2 — Gemini Flash)
// ============================================================

function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } }
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Gemini parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Layer 2: LLM classification for borderline cases.
 * Returns { isNonReview: bool, reasoning: string } or null on failure.
 */
async function llmClassify(text, showTitle, outlet) {
  const snippet = text.substring(0, 1500);
  const prompt = `Is this text a theater critic's review of "${showTitle}"? A review evaluates a show the critic attended — it discusses performances, direction, writing, etc.

NOT a review: news articles, press releases, interviews, cast announcements, award coverage, previews, listicles, photo galleries, plot summaries without evaluation.

Outlet: ${outlet}
Text: "${snippet}"

Answer: REVIEW or NOT_REVIEW followed by a brief reason (one sentence).`;

  try {
    const response = await callGemini(prompt);
    const clean = response.trim();
    if (clean.startsWith('REVIEW')) {
      return { isNonReview: false, reasoning: clean };
    }
    if (clean.startsWith('NOT_REVIEW') || clean.startsWith('NOT-REVIEW') || clean.startsWith('NOT REVIEW')) {
      return { isNonReview: true, reasoning: clean };
    }
    // Unparseable — treat as inconclusive
    if (VERBOSE) console.log(`    LLM unparseable: "${clean.substring(0, 80)}"`);
    return null;
  } catch (e) {
    if (VERBOSE) console.log(`    LLM error: ${e.message}`);
    return null;
  }
}

// ============================================================
// Main Audit
// ============================================================

async function main() {
  console.log('=== Audit Non-Review Content ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | LLM: ${SKIP_LLM ? 'OFF' : 'ON'}`);
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
  console.log('');

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
      catch { return false; }
    })
    .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

  const stats = {
    totalScanned: 0,
    alreadyRejected: 0,
    heuristicHigh: 0,
    heuristicMedium: 0,
    llmConfirmed: 0,
    llmCleared: 0,
    llmFailed: 0,
    newFlags: 0,
  };
  const flagged = [];

  let filesProcessed = 0;

  for (const showId of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      if (LIMIT && filesProcessed >= LIMIT) break;
      const filePath = path.join(showDir, file);

      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { continue; }

      // Only audit scored reviews (files that made it into reviews.json)
      if (!data.llmScore && !data.assignedScore) continue;

      // Skip already-rejected unless --force
      if (!FORCE && data.rejectionReason === 'not_a_review') {
        stats.alreadyRejected++;
        continue;
      }

      // Skip manually cleared files (false positives verified by human review)
      if (!FORCE && data.nonReviewManualClear === true) {
        continue;
      }

      stats.totalScanned++;
      filesProcessed++;

      // Get best available text
      const text = data.fullText ||
        data.dtliExcerpt || data.bwwExcerpt ||
        data.showScoreExcerpt || data.nycTheatreExcerpt || '';

      if (text.length < 50) continue; // Too short to classify

      // Layer 1: Heuristic check
      const heuristic = heuristicClassify(text);

      if (heuristic && heuristic.confidence === 'high') {
        stats.heuristicHigh++;
        flagged.push({
          showId, file,
          type: heuristic.type,
          confidence: 'high',
          method: 'heuristic',
          evidence: heuristic.evidence,
          outlet: data.outlet || data.outletId,
          critic: data.criticName,
          score: data.llmScore?.score || data.assignedScore,
        });
        continue;
      }

      if (heuristic && heuristic.confidence === 'medium' && !SKIP_LLM) {
        stats.heuristicMedium++;

        // Layer 2: LLM confirmation
        const showTitle = data.showId ? data.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : showId;
        const llmResult = await llmClassify(text, showTitle, data.outlet || '');

        if (llmResult && llmResult.isNonReview) {
          stats.llmConfirmed++;
          flagged.push({
            showId, file,
            type: heuristic.type,
            confidence: 'high',
            method: 'heuristic+llm',
            evidence: `${heuristic.evidence} | LLM: ${llmResult.reasoning.substring(0, 100)}`,
            outlet: data.outlet || data.outletId,
            critic: data.criticName,
            score: data.llmScore?.score || data.assignedScore,
          });
        } else if (llmResult && !llmResult.isNonReview) {
          stats.llmCleared++;
          if (VERBOSE) console.log(`  ✓ LLM cleared: ${showId}/${file} — ${llmResult.reasoning.substring(0, 80)}`);
        } else {
          stats.llmFailed++;
          // Heuristic medium + LLM failed → flag with medium confidence
          flagged.push({
            showId, file,
            type: heuristic.type,
            confidence: 'medium',
            method: 'heuristic-only',
            evidence: heuristic.evidence,
            outlet: data.outlet || data.outletId,
            critic: data.criticName,
            score: data.llmScore?.score || data.assignedScore,
          });
        }
      }
    }
    if (LIMIT && filesProcessed >= LIMIT) break;
  }

  // --- Results ---
  console.log('\n=== RESULTS ===');
  console.log(`Scanned: ${stats.totalScanned} scored reviews`);
  console.log(`Already rejected: ${stats.alreadyRejected}`);
  console.log(`Heuristic high-confidence: ${stats.heuristicHigh}`);
  console.log(`Heuristic medium → LLM confirmed: ${stats.llmConfirmed}`);
  console.log(`Heuristic medium → LLM cleared: ${stats.llmCleared}`);
  console.log(`Heuristic medium → LLM failed: ${stats.llmFailed}`);
  console.log(`Total flagged: ${flagged.length}`);

  if (flagged.length > 0) {
    console.log('\n--- Flagged Non-Reviews ---');
    for (const f of flagged) {
      console.log(`  ${f.confidence === 'high' ? '✗' : '?'} ${f.showId}/${f.file}`);
      console.log(`    Type: ${f.type} | Outlet: ${f.outlet} | Score: ${f.score}`);
      console.log(`    Evidence: ${f.evidence.substring(0, 120)}`);
    }
  }

  // Write audit report
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const reportPath = path.join(AUDIT_DIR, 'non-review-audit.json');
  const report = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalScanned: stats.totalScanned,
      flagged: flagged.length,
      byType: {},
    },
    flagged,
  };
  // Count by type
  for (const f of flagged) {
    report._meta.byType[f.type] = (report._meta.byType[f.type] || 0) + 1;
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nAudit report: ${reportPath}`);

  // CI gate: fail only on DEFINITIVE wrong-page / junk classes — these never have
  // legit false positives (verified 0 across 34k scored reviews). Soft heuristics
  // (obituary/preview/interview) can FP on real reviews that mention a death etc.,
  // so they stay advisory in the cron, not a hard build gate.
  if (STRICT) {
    // Hard-gate ONLY the definitive wrong-page classes (0 FPs across 34k). Junk/
    // paywall/css stay advisory in the cron — gating them false-fails on real
    // reviews that carry scrape boilerplate (verified: 72 WSJ/HuffPost FPs).
    const GATE_TYPES = new Set(['weather_page', 'sports_page']);
    const high = flagged.filter(f => f.confidence === 'high' && GATE_TYPES.has(f.type));
    if (high.length > 0) {
      console.error(`\n❌ STRICT: ${high.length} scored review(s) classified as non-review content:`);
      for (const f of high.slice(0, 25)) console.error(`   ${f.showId}/${f.file} — ${f.type}: ${String(f.evidence).slice(0, 80)}`);
      console.error('\nThese must not be scored. Flag wrongProduction/invalid or delete them, then rebuild.');
      process.exit(1);
    }
    console.log('\n✓ STRICT: no high-confidence non-reviews among scored reviews.');
    return;
  }

  // Apply flags (if not dry-run, only high-confidence)
  if (!DRY_RUN) {
    const highConfidence = flagged.filter(f => f.confidence === 'high');
    console.log(`\nApplying flags to ${highConfidence.length} high-confidence non-reviews...`);

    for (const f of highConfidence) {
      const filePath = path.join(REVIEW_TEXTS_DIR, f.showId, f.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.nonReviewFlag = true;
        data.nonReviewType = f.type;
        data.nonReviewEvidence = f.evidence;
        data.nonReviewFlaggedAt = new Date().toISOString();
        data.nonReviewMethod = f.method;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        stats.newFlags++;
      } catch (e) {
        console.error(`  Error flagging ${f.showId}/${f.file}: ${e.message}`);
      }
    }
    console.log(`Files flagged: ${stats.newFlags}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
