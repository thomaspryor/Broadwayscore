#!/usr/bin/env node
/**
 * LLM Wrong-Show Classifier
 *
 * Identifies dateless SERP/aggregator reviews where the text doesn't mention
 * the expected show title, then uses Gemini Flash to classify whether the
 * review is actually about the stated show or a different one.
 *
 * Pre-filter (free): ~40 candidates from ~4500 review files.
 * LLM cost: ~$0.003 total (Gemini 2.0 Flash).
 *
 * Usage:
 *   node scripts/classify-wrong-show.js [options]
 *
 * Options:
 *   --dry-run          List candidates only, no LLM calls
 *   --apply            Write flags to source files
 *   --limit=N          Cap LLM calls (default: 0 = unlimited)
 *   --concurrency=N    Parallel LLM calls (default: 5)
 *   --resume           Continue from checkpoint
 *   --verbose          Per-file details
 *
 * Env:
 *   GEMINI_API_KEY     Required
 *
 * Integrated into rebuild via: .github/workflows/rebuild-reviews.yml
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { safeWriteReview } = require('./lib/review-write-guard');
const { GEMINI_FLASH } = require('./lib/models');

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
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 5;

if (!DRY_RUN && !APPLY) {
  console.log('Usage: node scripts/classify-wrong-show.js --dry-run | --apply [--limit=N] [--resume] [--verbose]');
  process.exit(0);
}

// --- Paths ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'audit', '.classify-ws-checkpoint.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'audit', 'wrong-show-classified.json');

// --- Imports from show-matching ---
const { titleWordsMatch, TITLE_GENERIC_WORDS } = require('./lib/show-matching');
const { isLondonMarket, isUkOutletUrl } = require('./lib/venue-classification');
const { wrongShowCleared } = require('./lib/review-guards');

// --- Load shows ---
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showTitleMap = new Map(showsData.shows.map(s => [s.id, s.title]));
const showCategoryMap = new Map(showsData.shows.map(s => [s.id, s.category]));
const showTypeMap = new Map(showsData.shows.map(s => [s.id, s.type]));

// --- Stats ---
const stats = {
  scanned: 0,
  candidates: 0,
  classified: 0,
  wrongShow: 0,
  correct: 0,
  uncertain: 0,
  skippedFromCheckpoint: 0,
  errors: 0,
  rateLimitHits: 0,
  applied: 0,
};

// ============================================================
// LLM (Gemini 2.0 Flash — same as classify-wrong-production.js)
// ============================================================

function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 300 }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callWithRetry(systemPrompt, userPrompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callGemini(systemPrompt, userPrompt);
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

function parseResponse(raw) {
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj.verdict && obj.confidence) {
      return {
        verdict: obj.verdict.toUpperCase(),
        confidence: obj.confidence.toLowerCase(),
        reasoning: (obj.reasoning || '').substring(0, 300),
      };
    }
  } catch (e) {
    // Regex fallback for malformed JSON
    const verdictMatch = text.match(/"verdict"\s*:\s*"(\w+)"/);
    const confMatch = text.match(/"confidence"\s*:\s*"(\w+)"/);
    const reasonMatch = text.match(/"reasoning"\s*:\s*"([^"]+)"/);
    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toUpperCase(),
        confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
        reasoning: reasonMatch ? reasonMatch[1].substring(0, 300) : '(parsed from malformed response)',
      };
    }
  }
  return null;
}

// ============================================================
// Classification Prompt
// ============================================================

const SYSTEM_PROMPT = `You classify whether a review text is actually about the stated Broadway/theater show.

CORRECT: The text reviews this show (even if the title isn't mentioned by name — look for cast, plot, creative team, venue, themes that match the show)
WRONG_SHOW: The text is clearly about a different production, OR is garbage/navigation/non-review content (expired domain page, site index, paywall text, cookie notices)
UNCERTAIN: Cannot determine with reasonable confidence

IMPORTANT GUIDELINES:
- Many reviews discuss a show without ever naming it in the body text. A review that talks about the cast, director, venue, or themes of the stated show is CORRECT even without the title.
- If the text discusses a completely different show by name (different title, different plot, different cast), that's WRONG_SHOW.
- Very short excerpts (<200 chars) with generic praise/criticism should be UNCERTAIN, not WRONG_SHOW.
- Navigation text, cookie banners, "page not found", expired domains, site indexes = WRONG_SHOW with high confidence.

Return JSON only: {"verdict":"CORRECT|WRONG_SHOW|UNCERTAIN", "confidence":"high|medium|low", "reasoning":"1-2 sentences"}`;

// Pure prompt builder extracted to scripts/lib/classifier-prompts.js so the
// opera-aware branching can be unit-tested directly (CLAUDE.md rule 15).
const { buildWrongShowUserPrompt } = require('./lib/classifier-prompts');

function buildUserPrompt(showTitle, showId, text) {
  // showTypeMap is populated at module load from shows.json; synthesize a
  // minimal show object for the lib's isOperaShow check.
  const show = { type: showTypeMap.get(showId) || null };
  return buildWrongShowUserPrompt({ show, showTitle, showId, text });
}

// ============================================================
// Candidate Selection (pre-filter)
// ============================================================

function findCandidates() {
  const candidates = [];
  const VALID_SOURCES = new Set(['serp-discovery', 'bww-roundup', 'dtli', 'playbill-verdict']);

  let dirs;
  try {
    dirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    console.error('Cannot read review-texts directory');
    process.exit(1);
  }

  for (const showId of dirs) {
    const showTitle = showTitleMap.get(showId);
    if (!showTitle) continue;

    // Title must have 2+ meaningful words
    const titleWords = showTitle.toLowerCase().split(/[\s,]+/)
      .filter(w => w.length > 2 && !TITLE_GENERIC_WORDS.has(w));
    if (titleWords.length < 2) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    for (const file of files) {
      stats.scanned++;
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip already classified or flagged
        // Note: wrongShow===false means manually verified as correct — skip it too
        if (data.publishDate || data.wrongShow !== undefined || data.wrongProduction || data.wsClassified) continue;
        if (!VALID_SOURCES.has(data.source)) continue;

        // Get text
        const text = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '';
        if (text.length <= 500) continue;

        // Title-mention check — only candidates where text does NOT mention the show title
        if (titleWordsMatch(showTitle, text)) continue;

        candidates.push({ showId, showTitle, file, filePath: path.join(showDir, file), textLength: text.length });
      } catch { /* skip unreadable files */ }
    }
  }

  return candidates;
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('Scanning review-texts for wrong-show candidates...');
  const candidates = findCandidates();
  stats.candidates = candidates.length;

  console.log(`Scanned ${stats.scanned} files, found ${candidates.length} candidates\n`);

  if (DRY_RUN) {
    console.log('=== DRY RUN — would classify these reviews ===\n');
    const byShow = {};
    candidates.forEach(c => {
      if (!byShow[c.showId]) byShow[c.showId] = [];
      byShow[c.showId].push(c);
    });
    for (const [showId, items] of Object.entries(byShow)) {
      console.log(`${showId} ("${items[0].showTitle}"): ${items.length} reviews`);
      items.forEach(c => console.log(`  ${c.file} (${c.textLength} chars)`));
    }
    console.log(`\nTotal: ${candidates.length} reviews would be classified`);
    return;
  }

  // Check API key
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }

  // Load checkpoint
  let checkpoint = {};
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    console.log(`Resuming from checkpoint (${Object.keys(checkpoint).length} already classified)`);
  }

  const limitedItems = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
  const results = [];
  let processed = 0;

  // Process in concurrent batches
  for (let i = 0; i < limitedItems.length; i += CONCURRENCY) {
    const batch = limitedItems.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (candidate) => {
      const key = `${candidate.showId}/${candidate.file}`;

      // Skip if in checkpoint
      if (checkpoint[key]) {
        stats.skippedFromCheckpoint++;
        results.push(checkpoint[key]);
        return;
      }

      // Load review data
      let data;
      try {
        data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
      } catch (e) {
        stats.errors++;
        return;
      }

      // Double-check it hasn't been flagged since candidate scan
      if (data.wrongShow || data.wrongProduction || data.wsClassified) return;

      const text = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '';

      try {
        const raw = await callWithRetry(SYSTEM_PROMPT, buildUserPrompt(candidate.showTitle, candidate.showId, text));
        const parsed = parseResponse(raw);

        if (!parsed) {
          stats.errors++;
          if (VERBOSE) console.log(`  ERROR: Could not parse response for ${key}`);
          return;
        }

        const result = {
          showId: candidate.showId,
          showTitle: candidate.showTitle,
          file: candidate.file,
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
        };

        results.push(result);
        stats.classified++;

        if (parsed.verdict === 'WRONG_SHOW') {
          stats.wrongShow++;
          if (VERBOSE) console.log(`  WRONG: ${key} [${parsed.confidence}] — ${parsed.reasoning}`);

          // Skip wrongShow for London-market shows reviewed by UK outlets —
          // these are almost always false positives from Broadway-centric classification.
          const showCat = showCategoryMap.get(candidate.showId);
          if (isLondonMarket(showCat) && isUkOutletUrl(data.url)) {
            if (VERBOSE) console.log(`  SKIPPED (London market + UK outlet): ${key}`);
            if (APPLY) {
              data.wsClassified = 'london_market_exempt';
              data.wsClassifiedDate = new Date().toISOString().slice(0, 10);
              const r = safeWriteReview(candidate.filePath, data);
              if (r.lockedSkipped) lockedSkipCount++;
            }
          } else if (APPLY && parsed.confidence === 'high' && !wrongShowCleared(data)) {
            // Apply: flag file with wrongShow + wrongShowReason
            data.wrongShow = true;
            data.wrongShowReason = `LLM: ${parsed.reasoning}`;
            data.wsClassified = 'wrong_show';
            data.wsClassifiedDate = new Date().toISOString().slice(0, 10);
            const r = safeWriteReview(candidate.filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
            stats.applied++;
          } else if (APPLY && parsed.confidence === 'medium' && !wrongShowCleared(data)) {
            // Medium confidence — flag but mark for potential review
            data.wrongShow = true;
            data.wrongShowReason = `LLM (medium): ${parsed.reasoning}`;
            data.wsClassified = 'wrong_show';
            data.wsClassifiedDate = new Date().toISOString().slice(0, 10);
            const r = safeWriteReview(candidate.filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
            stats.applied++;
          }
        } else if (parsed.verdict === 'CORRECT') {
          stats.correct++;
          if (VERBOSE) console.log(`  OK: ${key} [${parsed.confidence}] — ${parsed.reasoning}`);

          // Mark as classified so future runs skip it
          if (APPLY) {
            data.wsClassified = 'correct';
            data.wsClassifiedDate = new Date().toISOString().slice(0, 10);
            const r = safeWriteReview(candidate.filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
        } else {
          stats.uncertain++;
          if (VERBOSE) console.log(`  UNCERTAIN: ${key} — ${parsed.reasoning}`);

          if (APPLY) {
            data.wsClassified = 'uncertain';
            data.wsClassifiedDate = new Date().toISOString().slice(0, 10);
            const r = safeWriteReview(candidate.filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
        }

        // Save to checkpoint
        checkpoint[key] = result;

      } catch (e) {
        stats.errors++;
        console.error(`  ERROR classifying ${key}: ${e.message}`);
      }
    });

    await Promise.all(promises);
    processed += batch.length;

    // Save checkpoint every batch
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));

    // Progress
    const pct = Math.round((processed / limitedItems.length) * 100);
    console.log(`Progress: ${processed}/${limitedItems.length} (${pct}%) — ${stats.wrongShow} wrong, ${stats.correct} correct, ${stats.uncertain} uncertain`);
  }

  // Write output
  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'LLM-classified wrong-show results from title-mention guard candidates',
      total: stats.candidates,
      classified: stats.classified,
      wrongShow: stats.wrongShow,
      correct: stats.correct,
      uncertain: stats.uncertain,
      errors: stats.errors,
      applied: stats.applied,
    },
    results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Summary
  console.log('\n=== CLASSIFICATION SUMMARY ===');
  console.log(`Scanned: ${stats.scanned} files`);
  console.log(`Candidates (title not mentioned): ${stats.candidates}`);
  console.log(`Classified by LLM: ${stats.classified}`);
  console.log(`  Correct (review is about this show): ${stats.correct}`);
  console.log(`  Wrong show: ${stats.wrongShow}`);
  console.log(`  Uncertain: ${stats.uncertain}`);
  console.log(`Skipped (from checkpoint): ${stats.skippedFromCheckpoint}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Rate limit hits: ${stats.rateLimitHits}`);
  if (APPLY) console.log(`Applied (flagged wrongShow): ${stats.applied}`);

  // Show wrong-show results
  const wrong = results.filter(r => r.verdict === 'WRONG_SHOW');
  if (wrong.length > 0) {
    console.log('\n=== WRONG SHOW REVIEWS ===');
    wrong.forEach(r => {
      console.log(`  ${r.showId}/${r.file} [${r.confidence}] — ${r.reasoning}`);
    });
  }

  // Clean up checkpoint on full completion
  if (processed === limitedItems.length && LIMIT === 0 && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('\nCleaned up checkpoint file.');
  }

  console.log(`[LOCKED-SKIP-COUNT] classify-wrong-show: ${lockedSkipCount}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
