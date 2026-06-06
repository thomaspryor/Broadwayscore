#!/usr/bin/env node
/**
 * Extract Explicit Ratings via LLM
 *
 * Scans review-text files that lack an originalScore and have fullText,
 * asks an LLM whether the review contains an explicit critic rating
 * (star rating, letter grade, numeric score), and if so writes it back
 * to the file so the rebuild pipeline picks it up.
 *
 * Usage:
 *   node scripts/extract-explicit-ratings.js [options]
 *
 * Options:
 *   --dry-run          Log what would change without writing files
 *   --limit=N          Process at most N reviews (default: all)
 *   --outlet=NAME      Only process reviews from this outlet ID
 *   --show=SLUG        Only process reviews from this show
 *   --concurrency=N    Parallel LLM calls (default: 8)
 *   --provider=NAME    gemini (default) | openai
 *   --verbose          Extra logging
 *
 * Env:
 *   GEMINI_API_KEY     Required for gemini provider
 *   OPENAI_API_KEY     Required for openai provider
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { normalizeLlmResult, LETTER_GRADES } = require('./lib/score-parsers');
const { setExtractedScore } = require('./lib/score-routing');
const { listShowDirs } = require('./lib/list-show-dirs');
const { GEMINI_FLASH, GPT4O_MINI } = require('./lib/models');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const OUTLET_FILTER = (args.find(a => a.startsWith('--outlet=')) || '').split('=')[1] || '';
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 8;
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'gemini';

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const CHECKPOINT_INTERVAL = 50;

// Letter grade map — imported from shared score-parsers.js (canonical, matches scoring.ts)
const LETTER_GRADE_MAP = LETTER_GRADES;

// --- Stats ---
const stats = {
  scanned: 0,
  skipped: 0,
  llmCalls: 0,
  found: 0,
  notFound: 0,
  errors: 0,
  written: 0,
  byType: {}
};

// ============================================================
// LLM Prompt
// ============================================================
const SYSTEM_PROMPT = `You are a data extraction assistant. Your job is to determine whether a theater review contains an EXPLICIT critic rating — a formal score the critic or publication assigned to the show being reviewed.

EXPLICIT ratings include:
- Star ratings using asterisks: "***½ out of four stars", "* * * out of four", "(*** 1/2 out of four stars)"
- Star ratings using symbols: ★★★☆☆, ★★★★½
- Numeric star ratings: "3.5/5 stars", "3 out of 5 stars", "4/4 stars"
- Letter grades: "Grade: B+", "Rating: A-", "EW Grade: B"
- Numeric scores: "7/10", "8 out of 10", "85/100"

COUNTING ASTERISK STARS — be precise:
- Each * character = 1 star. Count them carefully.
- ½ or 1/2 after the asterisks = add 0.5
- Examples: ** = 2, **½ = 2.5, *** = 3, ***½ = 3.5, **** = 4
- Spaced: * * * = 3, * * * ½ = 3.5, * * * * = 4
- Mixed: * * *½ = 3.5, ** ½ = 2.5

NOT explicit ratings (do NOT extract these):
- Adjective uses of "star" like "five-star knockout", "four-star dining", "a star turn" — these describe quality colloquially, not a formal rating
- HYPOTHETICAL ratings: "If I gave stars, it would get five", "I'd give it an A", "deserves 5 stars" — these are opinions about what a rating WOULD be, not an actual published rating
- Show runtimes: "2-1/2 hours", "runs 90 minutes", "a 3 hour show" — these are durations, not scores
- Aggregator scores or other critics' ratings mentioned in passing
- Audience ratings or box office numbers
- Sentiment words like "recommended" or "critics' pick" (designations, not scores)
- Percentages about capacity, grosses, or Rotten Tomatoes
- The show's own musical score/soundtrack discussion
- Star ratings belonging to OTHER reviews quoted in the text (e.g. "Read John Smith's ★★★★ review")
- Bare single letters that could be article "a" or other words — only extract letter grades with clear context like "Grade:" or "Rating:"

Return ONLY a JSON object (no markdown, no explanation):
- If found: {"found": true, "raw": "<exact text>", "value": <number>, "scale": <number>, "type": "<stars|letter|numeric>"}
  - "raw": the exact substring from the review containing the rating (include "out of four/five" part)
  - "value": the numeric value (e.g. 3.5 for ***½, 83 for B)
  - "scale": the maximum of the scale (e.g. 4, 5, 10, 100)
  - "type": the format category
- If NOT found: {"found": false}`;

function buildUserPrompt(text, outlet) {
  // Truncate very long reviews to keep costs down — ratings are almost always
  // in the first 500 or last 500 characters
  let excerpt = text;
  if (text.length > 3000) {
    excerpt = text.substring(0, 1500) + '\n\n[...middle truncated...]\n\n' + text.substring(text.length - 1500);
  }
  return `Outlet: ${outlet}\n\nReview text:\n${excerpt}`;
}

// ============================================================
// LLM Providers
// ============================================================
function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
    ],
    generationConfig: { temperature: 0.0, maxOutputTokens: 200 }
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
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Gemini parse error: ${e.message}`));
          }
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
    model: GPT4O_MINI,
    temperature: 0.0,
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
          } catch (e) {
            reject(new Error(`OpenAI parse error: ${e.message}`));
          }
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

async function callLLM(systemPrompt, userPrompt, provider) {
  const p = provider || PROVIDER;
  if (p === 'openai') return callOpenAI(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

// ============================================================
// Response parsing & validation
// ============================================================
function parseResponse(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj.found) return null;
    if (typeof obj.value !== 'number' || typeof obj.scale !== 'number') return null;
    if (obj.value < 0 || obj.value > obj.scale) return null;
    if (obj.scale <= 0) return null;
    return obj;
  } catch (e) {
    // Try to find JSON object in response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (!obj.found) return null;
        if (typeof obj.value !== 'number' || typeof obj.scale !== 'number') return null;
        return obj;
      } catch (_) {}
    }
    return null;
  }
}

/**
 * Heuristic validation: independently count asterisks in the raw text
 * to catch LLM miscounts (e.g., **½ → 1.5 instead of 2.5).
 * Returns the corrected value, or the original if no correction needed.
 */
function validateAsteriskCount(result) {
  if (!result || result.type !== 'stars') return result;
  const raw = result.raw || '';

  // Count asterisks (* characters) — handle both compact (***½) and spaced (* * * ½)
  const asterisks = (raw.match(/\*/g) || []).length;
  if (asterisks === 0) return result; // No asterisks in raw (unicode stars, etc.)

  // Check for half-star indicators
  const hasHalf = /½|1\/2/.test(raw);
  const heuristicValue = asterisks + (hasHalf ? 0.5 : 0);

  // Detect scale from raw text
  let heuristicScale = result.scale;
  if (/out of four|of four|\/4/.test(raw)) heuristicScale = 4;
  else if (/out of five|of five|\/5/.test(raw)) heuristicScale = 5;

  if (heuristicValue !== result.value) {
    if (VERBOSE) {
      console.log(`  CORRECTED: LLM said ${result.value}/${result.scale}, heuristic says ${heuristicValue}/${heuristicScale} (raw: "${raw}")`);
    }
    stats.corrected = (stats.corrected || 0) + 1;
    return { ...result, value: heuristicValue, scale: heuristicScale };
  }

  return result;
}

/**
 * Cross-verify with a second LLM when the primary result seems questionable.
 * Returns null to reject, or the validated result.
 */
async function crossVerify(result, userPrompt) {
  // Only cross-verify if we have a second provider available
  const altProvider = PROVIDER === 'gemini' && process.env.OPENAI_API_KEY ? 'openai'
    : PROVIDER === 'openai' && process.env.GEMINI_API_KEY ? 'gemini'
    : null;
  if (!altProvider) return result;

  try {
    const altResponse = await callLLM(SYSTEM_PROMPT, userPrompt, altProvider);
    stats.llmCalls++;
    const altParsed = parseResponse(altResponse);

    if (!altParsed) {
      // Second LLM says no rating — reject
      if (VERBOSE) console.log(`  CROSS-VERIFY REJECT: ${altProvider} says no rating found`);
      stats.crossVerifyReject = (stats.crossVerifyReject || 0) + 1;
      return null;
    }

    // Both agree there's a rating — validate the asterisk count on second result too
    const altValidated = validateAsteriskCount(altParsed);

    // Check if values agree (within 0.5 for rounding differences)
    const normalizedPrimary = result.value / result.scale;
    const normalizedAlt = altValidated.value / altValidated.scale;

    if (Math.abs(normalizedPrimary - normalizedAlt) > 0.15) {
      if (VERBOSE) {
        console.log(`  CROSS-VERIFY DISAGREE: primary ${result.value}/${result.scale} vs ${altProvider} ${altValidated.value}/${altValidated.scale}`);
      }
      stats.crossVerifyDisagree = (stats.crossVerifyDisagree || 0) + 1;
      return null; // Reject on disagreement
    }

    stats.crossVerifyAgree = (stats.crossVerifyAgree || 0) + 1;
    return result;
  } catch (e) {
    // If cross-verify fails, keep the primary result (validated by heuristic)
    return result;
  }
}

/**
 * Text verification gate: verify the LLM's claimed rating actually exists
 * in the source text. This catches hallucinations where the LLM invents
 * a rating that isn't there.
 * Returns null to reject, or the result to keep.
 */
function verifyInText(result, fullText) {
  if (!result || !fullText) return null;
  const ft = fullText;
  const lower = ft.toLowerCase();

  // --- Letter grades ---
  if (result.type === 'letter') {
    const gradeMatch = (result.raw || '').match(/([A-D][+\-–—]?|F)/i);
    if (!gradeMatch) return null;
    const grade = gradeMatch[1].replace(/[–—]/g, '-');

    // For ALL letter grades (single or multi-char), require they appear in a
    // "rating position" — not just anywhere in text. This prevents adjectival
    // uses like "A+ piece of comedy" from being treated as ratings.
    const escapedGrade = grade.replace('+', '\\+').replace('-', '\\-');
    const dashVariants = grade.endsWith('-')
      ? [escapedGrade, escapedGrade.slice(0, -2) + '[–—]']
      : [escapedGrade];

    // Position 1: First 100 chars (Gotham Playgoer style — review starts with grade)
    const first100 = ft.slice(0, 100);
    for (const v of dashVariants) {
      if (new RegExp('(^|\\s)' + v + '(\\s|$)', 'm').test(first100)) return result;
    }

    // Position 2: Last 500 chars (EW style — grade near end before boilerplate)
    const last500 = ft.slice(-500);
    for (const v of dashVariants) {
      // Grade preceded by sentence-ending punctuation (". B+" or "! A-")
      if (new RegExp('[.!?\\n]\\s*' + v + '(\\s|$|\\(|[A-Z])').test(last500)) return result;
      // Grade immediately before "(Tickets" or "For tickets" (EW concatenated pattern)
      if (new RegExp(v + '\\s*[\\(F]').test(last500)) return result;
      // Grade at end of line
      if (new RegExp(v + '\\s*$', 'm').test(last500)) return result;
    }

    // Position 3: "Grade: X" or "Rating: X" anywhere in text
    for (const v of dashVariants) {
      if (new RegExp('(grade|rating)\\s*:\\s*' + v, 'i').test(ft)) return result;
    }

    if (VERBOSE) console.log(`  TEXT-VERIFY REJECT: letter grade "${grade}" not verifiable in rating position`);
    stats.textVerifyReject = (stats.textVerifyReject || 0) + 1;
    return null;
  }

  // --- Star ratings ---
  if (result.type === 'stars') {
    // Must have asterisks, unicode stars, or "out of N" pattern
    if (ft.includes('*') || ft.includes('★') || ft.includes('⭐') || ft.includes('☆')) return result;
    if (lower.includes('out of four') || lower.includes('out of five') || lower.includes('out of 4') || lower.includes('out of 5')) return result;
    if (lower.includes('%bd') || lower.includes('%2a')) return result; // URL-encoded ½ or *
    if (lower.includes('two and a half') || lower.includes('three and a half') || lower.includes('one and a half') || lower.includes('two and one-half') || lower.includes('three and one-half')) return result;
    // X/Y stars pattern
    const slashMatch = (result.raw || '').match(/([\d.½]+)\s*\/\s*(\d+)/);
    if (slashMatch && (lower.includes(slashMatch[1] + '/' + slashMatch[2]) || lower.includes(slashMatch[1] + ' / ' + slashMatch[2]))) return result;

    if (VERBOSE) console.log(`  TEXT-VERIFY REJECT: star rating "${result.raw}" — no star/asterisk evidence in text`);
    stats.textVerifyReject = (stats.textVerifyReject || 0) + 1;
    return null;
  }

  // --- Numeric ratings ---
  if (result.type === 'numeric') {
    const slashMatch = (result.raw || '').match(/([\d.]+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      // Check for X/Y or X out of Y in text
      if (lower.includes(slashMatch[1] + '/' + slashMatch[2])) return result;
      if (lower.includes(slashMatch[1] + ' / ' + slashMatch[2])) return result;
      if (lower.includes(slashMatch[1] + ' out of ' + slashMatch[2])) return result;
    }
    // Check for "rating:" or "score:" with the number nearby
    if (lower.includes('rating:') || lower.includes('score:') || lower.includes('grade:')) {
      const num = String(result.value);
      if (lower.includes(num)) return result;
    }

    if (VERBOSE) console.log(`  TEXT-VERIFY REJECT: numeric rating "${result.raw}" — pattern not found in text`);
    stats.textVerifyReject = (stats.textVerifyReject || 0) + 1;
    return null;
  }

  return result;
}

/**
 * Post-extraction sanity checks to catch LLM false positives.
 * Returns null to reject, or the result to keep.
 */
function postValidate(result) {
  if (!result) return null;
  const raw = (result.raw || '').toLowerCase();

  // Reject hypothetical ratings
  if (/\b(if i gave|i would give|i'd give|would get|deserves?|should get|worthy of)\b/.test(raw)) {
    if (VERBOSE) console.log(`  POST-VALIDATE REJECT (hypothetical): "${result.raw}"`);
    return null;
  }

  // Reject runtimes misidentified as scores
  if (/\b(hour|minute|min|hrs?|mins?)\b/.test(raw)) {
    if (VERBOSE) console.log(`  POST-VALIDATE REJECT (runtime): "${result.raw}"`);
    return null;
  }

  // Reject audience/aggregator scores, not critic ratings
  if (/\b(user rating|audience|show score|rotten tomatoes|metacritic)\b/.test(raw)) {
    if (VERBOSE) console.log(`  POST-VALIDATE REJECT (audience/aggregator): "${result.raw}"`);
    return null;
  }

  // Reject "gold star" (figure of speech) and "X-star meal/restaurant/etc" (metaphor)
  if (/\bgold star\b/.test(raw) || /\b\w+-star\s+(meal|restaurant|dining|hotel|resort|service|treatment|performance)\b/.test(raw)) {
    if (VERBOSE) console.log(`  POST-VALIDATE REJECT (metaphor): "${result.raw}"`);
    return null;
  }

  // Reject "X-star review" / "X stars" / "five-star review" patterns — adjectival and scale-ambiguous
  // These use "star" as an adjective ("a four-star review") rather than a formal rating notation
  // The scale is unknowable: "four-star" could mean 4/4 (100) or 4/5 (80) — a 20-point difference
  if (/\b(one|two|three|four|five|six|seven)-star\b/.test(raw) || /\b(one|two|three|four|five) stars?\b/.test(raw)) {
    // Exception: allow if preceded by asterisks or unicode stars (actual rating notation)
    if (!/[*★☆]/.test(raw) && !/out of/.test(raw) && !/\/[45]/.test(raw)) {
      if (VERBOSE) console.log(`  POST-VALIDATE REJECT (adjectival star): "${result.raw}"`);
      return null;
    }
  }

  // Reject bare asterisk ratings without explicit scale (e.g., "****" without "out of four/five")
  // The scale is ambiguous: **** could be 4/4 (100%) or 4/5 (80%) — a 20-point difference
  if (result.type === 'stars' && /\*/.test(raw) && !/out of|\/[45]|\bof (four|five|4|5)\b/.test(raw)) {
    if (VERBOSE) console.log(`  POST-VALIDATE REJECT (ambiguous scale): "${result.raw}"`);
    return null;
  }

  // Reject bare single-letter grades without context keywords
  if (result.type === 'letter') {
    const gradeMatch = raw.match(/([a-d][+\-]?|f)/i);
    if (gradeMatch) {
      const grade = gradeMatch[0];
      // Must have context: "grade", "rating", or be at end of text (EW style)
      // A bare "B" in the middle of text is too likely to be a false positive
      if (grade.length === 1 && !/\b(grade|rating)\b/.test(raw)) {
        // Check if it appears at the very end of the review (EW pattern: "...some text. B+")
        // This is OK — it's a standalone grade at the end
        // But if raw is just "B" or "A" with no context, still risky
        // Allow it only if the raw text is very short (just the grade)
        if (raw.trim().length > 5) {
          if (VERBOSE) console.log(`  POST-VALIDATE REJECT (bare letter): "${result.raw}"`);
          return null;
        }
      }
    }
  }

  return result;
}

// normalizeScore — removed, was dead code. Normalization now handled by
// normalizeLlmResult in scripts/lib/score-parsers.js (used by llm-score-extractor.js).

// ============================================================
// File scanning
// ============================================================
function scanReviewFiles() {
  const files = [];
  const shows = listShowDirs(REVIEW_TEXTS_DIR);

  for (const show of shows) {
    if (SHOW_FILTER && show !== SHOW_FILTER) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    if (!fs.statSync(showDir).isDirectory()) continue;

    for (const file of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
      if (OUTLET_FILTER && !file.startsWith(OUTLET_FILTER)) continue;

      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has originalScore
        if (data.originalScore) { stats.skipped++; continue; }

        // Skip if no meaningful fullText
        if (!data.fullText || data.fullText.length < 200) { stats.skipped++; continue; }

        files.push({ filePath, data });
      } catch (e) {
        stats.errors++;
      }
    }
  }

  return files;
}

// ============================================================
// Main
// ============================================================
async function callLLMWithRetry(systemPrompt, userPrompt, provider) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await callLLM(systemPrompt, userPrompt, provider);
      stats.llmCalls++;
      return response;
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        const wait = (attempt + 1) * 5000;
        if (VERBOSE) console.log(`  Rate limited (${provider || PROVIDER}), waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  return null;
}

async function processReview(entry) {
  const { filePath, data } = entry;
  stats.scanned++;

  const currentScore = data.assignedScore || data.llmScore?.score;

  let result;
  try {
    result = await extractExplicitScore({
      text: data.fullText,
      outletId: data.outletId || data.outlet || '',
      provider: PROVIDER,
      currentScore,
      verbose: VERBOSE
    });
    stats.llmCalls++;
  } catch (e) {
    stats.errors++;
    if (VERBOSE) console.log(`  Error for ${path.basename(filePath)}: ${e.message}`);
    return;
  }

  if (!result) {
    stats.notFound++;
    return;
  }

  stats.found++;

  const showId = data.showId || path.basename(path.dirname(filePath));
  const reviewer = data.outlet || data.outletId || '';
  const currentScoreStr = currentScore || '?';
  const delta = currentScore ? ` (Δ${result.normalizedScore - currentScore > 0 ? '+' : ''}${result.normalizedScore - currentScore})` : '';

  console.log(`  FOUND: [${showId}] ${reviewer} → ${result.originalScore} (=${result.normalizedScore}) [was: ${currentScoreStr}]${delta} raw: "${result.raw}"`);

  if (!DRY_RUN) {
    // Routes to originalScore unless EITHER the incoming source OR the file's
    // existing scoreSource is an aggregator. See lib/score-routing.js.
    setExtractedScore(data, {
      value: result.originalScore,
      normalizedValue: result.normalizedScore,
      source: result.source,
    });
    data.originalRating = result.originalScore;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    stats.written++;
  }
}

async function main() {
  console.log(`\n=== Extract Explicit Ratings via LLM ===`);
  console.log(`Provider: ${PROVIDER} | Concurrency: ${CONCURRENCY} | Dry run: ${DRY_RUN}`);
  if (OUTLET_FILTER) console.log(`Outlet filter: ${OUTLET_FILTER}`);
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);
  console.log('');

  // Load env if running locally
  try {
    const envPath = path.join(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^([A-Z_]+)=(.+)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].trim();
        }
      }
    }
  } catch (e) {}

  console.log('Scanning review files...');
  let files = scanReviewFiles();
  console.log(`Found ${files.length} reviews to check (skipped ${stats.skipped} with score or no text)\n`);

  if (LIMIT && files.length > LIMIT) {
    files = files.slice(0, LIMIT);
    console.log(`Limited to ${LIMIT} reviews\n`);
  }

  // Process in batches with concurrency
  const startTime = Date.now();
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(f => processReview(f)));

    // Progress logging
    const processed = Math.min(i + CONCURRENCY, files.length);
    if (processed % CHECKPOINT_INTERVAL === 0 || processed === files.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(`\n  Progress: ${processed}/${files.length} (${elapsed}s, ${rate}/s) — found: ${stats.found}, errors: ${stats.errors}`);
    }

    // Small delay between batches to avoid rate limits
    if (i + CONCURRENCY < files.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`LLM calls: ${stats.llmCalls}`);
  console.log(`Ratings found: ${stats.found}`);
  console.log(`No rating: ${stats.notFound}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Written: ${stats.written}`);
  console.log(`By type: ${JSON.stringify(stats.byType)}`);
  if (stats.corrected) console.log(`Asterisk corrections: ${stats.corrected}`);
  if (stats.textVerifyReject) console.log(`Text-verify rejections: ${stats.textVerifyReject}`);
  if (stats.postValidateReject) console.log(`Post-validate rejections: ${stats.postValidateReject}`);
  if (stats.crossVerifyAgree) console.log(`Cross-verify agree: ${stats.crossVerifyAgree}`);
  if (stats.crossVerifyReject) console.log(`Cross-verify reject: ${stats.crossVerifyReject}`);
  if (stats.crossVerifyDisagree) console.log(`Cross-verify disagree: ${stats.crossVerifyDisagree}`);
  console.log(`Time: ${elapsed}s`);

  if (DRY_RUN) {
    console.log('\n(DRY RUN — no files were modified)');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
