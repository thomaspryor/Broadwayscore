#!/usr/bin/env node
/**
 * Detect Cross-Outlet Duplicate Reviews
 *
 * Complements detect-syndicated-duplicates.js (same critic, different outlets)
 * with THREE additional detection layers:
 *
 *   Layer 1: Cross-outlet content fingerprinting
 *     Same text at different outlets (regardless of credited critic).
 *     Catches AP/wire service syndication, scraped duplicates, re-attributed content.
 *
 *   Layer 2: Excerpt-based similarity
 *     When fullText is unavailable, compares aggregator excerpts across outlets.
 *     Catches duplicate reviews that only have excerpt data.
 *
 *   Layer 3: LLM confirmation for borderline cases
 *     Gemini Flash confirms whether two texts are the same review.
 *
 * Usage:
 *   node scripts/detect-cross-outlet-duplicates.js [options]
 *
 * Options:
 *   --dry-run         Report only, don't modify files
 *   --show=SLUG       Only process one show
 *   --threshold=N     Similarity threshold 0-100 (default: 40)
 *   --verbose         Extra logging
 *   --report          Generate audit report only (implies --dry-run)
 *   --skip-llm        Skip LLM confirmation
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('--report');
const REPORT = args.includes('--report');
const VERBOSE = args.includes('--verbose');
const SKIP_LLM = args.includes('--skip-llm');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const THRESHOLD = parseInt((args.find(a => a.startsWith('--threshold=')) || '').split('=')[1]) || 40;

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_DIR = path.join(__dirname, '../data/audit');

// Outlet tier lookup — reads from outlet-registry.json (source of truth)
const { getTier } = require('./lib/outlet-tiers');
const { GEMINI_FLASH } = require('./lib/models');

// ============================================================
// Text Processing
// ============================================================

/**
 * DJB2 hash of normalized text (first N chars).
 * Same algorithm as content-quality.js for consistency.
 */
function contentFingerprint(text, charLimit = 500) {
  if (!text || text.length < 50) return null;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, charLimit);
  if (normalized.length < 30) return null;
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(16);
}

/**
 * Word trigram Jaccard similarity (same as detect-syndicated-duplicates.js).
 */
function trigramSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const words1 = text1.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const words2 = text2.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (words1.length < 5 || words2.length < 5) return 0; // Lower threshold for excerpts

  const trigrams1 = new Set();
  const trigrams2 = new Set();
  for (let i = 0; i < words1.length - 2; i++) trigrams1.add(words1.slice(i, i + 3).join(' '));
  for (let i = 0; i < words2.length - 2; i++) trigrams2.add(words2.slice(i, i + 3).join(' '));

  let intersection = 0;
  for (const t of trigrams1) if (trigrams2.has(t)) intersection++;
  const union = trigrams1.size + trigrams2.size - intersection;
  return union === 0 ? 0 : Math.round(100 * intersection / union);
}

/**
 * Get the best available text from a review file.
 * Prefers fullText, falls back to concatenated excerpts.
 */
function getBestText(data) {
  if (data.fullText && data.fullText.length > 50) return { text: data.fullText, source: 'fullText' };
  // Concatenate all available excerpts
  const excerpts = [
    data.dtliExcerpt,
    data.bwwExcerpt,
    data.showScoreExcerpt,
    data.nycTheatreExcerpt,
  ].filter(Boolean);
  if (excerpts.length > 0) {
    return { text: excerpts.join(' '), source: 'excerpts' };
  }
  return { text: '', source: 'none' };
}

// ============================================================
// LLM Confirmation (Layer 3)
// ============================================================

function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 30, thinkingConfig: { thinkingBudget: 0 } }
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
          } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

async function llmConfirmDuplicate(text1, text2, outlet1, outlet2) {
  const snippet1 = text1.substring(0, 500);
  const snippet2 = text2.substring(0, 500);
  const prompt = `Are these two texts from the same theater review (possibly syndicated across outlets)?

Text 1 (${outlet1}): "${snippet1}"

Text 2 (${outlet2}): "${snippet2}"

Answer YES (same review) or NO (different reviews).`;

  try {
    const response = await callGemini(prompt);
    const clean = response.trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (clean.startsWith('yes')) return true;
    if (clean.startsWith('no')) return false;
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Main Detection
// ============================================================

async function main() {
  console.log('=== Detect Cross-Outlet Duplicate Reviews ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | Threshold: ${THRESHOLD}% | LLM: ${SKIP_LLM ? 'OFF' : 'ON'}`);
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
  console.log('');

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
      catch { return false; }
    })
    .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

  const stats = {
    showsScanned: 0,
    reviewsScanned: 0,
    fingerprintMatches: 0,
    similarityMatches: 0,
    llmConfirmed: 0,
    llmRejected: 0,
    alreadyFlagged: 0,
    newDuplicates: 0,
  };
  const duplicates = [];

  for (const showId of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    if (files.length < 2) continue;
    stats.showsScanned++;

    // Load all reviews for this show
    const reviews = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        // Skip already-rejected reviews
        if (data.rejectionReason) continue;
        // Skip reviews without any text
        const { text, source } = getBestText(data);
        if (!text || text.length < 50) continue;
        // Skip already-flagged syndicated duplicates
        if (data.isSyndicatedDuplicate || data.duplicateOf || data.duplicateTextOf) {
          stats.alreadyFlagged++;
          continue;
        }

        reviews.push({
          file,
          outletId: data.outletId || file.split('--')[0],
          outlet: data.outlet || data.outletId || '',
          criticName: data.criticName || '',
          text,
          textSource: source,
          fingerprint: contentFingerprint(text),
          score: data.llmScore?.score || data.assignedScore || null,
        });
        stats.reviewsScanned++;
      } catch { /* skip corrupt */ }
    }

    // --- Layer 1: Cross-outlet fingerprint matching ---
    const fingerprintGroups = {};
    for (const review of reviews) {
      if (!review.fingerprint) continue;
      if (!fingerprintGroups[review.fingerprint]) fingerprintGroups[review.fingerprint] = [];
      fingerprintGroups[review.fingerprint].push(review);
    }

    for (const [fp, group] of Object.entries(fingerprintGroups)) {
      if (group.length < 2) continue;
      // Filter to cross-outlet only (same outlet handled by content-quality.js)
      const outlets = new Set(group.map(r => r.outletId));
      if (outlets.size < 2) continue;

      stats.fingerprintMatches++;

      // Choose primary: higher tier, more text, then alphabetical
      group.sort((a, b) => getTier(a.outletId) - getTier(b.outletId) || b.text.length - a.text.length);
      const primary = group[0];

      for (let i = 1; i < group.length; i++) {
        const secondary = group[i];
        duplicates.push({
          showId,
          method: 'fingerprint',
          similarity: 100,
          primaryFile: primary.file,
          primaryOutlet: primary.outlet,
          primaryCritic: primary.criticName,
          secondaryFile: secondary.file,
          secondaryOutlet: secondary.outlet,
          secondaryCritic: secondary.criticName,
          primaryScore: primary.score,
          secondaryScore: secondary.score,
          scoreDiff: Math.abs((primary.score || 0) - (secondary.score || 0)),
          textSource: secondary.textSource,
        });
      }
    }

    // --- Layer 2: Cross-outlet similarity matching ---
    // Only compare reviews from DIFFERENT outlets (and different critics)
    for (let i = 0; i < reviews.length; i++) {
      for (let j = i + 1; j < reviews.length; j++) {
        const r1 = reviews[i];
        const r2 = reviews[j];

        // Skip same outlet (handled by existing dedup)
        if (r1.outletId === r2.outletId) continue;
        // Skip same critic (handled by detect-syndicated-duplicates.js)
        if (r1.criticName && r2.criticName &&
            r1.criticName.toLowerCase() === r2.criticName.toLowerCase()) continue;
        // Skip if already caught by fingerprint
        if (r1.fingerprint && r1.fingerprint === r2.fingerprint) continue;

        const sim = trigramSimilarity(r1.text, r2.text);
        if (sim < THRESHOLD) continue;

        stats.similarityMatches++;

        // Layer 3: LLM confirmation for borderline (40-70% similarity)
        let llmResult = null;
        if (!SKIP_LLM && sim < 70) {
          llmResult = await llmConfirmDuplicate(r1.text, r2.text, r1.outlet, r2.outlet);
          if (llmResult === true) {
            stats.llmConfirmed++;
          } else if (llmResult === false) {
            stats.llmRejected++;
            if (VERBOSE) console.log(`  LLM rejected: ${showId}/${r1.file} vs ${r2.file} (sim ${sim}%)`);
            continue; // LLM says different reviews
          }
        }

        // Choose primary
        const primaryIdx = getTier(r1.outletId) < getTier(r2.outletId) ? 0 :
                          getTier(r1.outletId) > getTier(r2.outletId) ? 1 :
                          r1.text.length >= r2.text.length ? 0 : 1;
        const primary = primaryIdx === 0 ? r1 : r2;
        const secondary = primaryIdx === 0 ? r2 : r1;

        duplicates.push({
          showId,
          method: llmResult === true ? 'similarity+llm' : 'similarity',
          similarity: sim,
          primaryFile: primary.file,
          primaryOutlet: primary.outlet,
          primaryCritic: primary.criticName,
          secondaryFile: secondary.file,
          secondaryOutlet: secondary.outlet,
          secondaryCritic: secondary.criticName,
          primaryScore: primary.score,
          secondaryScore: secondary.score,
          scoreDiff: Math.abs((primary.score || 0) - (secondary.score || 0)),
          textSource: secondary.textSource,
        });
      }
    }
  }

  // --- Results ---
  console.log('\n=== RESULTS ===');
  console.log(`Shows scanned: ${stats.showsScanned}`);
  console.log(`Reviews scanned: ${stats.reviewsScanned}`);
  console.log(`Already flagged: ${stats.alreadyFlagged}`);
  console.log(`Fingerprint matches: ${stats.fingerprintMatches}`);
  console.log(`Similarity matches: ${stats.similarityMatches}`);
  if (!SKIP_LLM) {
    console.log(`LLM confirmed: ${stats.llmConfirmed} | LLM rejected: ${stats.llmRejected}`);
  }
  console.log(`Total duplicates found: ${duplicates.length}`);

  if (duplicates.length > 0) {
    // Deduplicate results (same pair might be found by both methods)
    const seen = new Set();
    const unique = duplicates.filter(d => {
      const key = `${d.showId}|${d.primaryFile}|${d.secondaryFile}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`\nUnique duplicate pairs: ${unique.length}`);

    // Group by method
    const byMethod = {};
    for (const d of unique) {
      if (!byMethod[d.method]) byMethod[d.method] = [];
      byMethod[d.method].push(d);
    }
    for (const [method, items] of Object.entries(byMethod)) {
      console.log(`  ${method}: ${items.length}`);
    }

    // Show details
    console.log('\n--- Duplicate Pairs ---');
    for (const d of unique.slice(0, 50)) {
      console.log(`\n  ${d.showId}:`);
      console.log(`    Primary: ${d.primaryOutlet} (${d.primaryCritic}) — ${d.primaryFile}`);
      console.log(`    Secondary: ${d.secondaryOutlet} (${d.secondaryCritic}) — ${d.secondaryFile}`);
      console.log(`    Method: ${d.method} | Similarity: ${d.similarity}% | Scores: ${d.primaryScore}/${d.secondaryScore} (diff ${d.scoreDiff})`);
    }

    // Score impact
    const totalDiff = unique.reduce((s, d) => s + d.scoreDiff, 0);
    console.log('\n--- Score Impact ---');
    console.log(`Avg score diff: ${(totalDiff / unique.length).toFixed(1)} pts`);
    console.log(`>5 pt diff: ${unique.filter(d => d.scoreDiff > 5).length}`);
    console.log(`>10 pt diff: ${unique.filter(d => d.scoreDiff > 10).length}`);

    // Write audit report
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const report = {
      _meta: {
        generatedAt: new Date().toISOString(),
        threshold: THRESHOLD,
        showsScanned: stats.showsScanned,
        reviewsScanned: stats.reviewsScanned,
        duplicatesFound: unique.length,
        byMethod,
      },
      duplicates: unique,
    };
    const reportPath = path.join(AUDIT_DIR, 'cross-outlet-duplicates.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nAudit report: ${reportPath}`);

    // Apply flags (if not dry-run)
    if (!DRY_RUN) {
      let written = 0;
      for (const d of unique) {
        const filePath = path.join(REVIEW_TEXTS_DIR, d.showId, d.secondaryFile);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.crossOutletDuplicate) continue; // Already flagged
          data.crossOutletDuplicate = true;
          data.crossOutletPrimaryFile = `${d.showId}/${d.primaryFile}`;
          data.crossOutletSimilarity = d.similarity;
          data.crossOutletMethod = d.method;
          data.crossOutletFlaggedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
          written++;
        } catch (e) {
          console.error(`  Error flagging ${d.showId}/${d.secondaryFile}: ${e.message}`);
        }
      }
      console.log(`\nFiles flagged: ${written}`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
