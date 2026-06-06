#!/usr/bin/env node
/**
 * Review vs. Non-Review Classification
 *
 * Classifies each scored review file as an actual critic's review or a non-review
 * (profile, interview, preview, feature, news, obituary).
 *
 * Single-pass LLM classification for files with fullText; lightweight heuristics
 * for excerpt-only files. Report-only by default; --apply writes flags.
 *
 * Usage:
 *   node scripts/classify-non-reviews.js [options]
 *
 * Options:
 *   --dry-run               Heuristic checks only, no LLM calls
 *   --apply                 Write isNonReview flag to source files (high-confidence only)
 *   --incremental           Daily rebuild mode: skip already-classified files, auto-apply,
 *                           skip calibration gate, default limit=50, safety cap at >10 non-reviews
 *   --reclassify-flagged    Audit mode: re-run classifier on files currently flagged
 *                           isNonReview=true (default input: /tmp/non-review-flagged.txt;
 *                           override with --input=PATH and --root=PATH for a different
 *                           review-texts root). Disagreements (LLM says review) reveal stale
 *                           flags from older prompts. Pair with --apply to clear stale flags.
 *   --input=PATH            File listing relative paths for --reclassify-flagged (default:
 *                           /tmp/non-review-flagged.txt)
 *   --root=PATH             Root directory for relative paths in --reclassify-flagged
 *                           (default: data/review-texts)
 *   --force                 Main mode: allow --apply even if per-show guard triggers.
 *                           Reclassify mode: also clear medium/low-confidence
 *                           disagreements (default is high-confidence only).
 *   --limit=N               Cap LLM calls
 *   --concurrency=N         Parallel LLM calls (default: 10)
 *   --max-cost=N            Budget cap in dollars (default: 5.00)
 *   --provider=NAME         gemini (default) | openai | claude
 *   --show=SLUG             Single show filter
 *   --resume                Continue from checkpoint
 *   --verbose               Per-file details
 *
 * Env:
 *   GEMINI_API_KEY     Required for gemini provider (default)
 *   OPENAI_API_KEY     Required for openai provider
 *   ANTHROPIC_API_KEY  Required for claude provider
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { safeWriteReview } = require('./lib/review-write-guard');

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
const FORCE = args.includes('--force');
const INCREMENTAL = args.includes('--incremental');
const RESUME = args.includes('--resume');
const VERBOSE = args.includes('--verbose');
const RECLASSIFY_FLAGGED = args.includes('--reclassify-flagged');
const RECLASSIFY_INPUT = (args.find(a => a.startsWith('--input=')) || '').split('=')[1] || '/tmp/non-review-flagged.txt';
const RECLASSIFY_ROOT = (args.find(a => a.startsWith('--root=')) || '').split('=')[1] || '';
const LIMIT_RAW = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const LIMIT = LIMIT_RAW || (INCREMENTAL ? 50 : 0);
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 10;
const MAX_COST = parseFloat((args.find(a => a.startsWith('--max-cost=')) || '').split('=')[1]) || 5.00;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'gemini';

// --- Manual overrides: files confirmed as reviews after spot-checking LLM output ---
// These are excluded from --apply even if the LLM flagged them as non-reviews.
const MANUAL_REVIEW_OVERRIDES = new Set([
  // Full Variety review with extensive evaluation (acting, direction, sets, lighting)
  // LLM confused by embedded "Related Stories" junk in scraped text
  'leopoldstadt-2022/variety--charles-isherwood.json',
  // Full 1,276-word Guardian review evaluating acting, writing, and direction
  // LLM misread descriptive opening as "preview"
  'john-proctor-is-the-villain-2025/guardian--jesse-hassenger.json',
  // NYT feature-review hybrid: primarily ABBA history but evaluates current production
  // ("fine iteration," "sprightlier than it was," critique of Sherrill's performance)
  'mamma-mia-2025/nytimes--elisabeth-vincentelli.json',
]);

// --- Paths ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const OUTPUT_FILE = path.join(AUDIT_DIR, 'non-review-classification.json');

// Locked-skip counter — logged at exit for S2-T4 rebuild-reviews aggregation.
let lockedSkipCount = 0;

// --- Cost tracking ---
const COST_BY_PROVIDER = {
  claude: 0.006,
  gemini: 0.0001,
  openai: 0.005
};
const COST_PER_CALL = COST_BY_PROVIDER[PROVIDER] || 0.0001;

// --- Stats ---
const stats = {
  totalFiles: 0,
  inReviewsJson: 0,
  skippedExcluded: 0,
  withFullText: 0,
  excerptOnly: 0,
  llmClassified: 0,
  heuristicFlagged: 0,
  nonReviewsFound: 0,
  uncertainCases: 0,
  budgetUsed: 0,
  llmCalls: 0,
  rateLimitHits: 0,
  errors: 0
};

// ============================================================
// LLM Providers (reused from audit-llm-scores.js)
// ============================================================

function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
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
    generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
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

function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const body = JSON.stringify({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (e) { reject(new Error(`OpenAI parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
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
  if (PROVIDER === 'openai') return callOpenAI(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Classification Prompt
// ============================================================

const CLASSIFY_SYSTEM_PROMPT = `You are a content classifier for Broadway theater articles. Your job is to determine whether a given text is a CRITIC'S REVIEW of a Broadway show, or a different type of article.

A REVIEW evaluates the quality of a production — acting, direction, writing, design — and contains the critic's opinion or recommendation. The following ALL count as reviews:
- Full-length reviews (any length)
- Capsule/brief reviews (even 2-3 sentences with a verdict)
- Roundup segments evaluating this specific show
- Brief notices with a recommendation

NOT a review — classify as the appropriate type:
- PROFILE: biographical article about a cast or creative team member
- INTERVIEW: Q&A or conversation with someone involved in the production
- PREVIEW: pre-opening article that describes but does NOT evaluate the production
- FEATURE: general interest article about the show's topic, history, or context
- NEWS: casting announcements, box office reports, award nominations, closings
- OBITUARY: memorial article about a deceased theater person

IMPORTANT: Short reviews that pack a verdict into 1-3 sentences ARE reviews. Do not classify brief evaluative content as news or preview. A review CAN mention biographical details while primarily evaluating the show.

Return ONLY a JSON object (no markdown, no explanation):
{"isReview": true/false, "contentType": "review|profile|interview|preview|feature|news|obituary", "confidence": "high|medium|low", "reasoning": "<1-2 sentences>"}`;

function buildClassifyPrompt(showTitle, fullText) {
  let text = fullText;
  if (fullText.length > 3000) {
    text = fullText.substring(0, 2000) + '\n\n[...middle truncated...]\n\n' + fullText.substring(fullText.length - 1000);
  }
  return `The target show is: "${showTitle}"\n\nArticle text:\n${text}`;
}

function parseClassifyResponse(raw) {
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(text);
    if (typeof obj.isReview === 'boolean' && obj.contentType && obj.confidence) {
      return {
        isReview: obj.isReview,
        contentType: obj.contentType.toLowerCase(),
        confidence: obj.confidence.toLowerCase(),
        reasoning: (obj.reasoning || '').substring(0, 300)
      };
    }
  } catch (e) {
    // Try to extract from malformed response
    const isReviewMatch = text.match(/"isReview"\s*:\s*(true|false)/);
    const typeMatch = text.match(/"contentType"\s*:\s*"(\w+)"/);
    if (isReviewMatch) {
      return {
        isReview: isReviewMatch[1] === 'true',
        contentType: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
        confidence: 'low',
        reasoning: '(parsed from malformed response)'
      };
    }
  }
  return null;
}

// ============================================================
// Heuristic Checks (excerpt-only files without fullText)
// ============================================================

function buildKnownOutletRegistry() {
  const registry = new Set();

  // Load outlets from outlet-registry.json (source of truth)
  try {
    const regPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
    const outletRegistry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const id of Object.keys(outletRegistry.outlets || {})) {
      if (id !== '_aliasIndex' && id !== '_meta') registry.add(id);
    }
  } catch (e) { /* skip */ }

  // Load critic-registry.json outlets
  try {
    const regPath = path.join(DATA_DIR, 'critic-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const entries = reg.critics || reg;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (e.outletId) registry.add(e.outletId);
        if (e.outlet) registry.add(e.outlet.toLowerCase().replace(/\s+/g, '-'));
      }
    } else if (typeof entries === 'object') {
      for (const key of Object.keys(entries)) {
        registry.add(key);
        const e = entries[key];
        if (e.outlets) {
          for (const o of e.outlets) {
            if (o.outletId) registry.add(o.outletId);
          }
        }
      }
    }
  } catch (e) { /* skip */ }

  return registry;
}

const PERSON_NAME_PATTERN = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/;
const URL_NON_REVIEW_KEYWORDS = [
  '/interview/', '/profile/', '/feature/', '/obituary/',
  '/first-look/', '/behind-the-scenes/', '/qa-with/', '/in-conversation/',
  '-interview-', '-profile-', '-obituary-'
];

function runHeuristicChecks(data, knownOutlets) {
  const flags = [];

  // H1: Outlet is a person name, not a known publication
  const outlet = data.outlet || '';
  const outletId = data.outletId || '';
  if (PERSON_NAME_PATTERN.test(outlet) && !knownOutlets.has(outletId)) {
    flags.push('outletIsPersonName');
  }

  // H2: URL path contains non-review keywords
  const url = (data.url || '').toLowerCase();
  for (const kw of URL_NON_REVIEW_KEYWORDS) {
    if (url.includes(kw)) {
      flags.push('urlNonReviewKeyword');
      break;
    }
  }

  return flags;
}

// ============================================================
// Calibration Gate
// ============================================================

// Hardcoded calibration set — 25 files with known classifications
// Each entry: [filePath, expectedIsReview, reason]
const CALIBRATION_SET = [
  // --- 10 full-length reviews (clearly reviews) ---
  ['fun-home-2015/front-row-center--tulis-mccall.json', true, 'Full-length rave review (1196 words)'],
  ['king-kong-2018/nytimes--jesse-green.json', true, 'Full-length pan review, dialogue format (1307 words)'],
  ['stranger-things-2024/vulture--sara-holdren.json', true, 'Full-length mixed review (2194 words)'],
  ['tootsie-2019/hollywood-reporter--david-rooney.json', true, 'Performance-focused positive review (2034 words)'],
  ['my-fair-lady-2018/dailybeast--tim-teeman.json', true, 'Performance-focused mixed review (2086 words)'],
  // --- 5 capsule/brief reviews (false-positive risk) ---
  ['death-of-a-salesman-2022/ew--fabian-brathwiate.json', true, 'Brief EW review (~391 words)'],
  ['the-boys-in-the-band-2018/washpost--peter-marks.json', true, 'Very brief WaPo notice (~109 words)'],
  ['choir-boy-2019/wsj--terry-teachout.json', true, 'Brief WSJ review (~127 words)'],
  ['sweat-2017/washpost--peter-marks.json', true, 'Brief notice (132 words)'],
  ['carousel-2018/vulture--sara-holdren.json', true, 'Capsule Vulture review (~325 words)'],
  // --- 5 mixed-content reviews (bio + evaluation) ---
  ['hamilton-2015/nbcny--robert-kahn.json', true, 'Performer-focused capsule with evaluation'],
  ['amazing-grace-2015/broadwayworld--paul-w-thompson.json', true, 'Cast-focused review with biographical context'],
  ['cirque-du-soleil-paramour-2016/the-globe-and-mail--kelly-nestruck.json', true, 'Full-length pan with context'],
  ['redwood-2025/deadline--greg-evans.json', true, 'Long Deadline mixed review'],
  ['700-sundays-2013/nytimes--charles-isherwood.json', true, 'NYT capsule review'],
  // --- 4 edge cases ---
  ['amazing-grace-2015/the-clyde-fitch-report--david-finkle.json', true, 'Roundup segment (still evaluative)'],
  ['angels-in-america-2018/the-clyde-fitch-report--david-finkle.json', true, 'Roundup segment (still evaluative)'],
  ['13-2008/nytimes--ben-brantley.json', true, 'Excerpt-only (should classify as review from excerpt)'],
  ['110-in-the-shade-2007/nytimes--charles-isherwood.json', true, 'Excerpt-only review'],
  // --- 1 known non-review ---
  ['evita-2012/elena-roger--unknown.json', false, 'NYT biographical profile of actress, NOT a review'],
];

async function runCalibrationGate(showTitleMap) {
  console.log('\n=== CALIBRATION GATE ===');
  console.log(`Testing ${CALIBRATION_SET.length} files...`);

  let correct = 0;
  let total = 0;
  let nonReviewCorrect = 0;
  let nonReviewTotal = 0;
  const failures = [];

  for (const [filePath, expectedIsReview, reason] of CALIBRATION_SET) {
    const fullPath = path.join(REVIEW_TEXTS_DIR, filePath);
    if (!fs.existsSync(fullPath)) {
      console.log(`  SKIP (not found): ${filePath}`);
      continue;
    }

    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const fullText = data.fullText || '';
    const showId = data.showId || filePath.split('/')[0];
    const showTitle = showTitleMap[showId] || showId;

    if (!expectedIsReview) nonReviewTotal++;
    total++;

    // For files with fullText, use LLM
    if (fullText.length > 200) {
      const prompt = buildClassifyPrompt(showTitle, fullText);
      try {
        const raw = await callLLMWithRetry(CLASSIFY_SYSTEM_PROMPT, prompt);
        stats.llmCalls++;
        stats.budgetUsed += COST_PER_CALL;
        const result = parseClassifyResponse(raw);

        if (result) {
          const isCorrect = result.isReview === expectedIsReview;
          if (isCorrect) {
            correct++;
            if (!expectedIsReview) nonReviewCorrect++;
          } else {
            failures.push({ filePath, expected: expectedIsReview, got: result.isReview, contentType: result.contentType, reasoning: result.reasoning });
          }
          if (VERBOSE) {
            console.log(`  ${isCorrect ? 'OK' : 'FAIL'}: ${filePath} — expected=${expectedIsReview}, got=${result.isReview} (${result.contentType}, ${result.confidence})`);
          }
        } else {
          console.log(`  ERROR (parse): ${filePath}`);
        }
      } catch (e) {
        console.log(`  ERROR (${e.message}): ${filePath}`);
      }
    } else {
      // Excerpt-only: assume review (most are)
      if (expectedIsReview) correct++;
      if (VERBOSE) console.log(`  SKIP-LLM (no fullText): ${filePath} — assumed review`);
    }
  }

  const reviewTotal = total - nonReviewTotal;
  const reviewCorrect = correct - nonReviewCorrect;

  console.log(`\nCalibration results: ${correct}/${total} correct`);
  console.log(`  Reviews: ${reviewCorrect}/${reviewTotal} correct`);
  console.log(`  Non-reviews: ${nonReviewCorrect}/${nonReviewTotal} correct`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ${f.filePath}: expected=${f.expected}, got=${f.got} (${f.contentType}) — ${f.reasoning}`);
    }
  }

  // Gate: 100% on non-reviews, ≥90% on reviews
  const nonReviewPassed = nonReviewTotal === 0 || nonReviewCorrect === nonReviewTotal;
  const reviewThreshold = Math.floor(reviewTotal * 0.9);
  const reviewPassed = reviewCorrect >= reviewThreshold;
  const passed = nonReviewPassed && reviewPassed;

  console.log(`\nCalibration ${passed ? 'PASSED' : 'FAILED'}`);
  if (!nonReviewPassed) console.log('  FAIL: Non-review detection failed');
  if (!reviewPassed) console.log(`  FAIL: Review accuracy ${reviewCorrect}/${reviewTotal} below threshold ${reviewThreshold}`);

  return { passed, correct, total, reviewCorrect, reviewTotal, nonReviewCorrect, nonReviewTotal, failures };
}

// ============================================================
// Reclassify-flagged audit mode
//
// Re-runs the current classifier prompt on files that already carry
// isNonReview=true on disk. Disagreements (LLM now says "review") reveal
// stale flags written by older prompt versions. Pair with --apply to
// clear the stale flag (preserves all other fields, including any
// concurrent edits in flight).
//
// Belt-and-suspenders pattern from the isLikelyStaleRoundupFlag sweep
// (Notion 34e637c5-416f-817b). isNonReview is actively maintained by
// classify-non-reviews.js incremental runs, so a sweep alone is enough —
// no gate-side override needed (any future re-classification will reset
// the flag if the file is in fact a non-review).
// ============================================================

async function runReclassifyFlagged() {
  const inputPath = RECLASSIFY_INPUT;
  if (!fs.existsSync(inputPath)) {
    console.error(`Input list not found: ${inputPath}`);
    console.error(`Generate with: node -e '... > ${inputPath}'`);
    process.exit(1);
  }

  const root = RECLASSIFY_ROOT || REVIEW_TEXTS_DIR;
  console.log(`Input list: ${inputPath}`);
  console.log(`Root: ${root}`);

  const relPaths = fs.readFileSync(inputPath, 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`Files in list: ${relPaths.length}`);

  // Load shows.json for titles (used by classifier prompt)
  const showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  const showsList = showsData.shows || showsData;
  const showArr = Array.isArray(showsList) ? showsList : Object.values(showsList);
  const showTitleMap = {};
  for (const s of showArr) {
    if (s.id && s.title) showTitleMap[s.id] = s.title;
  }

  // Load each file, build classify list. Skip files that no longer exist or
  // no longer have isNonReview=true on disk (something else cleared them).
  const candidates = [];
  let missingFile = 0, noFlag = 0, noFullText = 0;
  for (const rel of relPaths) {
    if (SHOW_FILTER && !rel.startsWith(SHOW_FILTER + '/')) continue;
    const fullPath = path.join(root, rel);
    let data;
    try { data = JSON.parse(fs.readFileSync(fullPath, 'utf8')); }
    catch { missingFile++; continue; }
    if (data.isNonReview !== true) { noFlag++; continue; }
    const fullText = (data.fullText || '').trim();
    if (fullText.length <= 200) { noFullText++; continue; }
    candidates.push({
      rel,
      fullPath,
      showId: data.showId || rel.split('/')[0],
      outlet: data.outlet || data.outletId,
      outletId: data.outletId,
      currentNonReviewType: data.nonReviewType || null,
      classifiedAt: data.classifiedAt || null,
      fullText,
    });
  }

  console.log(`Skipped — file missing/unparseable: ${missingFile}`);
  console.log(`Skipped — flag already cleared on disk: ${noFlag}`);
  console.log(`Skipped — fullText too short for LLM: ${noFullText}`);
  console.log(`Reclassifying: ${candidates.length} files\n`);

  let toProcess = candidates;
  if (LIMIT > 0 && toProcess.length > LIMIT) {
    console.log(`Limiting to ${LIMIT} of ${toProcess.length} files`);
    toProcess = toProcess.slice(0, LIMIT);
  }

  // Classify in batches with concurrency
  const disagreements = []; // LLM says review (current flag is stale)
  const agreements = [];    // LLM also says non-review (flag still valid)
  const errors = [];

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    if (stats.budgetUsed >= MAX_COST) {
      console.log(`\nBudget exhausted ($${stats.budgetUsed.toFixed(4)} >= $${MAX_COST}). Stopping.`);
      break;
    }
    const batch = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (c) => {
        const showTitle = showTitleMap[c.showId] || c.showId;
        const prompt = buildClassifyPrompt(showTitle, c.fullText);
        const raw = await callLLMWithRetry(CLASSIFY_SYSTEM_PROMPT, prompt);
        stats.llmCalls++;
        stats.budgetUsed += COST_PER_CALL;
        return { c, result: parseClassifyResponse(raw) };
      })
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value.result) {
        errors.push({ file: r.status === 'fulfilled' ? r.value.c.rel : '(unknown)',
                      reason: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : 'parse failed' });
        stats.errors++;
        continue;
      }
      const { c, result } = r.value;
      const item = {
        file: c.rel,
        showId: c.showId,
        outlet: c.outlet,
        outletId: c.outletId,
        currentNonReviewType: c.currentNonReviewType,
        previousClassifiedAt: c.classifiedAt,
        newClassification: {
          isReview: result.isReview,
          contentType: result.contentType,
          confidence: result.confidence,
          reasoning: result.reasoning,
        },
      };
      if (result.isReview) disagreements.push(item);
      else agreements.push(item);
      if (VERBOSE) {
        console.log(`  ${result.isReview ? 'STALE' : 'AGREE'}: ${c.rel} — old=${c.currentNonReviewType} new=${result.contentType} (${result.confidence}) — ${result.reasoning}`);
      }
    }
    const processed = Math.min(i + CONCURRENCY, toProcess.length);
    if (processed % 50 === 0 || processed === toProcess.length) {
      console.log(`  Progress: ${processed}/${toProcess.length} | Disagree (stale): ${disagreements.length} | Agree: ${agreements.length} | Errors: ${errors.length} | Cost: $${stats.budgetUsed.toFixed(4)}`);
    }
  }

  // Confidence breakdown of disagreements
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const d of disagreements) byConfidence[d.newClassification.confidence] = (byConfidence[d.newClassification.confidence] || 0) + 1;

  console.log(`\n=== RECLASSIFY-FLAGGED RESULT ===`);
  console.log(`Reclassified: ${disagreements.length + agreements.length}`);
  console.log(`  Disagreements (LLM says review = stale flag): ${disagreements.length}`);
  console.log(`     by confidence: high=${byConfidence.high} medium=${byConfidence.medium} low=${byConfidence.low}`);
  console.log(`  Agreements (LLM still says non-review): ${agreements.length}`);
  console.log(`  Errors: ${errors.length}`);
  console.log(`  LLM calls: ${stats.llmCalls} | Cost: $${stats.budgetUsed.toFixed(4)}`);

  // Save audit report. Write to a timestamped file plus a stable -latest copy
  // so re-runs don't silently overwrite prior runs (dry-run-after-apply burned
  // us in the first session — Notion 34e637c5-416f-8144).
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-04-26T16-41-43
  const reportPath = path.join(AUDIT_DIR, `non-review-reclassify-audit-${ts}.json`);
  const latestPath = path.join(AUDIT_DIR, 'non-review-reclassify-audit.json');
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: APPLY ? 'apply' : 'dry-run',
      provider: PROVIDER,
      input: inputPath,
      root,
      counts: {
        inputFiles: relPaths.length,
        skippedMissing: missingFile,
        skippedFlagAlreadyCleared: noFlag,
        skippedNoFullText: noFullText,
        reclassified: disagreements.length + agreements.length,
        disagreements: disagreements.length,
        agreements: agreements.length,
        errors: errors.length,
        llmCalls: stats.llmCalls,
        budgetUsed: stats.budgetUsed,
      },
      disagreementsByConfidence: byConfidence,
    },
    disagreements,
    agreements: VERBOSE ? agreements : agreements.map(a => a.file),
    errors,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.copyFileSync(reportPath, latestPath);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Latest: ${latestPath}`);

  // Print sample disagreements for spot-checking
  if (disagreements.length > 0 && !APPLY) {
    const sample = disagreements.slice(0, 10);
    console.log(`\n=== SAMPLE DISAGREEMENTS (first ${sample.length}) — MANUALLY VERIFY ===`);
    for (const d of sample) {
      console.log(`\n${d.file}`);
      console.log(`  old type: ${d.currentNonReviewType}  | new: ${d.newClassification.contentType} (${d.newClassification.confidence})`);
      console.log(`  reasoning: ${d.newClassification.reasoning}`);
    }
    console.log('\nDRY RUN — pass --apply to clear isNonReview on the disagreements above.');
    return;
  }

  if (!APPLY) return;

  // Files manually excluded from the sweep — usually because the file's
  // fullText is misattributed (wrong-show contamination), so clearing
  // isNonReview would reactivate a wrongly-scored review. The right fix
  // for these is the wrongShow auditor, not this sweep.
  const RECLASSIFY_EXCLUDE = new Set([
    // 2026-04-26 reclassify-flagged audit (Notion 34e637c5-416f-8144):
    // URL is a Wicked 2003-10-31 review, but cached fullText is Brantley
    // on Omnium Gatherum (Variety Arts Theater, East Village). Clearing
    // isNonReview would re-add an Omnium score (79) to wicked-2003.
    // Needs wrongShow=true via cross-attribution audit instead.
    'wicked-2003/nytimes--ben-brantley.json',
  ]);

  // Apply: clear isNonReview on disagreements. Read fresh, only patch the
  // flag fields, preserve everything else (concurrent writers may have
  // touched the file). Default to high-confidence disagreements only;
  // medium/low are reported but not applied without --force.
  let toClear = FORCE ? disagreements : disagreements.filter(d => d.newClassification.confidence === 'high');
  const excluded = toClear.filter(d => RECLASSIFY_EXCLUDE.has(d.file));
  toClear = toClear.filter(d => !RECLASSIFY_EXCLUDE.has(d.file));
  if (excluded.length > 0) {
    console.log(`\nExcluded ${excluded.length} file(s) from sweep (manual hold for separate wrongShow audit):`);
    excluded.forEach(d => console.log(`  ${d.file}`));
  }
  console.log(`\n=== APPLYING (${toClear.length} files — confidence: ${FORCE ? 'all (--force)' : 'high only'}) ===`);
  if (!FORCE && byConfidence.medium + byConfidence.low > 0) {
    console.log(`  (${byConfidence.medium + byConfidence.low} medium/low-confidence disagreements held — pass --force to also clear)`);
  }
  let applied = 0, failed = 0;
  const now = new Date().toISOString();
  for (const d of toClear) {
    const fullPath = path.join(root, d.file);
    try {
      // Re-read fresh to pick up any concurrent edits
      const fresh = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (fresh.isNonReview !== true) { failed++; continue; }
      fresh.isNonReview = false;
      fresh.nonReviewClearedNote = `[${now.slice(0,10)} cleared stale isNonReview — reclassify-audit (${PROVIDER}) now says ${d.newClassification.contentType} (${d.newClassification.confidence}) — Notion 34e637c5-416f-8144]`;
      // Preserve old type for forensics. Setting to null (not delete) because
      // safeWriteReview merges undefined fields back from disk, so a delete
      // gets silently restored by the merge step (line 202-208).
      if (fresh.nonReviewType) {
        fresh.nonReviewTypePrev = fresh.nonReviewType;
        fresh.nonReviewType = null;
      }
      fresh.classifiedAt = now;
      fresh.nonReviewClassifiedBy = `${PROVIDER}:reclassify-audit`;
      const result = safeWriteReview(fullPath, fresh);
      if (result.lockedSkipped) lockedSkipCount++;
      applied++;
      if (VERBOSE) console.log(`  cleared: ${d.file}`);
    } catch (e) {
      failed++;
      console.log(`  ERROR ${d.file}: ${e.message}`);
    }
  }
  console.log(`\nCleared: ${applied}  | Failed: ${failed}`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('=== Non-Review Classification ===');
  console.log(`Provider: ${PROVIDER} | Cost/call: $${COST_PER_CALL}`);
  console.log(`Budget: $${MAX_COST} | Concurrency: ${CONCURRENCY}`);
  if (RECLASSIFY_FLAGGED) {
    console.log('MODE: reclassify-flagged (audit isNonReview=true files for stale flags)');
    if (APPLY) console.log('       --apply set: will clear stale flags');
    else console.log('       (dry-run: no writes — pass --apply to clear stale flags)');
    return await runReclassifyFlagged();
  }
  if (DRY_RUN) console.log('MODE: dry-run (heuristic only)');
  else if (INCREMENTAL) console.log('MODE: incremental (auto-apply, skip calibration, limit=' + LIMIT + ')');
  else if (APPLY) console.log('MODE: apply (will write flags to source files, high-confidence only)');
  else console.log('MODE: report (LLM classification, no file writes)');
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
  console.log();

  // Load shows.json for titles
  const showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  const showsList = showsData.shows || showsData;
  const showArr = Array.isArray(showsList) ? showsList : Object.values(showsList);
  const showTitleMap = {};
  for (const s of showArr) {
    if (s.id && s.title) showTitleMap[s.id] = s.title;
  }

  // Load reviews.json to know which files are actively scored
  const reviewsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));
  const reviewsList = reviewsData.reviews || reviewsData;
  const reviewsArr = Array.isArray(reviewsList) ? reviewsList : Object.values(reviewsList);
  const activeFiles = new Set();
  const reviewScoreMap = {}; // file -> { assignedScore, reviewCount per show }
  const showReviewCounts = {}; // showId -> count of active reviews

  for (const r of reviewsArr) {
    if (r.showId && r.outletId) {
      const critic = (r.criticName || 'unknown').toLowerCase().replace(/\s+/g, '-');
      const key = `${r.showId}/${r.outletId}--${critic}.json`;
      activeFiles.add(key);
      reviewScoreMap[key] = { assignedScore: r.assignedScore, scoreSource: r.scoreSource };
      showReviewCounts[r.showId] = (showReviewCounts[r.showId] || 0) + 1;
    }
  }
  console.log(`Loaded ${activeFiles.size} active reviews from reviews.json`);
  console.log(`Loaded ${showArr.length} shows`);

  // Build known outlet registry
  const knownOutlets = buildKnownOutletRegistry();
  console.log(`Known outlet registry: ${knownOutlets.size} outlets`);

  // Load checkpoint if resuming
  let checkpoint = { classified: {} };
  if (RESUME && fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (existing.nonReviews) {
        for (const nr of existing.nonReviews) {
          checkpoint.classified[nr.file] = nr;
        }
      }
      if (existing.reviewsConfirmed) {
        for (const rc of existing.reviewsConfirmed) {
          checkpoint.classified[rc] = { isReview: true };
        }
      }
      console.log(`Resuming: ${Object.keys(checkpoint.classified).length} files already classified`);
    } catch (e) { /* fresh start */ }
  }

  // Run calibration gate (unless dry-run or incremental — already validated)
  let calibration = null;
  if (!DRY_RUN && !INCREMENTAL) {
    calibration = await runCalibrationGate(showTitleMap);
    if (!calibration.passed) {
      console.log('\nCalibration FAILED. Aborting. Tune the prompt or check the calibration files.');
      process.exit(1);
    }
  }

  // Scan all review-text files
  console.log('\n=== SCANNING FILES ===');
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  const toClassify = []; // files needing LLM classification
  const heuristicFlags = []; // excerpt-only files flagged by heuristics
  const reviewsConfirmed = []; // files confirmed as reviews

  for (const dir of showDirs) {
    if (SHOW_FILTER && dir.name !== SHOW_FILTER) continue;

    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, dir.name))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const relPath = `${dir.name}/${file}`;
      stats.totalFiles++;

      // Only process files in reviews.json (actively scored)
      if (!activeFiles.has(relPath)) continue;
      stats.inReviewsJson++;

      // Skip already classified (resume)
      if (checkpoint.classified[relPath]) continue;

      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, dir.name, file), 'utf8'));
      } catch (e) { continue; }

      // Skip already-excluded files
      if (data.wrongProduction === true || data.wrongShow === true ||
          data.isRoundupArticle === true || data.textStatus === 'garbage_cleared' ||
          data.isNonReview === true) {
        stats.skippedExcluded++;
        continue;
      }

      // In incremental mode, skip files already classified (have classifiedAt timestamp)
      if (INCREMENTAL && data.classifiedAt) {
        stats.skippedAlreadyClassified = (stats.skippedAlreadyClassified || 0) + 1;
        continue;
      }

      const fullText = data.fullText || '';
      if (fullText.length > 200) {
        stats.withFullText++;
        toClassify.push({
          file: relPath,
          showId: data.showId || dir.name,
          outlet: data.outlet || data.outletId,
          outletId: data.outletId,
          fullText,
          currentScore: reviewScoreMap[relPath]?.assignedScore || data.assignedScore
        });
      } else {
        stats.excerptOnly++;
        // Run heuristic checks on excerpt-only files
        const flags = runHeuristicChecks(data, knownOutlets);
        if (flags.length > 0) {
          heuristicFlags.push({
            file: relPath,
            showId: data.showId || dir.name,
            outlet: data.outlet || data.outletId,
            outletId: data.outletId,
            heuristics: flags,
            currentScore: reviewScoreMap[relPath]?.assignedScore || data.assignedScore,
            confidence: 'heuristic-only'
          });
          stats.heuristicFlagged++;
        }
      }
    }
  }

  console.log(`Total files: ${stats.totalFiles}`);
  console.log(`In reviews.json: ${stats.inReviewsJson}`);
  console.log(`Skipped (excluded): ${stats.skippedExcluded}`);
  if (stats.skippedAlreadyClassified) console.log(`Skipped (already classified): ${stats.skippedAlreadyClassified}`);
  console.log(`With fullText (→ LLM): ${stats.withFullText}`);
  console.log(`Excerpt-only (→ heuristic): ${stats.excerptOnly}`);
  console.log(`Heuristic-flagged: ${stats.heuristicFlagged}`);

  // Early exit in incremental mode when nothing new to classify
  if (INCREMENTAL && toClassify.length === 0) {
    console.log('\nIncremental: No unclassified files found. Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — Heuristic flags only ===');
    if (heuristicFlags.length > 0) {
      for (const f of heuristicFlags) {
        console.log(`  ${f.file} — ${f.heuristics.join(', ')} (score: ${f.currentScore})`);
      }
    } else {
      console.log('  No heuristic flags on excerpt-only files.');
    }
    console.log(`\n${toClassify.length} files would be sent to LLM (not in dry-run mode).`);
    return;
  }

  // Apply limit
  let filesToProcess = toClassify;
  if (LIMIT > 0 && filesToProcess.length > LIMIT) {
    console.log(`\nLimiting to ${LIMIT} of ${filesToProcess.length} files`);
    filesToProcess = filesToProcess.slice(0, LIMIT);
  }

  // LLM Classification
  console.log(`\n=== LLM CLASSIFICATION (${filesToProcess.length} files) ===`);
  const nonReviews = [];
  const uncertainCases = [];

  for (let i = 0; i < filesToProcess.length; i += CONCURRENCY) {
    // Budget check
    if (stats.budgetUsed >= MAX_COST) {
      console.log(`\nBudget exhausted ($${stats.budgetUsed.toFixed(4)} >= $${MAX_COST}). Stopping.`);
      break;
    }

    const batch = filesToProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const showTitle = showTitleMap[entry.showId] || entry.showId;
        const prompt = buildClassifyPrompt(showTitle, entry.fullText);
        const raw = await callLLMWithRetry(CLASSIFY_SYSTEM_PROMPT, prompt);
        stats.llmCalls++;
        stats.budgetUsed += COST_PER_CALL;
        const result = parseClassifyResponse(raw);
        return { entry, result };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.result) {
        const { entry, result } = r.value;
        stats.llmClassified++;

        if (!result.isReview) {
          // Check manual overrides — confirmed reviews that LLM misclassified
          if (MANUAL_REVIEW_OVERRIDES.has(entry.file)) {
            reviewsConfirmed.push(entry.file);
            if (VERBOSE) {
              console.log(`  OVERRIDE (manual): ${entry.file} — LLM said ${result.contentType} but manually confirmed as review`);
            }
          } else {
          const item = {
            file: entry.file,
            showId: entry.showId,
            outlet: entry.outlet,
            outletId: entry.outletId,
            contentType: result.contentType,
            confidence: result.confidence,
            reasoning: result.reasoning,
            currentScore: entry.currentScore
          };

          if (result.confidence === 'high') {
            nonReviews.push(item);
            stats.nonReviewsFound++;
          } else {
            uncertainCases.push(item);
            stats.uncertainCases++;
          }

          if (VERBOSE) {
            console.log(`  NON-REVIEW (${result.confidence}): ${entry.file} — ${result.contentType}: ${result.reasoning}`);
          }
          } // close manual override else
        } else {
          reviewsConfirmed.push(entry.file);
          if (VERBOSE && result.confidence !== 'high') {
            console.log(`  review (${result.confidence}): ${entry.file}`);
          }
        }
      } else {
        stats.errors++;
        if (r.status === 'rejected') {
          console.log(`  ERROR: ${r.reason?.message || r.reason}`);
        }
      }
    }

    // Progress
    const processed = Math.min(i + CONCURRENCY, filesToProcess.length);
    if (processed % 100 === 0 || processed === filesToProcess.length) {
      console.log(`  Progress: ${processed}/${filesToProcess.length} | Non-reviews: ${nonReviews.length} (high) + ${uncertainCases.length} (medium/low) | Cost: $${stats.budgetUsed.toFixed(4)}`);
    }

    // Checkpoint every 100 LLM calls
    if (stats.llmCalls % 100 === 0 && stats.llmCalls > 0) {
      saveReport(nonReviews, uncertainCases, heuristicFlags, reviewsConfirmed, calibration, showReviewCounts);
    }
  }

  // Per-show impact analysis
  console.log('\n=== PER-SHOW IMPACT ===');
  const perShowImpact = {};
  for (const nr of nonReviews) {
    if (!perShowImpact[nr.showId]) {
      perShowImpact[nr.showId] = {
        showId: nr.showId,
        showTitle: showTitleMap[nr.showId] || nr.showId,
        currentCount: showReviewCounts[nr.showId] || 0,
        removed: 0,
        removedFiles: []
      };
    }
    perShowImpact[nr.showId].removed++;
    perShowImpact[nr.showId].removedFiles.push(nr.file);
  }

  let blockedByGuard = false;
  for (const impact of Object.values(perShowImpact)) {
    impact.afterCount = impact.currentCount - impact.removed;
    const pct = impact.currentCount > 0 ? ((impact.removed / impact.currentCount) * 100).toFixed(0) : 0;
    console.log(`  ${impact.showTitle}: ${impact.currentCount} → ${impact.afterCount} reviews (-${impact.removed}, ${pct}%)`);
    for (const f of impact.removedFiles) {
      console.log(`    ${f}`);
    }
    // Skip per-show guard in incremental mode (finds 0-5 files, not bulk)
    if (!INCREMENTAL && impact.removed > 2) {
      console.log(`  ⚠ WARNING: ${impact.showTitle} would lose >2 reviews!`);
      blockedByGuard = true;
    }
  }

  if (Object.keys(perShowImpact).length === 0) {
    console.log('  No shows affected.');
  }

  // Apply mode (--apply or --incremental auto-applies)
  const shouldApply = APPLY || INCREMENTAL;
  if (shouldApply) {
    // Incremental safety cap: if >10 non-reviews found, something is wrong
    if (INCREMENTAL && nonReviews.length > 10) {
      console.log(`\n⚠ INCREMENTAL SAFETY CAP: Found ${nonReviews.length} non-reviews (>10). Skipping auto-apply. Run manually with --apply to review.`);
    } else if (blockedByGuard && !FORCE) {
      console.log('\n⚠ BLOCKED: Per-show guard triggered. Use --force to override.');
    } else {
      console.log(`\n=== APPLYING FLAGS (${nonReviews.length} high-confidence non-reviews) ===`);
      let applied = 0;
      for (const nr of nonReviews) {
        const fullPath = path.join(REVIEW_TEXTS_DIR, nr.file);
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          data.isNonReview = true;
          data.nonReviewType = nr.contentType;
          data.nonReviewClassifiedBy = PROVIDER;
          data.classifiedAt = new Date().toISOString();
          const result = safeWriteReview(fullPath, data);
          if (result.lockedSkipped) lockedSkipCount++;
          applied++;
          console.log(`  Applied: ${nr.file} → ${nr.contentType}`);
        } catch (e) {
          console.log(`  ERROR writing ${nr.file}: ${e.message}`);
        }
      }
      console.log(`Applied ${applied} flags.`);

      // Stamp classifiedAt on confirmed reviews too (so they're skipped next incremental run)
      if (INCREMENTAL && reviewsConfirmed.length > 0) {
        console.log(`\n=== STAMPING classifiedAt on ${reviewsConfirmed.length} confirmed reviews ===`);
        let stamped = 0;
        const now = new Date().toISOString();
        for (const relPath of reviewsConfirmed) {
          const fullPath = path.join(REVIEW_TEXTS_DIR, relPath);
          try {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            data.classifiedAt = now;
            const result = safeWriteReview(fullPath, data);
            if (result.lockedSkipped) lockedSkipCount++;
            stamped++;
          } catch (e) {
            if (VERBOSE) console.log(`  ERROR stamping ${relPath}: ${e.message}`);
          }
        }
        console.log(`Stamped ${stamped} confirmed reviews.`);
      }
    }
  }

  // Save final report
  saveReport(nonReviews, uncertainCases, heuristicFlags, reviewsConfirmed, calibration, showReviewCounts);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Files scanned: ${stats.totalFiles}`);
  console.log(`In reviews.json: ${stats.inReviewsJson}`);
  console.log(`LLM classified: ${stats.llmClassified}`);
  console.log(`Non-reviews found (high confidence): ${nonReviews.length}`);
  console.log(`Uncertain (medium/low): ${uncertainCases.length}`);
  console.log(`Heuristic flags (excerpt-only): ${heuristicFlags.length}`);
  console.log(`LLM calls: ${stats.llmCalls}`);
  console.log(`Cost: $${stats.budgetUsed.toFixed(4)}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Report: ${OUTPUT_FILE}`);
}

function saveReport(nonReviews, uncertainCases, heuristicFlags, reviewsConfirmed, calibration, showReviewCounts) {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const perShowSummary = {};
  for (const nr of nonReviews) {
    if (!perShowSummary[nr.showId]) {
      perShowSummary[nr.showId] = {
        showId: nr.showId,
        currentCount: showReviewCounts[nr.showId] || 0,
        removed: 0
      };
    }
    perShowSummary[nr.showId].removed++;
  }

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: INCREMENTAL ? 'incremental' : APPLY ? 'apply' : DRY_RUN ? 'dry-run' : 'report',
      provider: PROVIDER,
      stats: { ...stats },
      calibration: calibration ? {
        passed: calibration.passed,
        correct: calibration.correct,
        total: calibration.total,
        reviewAccuracy: `${calibration.reviewCorrect}/${calibration.reviewTotal}`,
        nonReviewAccuracy: `${calibration.nonReviewCorrect}/${calibration.nonReviewTotal}`
      } : null
    },
    nonReviews,
    uncertainCases,
    heuristicFlags,
    reviewsConfirmed,
    perShowSummary: Object.values(perShowSummary)
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2) + '\n');

  console.log(`[LOCKED-SKIP-COUNT] classify-non-reviews: ${lockedSkipCount}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
