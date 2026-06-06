#!/usr/bin/env node
/**
 * LLM Wrong-Production Classifier
 *
 * Takes medium-confidence flags from the pre-2005 audit and uses an LLM
 * to determine whether each review is about the original production or
 * a later revival/touring production.
 *
 * Designed for full automation — no human review needed.
 *
 * Usage:
 *   node scripts/classify-wrong-production.js [options]
 *
 * Options:
 *   --dry-run          Report only, no LLM calls (show what would be classified)
 *   --apply            Write wrongProduction flag to source files (high-confidence only)
 *   --limit=N          Cap LLM calls (default: 0 = unlimited)
 *   --concurrency=N    Parallel LLM calls (default: 10)
 *   --provider=NAME    gemini (default) | claude
 *   --show=SLUG        Single show filter
 *   --resume           Continue from checkpoint
 *   --verbose          Per-file details
 *   --reaudit          Re-run the audit script first (refreshes medium-confidence list)
 *
 * Env:
 *   GEMINI_API_KEY     Required for gemini provider (default)
 *   ANTHROPIC_API_KEY  Required for claude provider
 *
 * Input:  data/audit/pre2005-wrong-production.json (medium-confidence results)
 * Output: data/audit/wrong-production-classified.json
 *
 * Integrated into rebuild via: scripts/rebuild-all-reviews.js (future)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { safeWriteReview, safeRenameReview } = require('./lib/review-write-guard');

let lockedSkipCount = 0;

// --- Load .env ---
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch (e) { /* ignore */ }

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const APPLY = args.includes('--apply');
const RESUME = args.includes('--resume');
const VERBOSE = args.includes('--verbose');
const REAUDIT = args.includes('--reaudit');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 10;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'gemini';

// --- Paths ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_PATH = path.join(DATA_DIR, 'audit', 'pre2005-wrong-production.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'audit', 'wrong-production-classified.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'audit', '.classify-wp-checkpoint.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');

// --- Load shows for context ---
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showById = new Map(showsData.shows.map(s => [s.id, s]));

// Build title families for revival lookup — all markets, not just Broadway
const titleFamilies = new Map();
showsData.shows.forEach(s => {
  const baseTitle = s.title.toLowerCase().replace(/['']/g, "'").trim();
  if (!titleFamilies.has(baseTitle)) titleFamilies.set(baseTitle, []);
  titleFamilies.get(baseTitle).push(s);
});

// --- Stats ---
const stats = {
  total: 0,
  skippedNoText: 0,
  skippedAlreadyFlagged: 0,
  skippedFromCheckpoint: 0,
  classified: 0,
  wrongProduction: 0,
  correctProduction: 0,
  uncertain: 0,
  applied: 0,
  moved: 0,
  errors: 0,
  rateLimitHits: 0,
};

// ============================================================
// LLM Providers (same pattern as classify-non-reviews.js)
// ============================================================

function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7', max_uses: 1 }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'advisor-tool-2026-03-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.content?.find(c => c.type === 'text')?.text || '');
          } catch (e) { reject(new Error(`Claude parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`Claude HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
  });
  return new Promise((resolve, reject) => {
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
            resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
          } catch (e) { reject(new Error(`Gemini parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callLLM(systemPrompt, userPrompt) {
  if (PROVIDER === 'claude') return callClaude(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callLLMWithRetry(systemPrompt, userPrompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        stats.rateLimitHits++;
        const delay = Math.pow(2, attempt) * 5000;
        if (VERBOSE) console.log(`  Rate limited, waiting ${delay / 1000}s...`);
        await sleep(delay);
      } else if (attempt < maxRetries - 1) {
        await sleep(2000);
      } else {
        throw e;
      }
    }
  }
}

// ============================================================
// Classification Prompt
// ============================================================

const SYSTEM_PROMPT = `You are an expert in Broadway theater history. Your task is to determine whether a review is about the SPECIFIC Broadway production it is currently filed under, or about a DIFFERENT production (a different Broadway mounting, touring company, regional production, or West End transfer).

You will be given:
1. The show title and the FILED production's Broadway opening year (this may be the original OR a revival)
2. A list of OTHER Broadway productions of the same show (with years and IDs)
3. The review text (or excerpt)
4. The review's publish date (if known)
5. The audit signals that flagged this review

CLASSIFICATION RULES:
- "CORRECT" = the review is about the production it is currently filed under (opened in the given year)
- "WRONG_PRODUCTION" = the review is clearly about a DIFFERENT production than the one it is filed under
- "UNCERTAIN" = not enough evidence to determine

The review is currently filed under a production that opened in a specific year. Your job is to decide if the review matches THAT production, not whether it's about "the original" in any abstract sense.

KEY INDICATORS THE REVIEW MATCHES THE FILED PRODUCTION:
- Discusses the show as new/premiering around the filed production's opening year
- Mentions cast, director, or venue associated with the filed production
- Published near the filed production's opening date
- For long-running shows: published during the continuous run (Lion King has run since 1997, Wicked since 2003, etc.)
- The word "revival" used to describe the filed production (if the filed production IS a revival)

KEY INDICATORS THE REVIEW IS ABOUT A DIFFERENT PRODUCTION:
- Mentions cast/director/venue of a DIFFERENT production listed in "Other Productions"
- Published during the run of a different production, clearly describing a current/recent staging
- References a different year's mounting

IMPORTANT NUANCES:
- Long-running shows (Lion King, Wicked, Phantom, Chicago 1996 revival) have continuous runs spanning decades. A review from 2015 of Lion King is still about the 1997 production — it never closed. Only classify as wrong if the review is clearly about a touring or regional production.
- The word "masks" in Lion King reviews refers to the COSTUMES (part of Julie Taymor's design), not COVID masks.
- "Hamilton" mentioned in passing is a common cultural comparison, NOT evidence of wrong production.
- "twitter" or "social media" in boilerplate (share buttons, bios) is NOT evidence.
- A review that says "revival" is CORRECT if the filed production IS a revival.
- Short excerpts may lack context — lean toward CORRECT for ambiguous cases.

Return ONLY a JSON object (no markdown, no explanation):
{"verdict": "CORRECT|WRONG_PRODUCTION|UNCERTAIN", "confidence": "high|medium|low", "targetShowId": "<other-production-id or null>", "reasoning": "<1-2 sentences>"}`;

// Pure prompt builder extracted to scripts/lib/classifier-prompts.js so the
// opera-aware branching can be unit-tested directly (CLAUDE.md rule 15).
const { buildWrongProductionUserPrompt } = require('./lib/classifier-prompts');

function buildUserPrompt(result, reviewData, revivals) {
  const show = showById.get(result.showId);
  return buildWrongProductionUserPrompt({ show, result, reviewData, revivals });
}

function parseClassifyResponse(raw) {
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj.verdict && obj.confidence) {
      return {
        verdict: obj.verdict.toUpperCase(),
        confidence: obj.confidence.toLowerCase(),
        targetShowId: obj.targetShowId || null,
        reasoning: (obj.reasoning || '').substring(0, 300),
      };
    }
  } catch (e) {
    // Try to extract from malformed response
    const verdictMatch = text.match(/"verdict"\s*:\s*"(\w+)"/);
    const confMatch = text.match(/"confidence"\s*:\s*"(\w+)"/);
    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toUpperCase(),
        confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
        targetShowId: null,
        reasoning: '(parsed from malformed response)',
      };
    }
  }
  return null;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Optionally re-run the audit first
  if (REAUDIT) {
    console.log('Re-running pre-2005 audit...');
    const { execSync } = require('child_process');
    execSync('node scripts/audit-pre2005-reviews.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log('');
  }

  // Load audit results
  if (!fs.existsSync(AUDIT_PATH)) {
    console.error('No audit file found. Run: node scripts/audit-pre2005-reviews.js');
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  let mediumConf = audit.results.filter(r => r.confidence === 'medium');

  console.log(`Loaded ${mediumConf.length} medium-confidence flags from audit`);

  // Apply show filter
  if (SHOW_FILTER) {
    mediumConf = mediumConf.filter(r => r.showId === SHOW_FILTER || r.showId.includes(SHOW_FILTER));
    console.log(`Filtered to ${mediumConf.length} results for show: ${SHOW_FILTER}`);
  }

  stats.total = mediumConf.length;

  // Load checkpoint if resuming
  let checkpoint = {};
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    console.log(`Resuming from checkpoint (${Object.keys(checkpoint).length} already classified)`);
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — would classify these reviews ===');
    const byShow = {};
    mediumConf.forEach(r => {
      if (!byShow[r.showId]) byShow[r.showId] = [];
      byShow[r.showId].push(r);
    });
    for (const [showId, results] of Object.entries(byShow)) {
      console.log(`\n${showId} (${results[0].showTitle}, ${results[0].showYear}): ${results.length} reviews`);
      results.forEach(r => console.log(`  ${r.file} | ${r.signals[0]}`));
    }
    console.log(`\nTotal: ${mediumConf.length} reviews would be classified`);
    return;
  }

  // Process in batches with concurrency
  const results = [];
  let processed = 0;
  const limitedItems = LIMIT > 0 ? mediumConf.slice(0, LIMIT) : mediumConf;

  // Process in concurrent batches
  for (let i = 0; i < limitedItems.length; i += CONCURRENCY) {
    const batch = limitedItems.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (item) => {
      const key = `${item.showId}/${item.file}`;

      // Skip if in checkpoint
      if (checkpoint[key]) {
        stats.skippedFromCheckpoint++;
        results.push(checkpoint[key]);
        return;
      }

      // Load review text
      const filePath = path.join(REVIEW_TEXTS_DIR, item.showId, item.file);
      if (!fs.existsSync(filePath)) {
        stats.skippedNoText++;
        return;
      }

      let reviewData;
      try {
        reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        stats.errors++;
        return;
      }

      // Skip already flagged or already classified by LLM
      if (reviewData.wrongProduction || reviewData.wrongShow || reviewData.wpClassified) {
        stats.skippedAlreadyFlagged++;
        return;
      }

      // Check if there's any text to work with
      const text = reviewData.fullText || reviewData.bwwExcerpt || reviewData.dtliExcerpt
        || reviewData.showScoreExcerpt || reviewData.pullQuote || '';
      if (text.trim().length < 20) {
        stats.skippedNoText++;
        return;
      }

      // Find revivals for context
      const show = showById.get(item.showId);
      const baseTitle = (show?.title || item.showTitle || '').toLowerCase().replace(/['']/g, "'").trim();
      const family = titleFamilies.get(baseTitle) || [];
      const revivals = family.filter(s => s.id !== item.showId && s.openingDate)
        .sort((a, b) => a.openingDate.localeCompare(b.openingDate));

      // Call LLM
      try {
        const raw = await callLLMWithRetry(SYSTEM_PROMPT, buildUserPrompt(item, reviewData, revivals));
        const parsed = parseClassifyResponse(raw);

        if (!parsed) {
          stats.errors++;
          if (VERBOSE) console.log(`  ERROR: Could not parse response for ${key}`);
          return;
        }

        const result = {
          showId: item.showId,
          showTitle: item.showTitle,
          showYear: item.showYear,
          file: item.file,
          outlet: item.outlet,
          criticName: item.criticName,
          publishDate: item.publishDate,
          originalSignals: item.signals,
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          targetShowId: parsed.targetShowId,
          reasoning: parsed.reasoning,
        };

        results.push(result);
        stats.classified++;

        if (parsed.verdict === 'WRONG_PRODUCTION') {
          stats.wrongProduction++;
          if (VERBOSE) console.log(`  WRONG: ${key} → ${parsed.targetShowId || '?'} (${parsed.confidence}) — ${parsed.reasoning}`);
        } else if (parsed.verdict === 'CORRECT' || parsed.verdict === 'ORIGINAL') {
          stats.correctProduction++;
          if (VERBOSE) console.log(`  OK: ${key} (${parsed.confidence})`);
        } else {
          stats.uncertain++;
          if (VERBOSE) console.log(`  UNCERTAIN: ${key} — ${parsed.reasoning}`);
        }

        // Write persistent marker so future runs skip this review (avoids daily re-classification)
        // Only write for non-WRONG verdicts; WRONG gets marked during --apply
        if (parsed.verdict !== 'WRONG_PRODUCTION') {
          reviewData.wpClassified = parsed.verdict.toLowerCase();
          reviewData.wpClassifiedDate = new Date().toISOString().slice(0, 10);
          try {
            const r = safeWriteReview(filePath, reviewData);
            if (r.lockedSkipped) lockedSkipCount++;
          } catch (e) { /* non-fatal */ }
        }

        // Save to checkpoint incrementally
        checkpoint[key] = result;

      } catch (e) {
        stats.errors++;
        console.error(`  ERROR classifying ${key}: ${e.message}`);
      }
    });

    await Promise.all(promises);
    processed += batch.length;

    // Save checkpoint every batch
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));

    // Progress
    const pct = Math.round((processed / limitedItems.length) * 100);
    console.log(`Progress: ${processed}/${limitedItems.length} (${pct}%) — ${stats.wrongProduction} wrong, ${stats.correctProduction} correct, ${stats.uncertain} uncertain`);
  }

  // Write output
  const wrongProd = results.filter(r => r.verdict === 'WRONG_PRODUCTION');
  const wrongHighConf = wrongProd.filter(r => r.confidence === 'high');
  const wrongMedConf = wrongProd.filter(r => r.confidence === 'medium');

  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'LLM-classified wrong-production results from medium-confidence audit flags',
      provider: PROVIDER,
      total: stats.total,
      classified: stats.classified,
      wrongProduction: stats.wrongProduction,
      correctProduction: stats.correctProduction,
      uncertain: stats.uncertain,
      errors: stats.errors,
      wrongHighConfidence: wrongHighConf.length,
      wrongMediumConfidence: wrongMedConf.length,
    },
    results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote classified results to ${OUTPUT_PATH}`);

  // Summary
  console.log('\n=== CLASSIFICATION SUMMARY ===');
  console.log(`Total medium-confidence flags: ${stats.total}`);
  console.log(`Classified by LLM: ${stats.classified}`);
  console.log(`  Original production (correct): ${stats.correctProduction}`);
  console.log(`  Wrong production: ${stats.wrongProduction}`);
  console.log(`    High confidence: ${wrongHighConf.length}`);
  console.log(`    Medium confidence: ${wrongMedConf.length}`);
  console.log(`  Uncertain: ${stats.uncertain}`);
  console.log(`Skipped (no text): ${stats.skippedNoText}`);
  console.log(`Skipped (already flagged): ${stats.skippedAlreadyFlagged}`);
  console.log(`Skipped (from checkpoint): ${stats.skippedFromCheckpoint}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Rate limit hits: ${stats.rateLimitHits}`);

  // Show wrong-production results grouped by show
  if (wrongProd.length > 0) {
    console.log('\n=== WRONG PRODUCTION REVIEWS ===');
    const byShow = {};
    wrongProd.forEach(r => {
      if (!byShow[r.showId]) byShow[r.showId] = [];
      byShow[r.showId].push(r);
    });
    for (const [showId, rList] of Object.entries(byShow)) {
      console.log(`\n${showId} (${rList[0].showTitle}, ${rList[0].showYear}):`);
      rList.forEach(r => {
        console.log(`  ${r.file} → ${r.targetShowId || '?'} [${r.confidence}] — ${r.reasoning}`);
      });
    }
  }

  // Apply mode: flag/move high-confidence wrong-production verdicts
  if (APPLY && wrongHighConf.length > 0) {
    console.log(`\n=== APPLYING ${wrongHighConf.length} HIGH-CONFIDENCE WRONG-PRODUCTION FLAGS ===`);

    for (const result of wrongHighConf) {
      const filePath = path.join(REVIEW_TEXTS_DIR, result.showId, result.file);
      if (!fs.existsSync(filePath)) {
        console.log(`  SKIP: ${result.showId}/${result.file} — file not found`);
        continue;
      }

      const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // If we have a target show ID and it exists, try to move
      if (result.targetShowId && showById.has(result.targetShowId)) {
        const targetDir = path.join(REVIEW_TEXTS_DIR, result.targetShowId);
        fs.mkdirSync(targetDir, { recursive: true });
        const targetPath = path.join(targetDir, result.file);

        reviewData.showId = result.targetShowId;
        reviewData.movedFrom = result.showId;
        reviewData.movedReason = `llm-classify: ${result.reasoning}`;

        if (fs.existsSync(targetPath)) {
          // Duplicate at target — flag source as wrongProduction
          reviewData.wrongProduction = true;
          reviewData.llmClassified = 'wrongProduction';
          reviewData.llmConfidence = result.confidence;
          reviewData.llmReason = result.reasoning;
          reviewData.llmDate = new Date().toISOString().slice(0, 10);
          const r1 = safeWriteReview(filePath, reviewData);
          if (r1.lockedSkipped) lockedSkipCount++;
          stats.applied++;
          console.log(`  FLAGGED ${result.showId}/${result.file} (dup at ${result.targetShowId})`);
        } else {
          const moveResult = safeRenameReview(filePath, targetPath, { newData: reviewData });
          if (moveResult.skipped === 'locked') {
            lockedSkipCount++;
            console.log(`  [LOCKED-SKIP] ${result.showId}/${result.file}: source is locked — refusing MOVE`);
            continue;
          }
          if (moveResult.skipped === 'conflict') {
            console.log(`  [CONFLICT] ${result.showId}/${result.file}: target ${result.targetShowId}/${result.file} appeared mid-flight — skipping MOVE`);
            continue;
          }
          if (!moveResult.wrote) {
            console.log(`  [SKIP-${moveResult.skipped}] ${result.showId}/${result.file}: ${moveResult.error || ''}`);
            continue;
          }
          stats.moved++;
          console.log(`  MOVED ${result.showId}/${result.file} → ${result.targetShowId}/`);
        }
      } else {
        // No target — flag as wrongProduction
        reviewData.wrongProduction = true;
        reviewData.llmClassified = 'wrongProduction';
        reviewData.llmConfidence = result.confidence;
        reviewData.llmReason = result.reasoning;
        reviewData.llmDate = new Date().toISOString().slice(0, 10);
        const r2 = safeWriteReview(filePath, reviewData);
        if (r2.lockedSkipped) lockedSkipCount++;
        stats.applied++;
        console.log(`  FLAGGED ${result.showId}/${result.file}`);
      }
    }

    console.log(`\nApplied: ${stats.applied} flagged, ${stats.moved} moved`);
  } else if (APPLY && wrongHighConf.length === 0) {
    console.log('\nNo high-confidence wrong-production verdicts to apply.');
  }

  // Clean up checkpoint on completion
  if (processed === limitedItems.length && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('Cleaned up checkpoint file.');
  }

  console.log(`[LOCKED-SKIP-COUNT] classify-wrong-production: ${lockedSkipCount}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
