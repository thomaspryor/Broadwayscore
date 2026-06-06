#!/usr/bin/env node
/**
 * Extract Pull Quotes via LLM
 *
 * Scans review-text files with fullText, asks an LLM to extract the single
 * most quotable sentence, and writes it back as `llmPullQuote` on the source
 * file so the rebuild pipeline picks it up as priority #0 in selectBestExcerpt().
 *
 * Usage:
 *   node scripts/extract-pull-quotes.js [options]
 *
 * Options:
 *   --dry-run          Log what would change without writing files
 *   --limit=N          Process at most N reviews (default: all)
 *   --show=SLUG        Only process reviews from this show
 *   --overwrite        Re-extract even if llmPullQuote already exists
 *   --concurrency=N    Parallel LLM calls (default: 10)
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
const { shouldRejectAsReservation } = require('./lib/pull-quote-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { listShowDirs } = require('./lib/list-show-dirs');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const OVERWRITE = args.includes('--overwrite');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 10;
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'gemini';

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const CHECKPOINT_INTERVAL = 50;

// --- Stats ---
const stats = {
  scanned: 0,
  skipped: 0,
  llmCalls: 0,
  extracted: 0,
  verified: 0,
  notFound: 0,
  errors: 0,
  written: 0,
  tooShort: 0,
  tooLong: 0,
  notInText: 0,
  upgraded: 0,
  reservationRejected: 0,
  reservationRetried: 0
};

// ============================================================
// LLM Prompt
// ============================================================
const SYSTEM_PROMPT = `You are a pull quote editor for a Broadway review aggregation website. Given a critic's full review AND that review's overall verdict direction, extract the single most quotable sentence that best captures the critic's verdict on the show.

RULES:
1. Return ONLY the exact sentence from the review — no paraphrasing, no additions, no attribution
2. The sentence must be a COMPLETE grammatical sentence (subject + verb), not a fragment
3. Ideal length: 50-180 characters. Absolute minimum 40, absolute maximum 250
4. The sentence must express the critic's OPINION or JUDGMENT about the show — not plot summary, historical context, cast bios, or production credits
5. Prefer sentences from the MIDDLE or END of the review where critics typically deliver their verdict, not opening scene-setting paragraphs
6. The sentence must make sense WITHOUT the surrounding context — a reader should understand the critic's view from this one sentence alone
7. Choose the most VIVID, memorable phrasing — strong verbs, clear judgment, specific language
8. VERDICT ALIGNMENT — this is the most important rule: the pull quote's tone MUST match the review's overall verdict direction, which is given in the user prompt.
   - POSITIVE review (score ≥ 70): pick a sentence that is clearly an endorsement. NEVER pick a sentence that opens with "But", "Yet", "Still", "Though", "Although", "However", "Despite", or "While" — those almost always introduce a reservation that contradicts a positive verdict. NYT critics especially like to bury a mid-review caveat in a positive review; do not pick it.
   - MIXED review (40-69): prefer the sentence that best captures the critic's hedged position — pick something that conveys both the merit and the limitation if the review actually hedges.
   - NEGATIVE review (< 40): pick the most representative negative verdict. Don't cherry-pick a rare positive aside.
9. If the verdict direction is POSITIVE, the pull quote must feel like a THUMBS-UP when read in isolation. If it starts with a word that introduces a caveat, you have picked the wrong sentence — pick a different one.

AVOID:
- Opening sentences that set the scene ("When the curtain rises on...")
- Sentences about other shows, comparisons to film versions, or historical context
- Sentences that are mostly about a single actor unless the whole review focuses on that performance
- Generic praise/criticism that could apply to any show ("It's worth seeing", "Don't miss it")
- Sentences with parenthetical asides, em-dashes creating subclauses, or other structures that make them hard to read out of context
- MOST IMPORTANTLY: on a POSITIVE review, any sentence that starts with But / Yet / Still / Though / Although / However / Despite / While — these are reservation markers and will misrepresent the critic's verdict.

Return ONLY the extracted sentence. Nothing else — no quotes, no attribution, no explanation.
If the review has no suitable quotable sentence (e.g., it's all plot summary or too fragmented), return exactly: NONE`;

function describeVerdict(score) {
  if (score == null || typeof score !== 'number' || Number.isNaN(score)) {
    return 'UNKNOWN (pick the strongest-voiced sentence that captures the critic\'s judgment)';
  }
  if (score >= 85) return `POSITIVE / RAVE (score ${score}/100) — the critic loved it`;
  if (score >= 70) return `POSITIVE (score ${score}/100) — the critic recommends it`;
  if (score >= 40) return `MIXED (score ${score}/100) — the critic has reservations`;
  return `NEGATIVE (score ${score}/100) — the critic does not recommend it`;
}

function buildUserPrompt(text, score, hint) {
  // Truncate very long reviews — the verdict is almost always in the first
  // or last third, not deep in a plot synopsis in the middle
  let excerpt = text;
  if (text.length > 4000) {
    excerpt = text.substring(0, 2000) + '\n\n[...middle truncated...]\n\n' + text.substring(text.length - 2000);
  }
  const verdictLine = `Overall verdict direction: ${describeVerdict(score)}`;
  const hintLine = hint ? `\nNOTE: ${hint}\n` : '';
  return `${verdictLine}\n${hintLine}\nReview text:\n${excerpt}`;
}

// ============================================================
// LLM Providers
// ============================================================
function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\n' + userPrompt }] }
    ],
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
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text.trim());
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
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 300,
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
            resolve((json.choices?.[0]?.message?.content || '').trim());
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

async function callLLMWithRetry(systemPrompt, userPrompt, provider) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await callLLM(systemPrompt, userPrompt, provider);
      stats.llmCalls++;
      return response;
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        const wait = (attempt + 1) * 5000;
        if (VERBOSE) console.log(`  Rate limited, waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ============================================================
// Validation
// ============================================================

/**
 * Verify the extracted quote is an exact substring of the full text.
 * Uses fuzzy matching to handle minor whitespace/punctuation differences.
 */
function verifyInText(quote, fullText) {
  if (!quote || !fullText) return false;

  // Direct substring match
  if (fullText.includes(quote)) return true;

  // Normalize whitespace and try again
  const normQuote = quote.replace(/\s+/g, ' ').trim();
  const normText = fullText.replace(/\s+/g, ' ').trim();
  if (normText.includes(normQuote)) return true;

  // Handle curly/straight quote mismatches
  const straightQuote = normQuote
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/\u2013/g, '-');
  const straightText = normText
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/\u2013/g, '-');
  if (straightText.includes(straightQuote)) return true;

  // Case-insensitive as last resort
  if (straightText.toLowerCase().includes(straightQuote.toLowerCase())) return true;

  return false;
}

/**
 * Clean up LLM response — strip wrapping quotes, attribution, etc.
 */
function cleanResponse(response) {
  if (!response) return null;
  let cleaned = response.trim();

  // Reject NONE / refusal
  if (cleaned === 'NONE' || cleaned.startsWith('I cannot') || cleaned.startsWith('I apologize')) {
    return null;
  }

  // Strip wrapping quotes (straight or curly)
  if ((cleaned.startsWith('"') || cleaned.startsWith('\u201c')) &&
      (cleaned.endsWith('"') || cleaned.endsWith('\u201d'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Strip leading "Quote: " or similar prefixes
  cleaned = cleaned.replace(/^(Quote|Excerpt|Pull quote|Sentence):\s*/i, '');

  // Strip trailing attribution like "— Critic Name" or "- Outlet"
  cleaned = cleaned.replace(/\s*[\u2014\u2013\-]\s*[A-Z][a-z].*$/, '');

  return cleaned || null;
}

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

    for (const file of fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if no meaningful fullText
        if (!data.fullText || data.fullText.length < 300) { stats.skipped++; continue; }

        // Skip if already has llmPullQuote (unless --overwrite)
        if (data.llmPullQuote && !OVERWRITE) { stats.skipped++; continue; }

        // Skip garbage / wrong show / roundup articles
        if (data.wrongProduction || data.wrongShow || data.wrongAttribution || data.duplicateOf ||
            data.isRoundupArticle || data.rejectionReason || data.contentTier === 'invalid') { stats.skipped++; continue; }

        // Skip truncated/incomplete reviews — best quote is likely behind the paywall
        if (data.textStatus === 'truncated' || ['truncated', 'stub', 'excerpt'].includes(data.contentTier)) {
          stats.skipped++;
          continue;
        }

        files.push({ filePath, data });
      } catch (e) {
        stats.errors++;
      }
    }
  }

  return files;
}

// ============================================================
// Main processing
// ============================================================
async function processReview(entry) {
  const { filePath, data } = entry;
  stats.scanned++;

  // Pass assignedScore to the LLM so it can align the pull quote with the
  // review's overall verdict direction. See NYT hedge-opener bug — middle-
  // paragraph reservations were getting picked for positive reviews.
  const score = typeof data.assignedScore === 'number' ? data.assignedScore : null;
  const hadPrevious = !!data.llmPullQuote;

  // Try up to 2 times: if the first response is a hedge-opener on a
  // positive review, retry with a stronger hint.
  let quote = null;
  let responseText = null;
  let attempt = 0;
  let hint = null;

  while (attempt < 2) {
    attempt++;
    const userPrompt = buildUserPrompt(data.fullText, score, hint);

    try {
      responseText = await callLLMWithRetry(SYSTEM_PROMPT, userPrompt);
    } catch (e) {
      stats.errors++;
      if (VERBOSE) console.log(`  Error for ${path.basename(filePath)}: ${e.message}`);
      return;
    }

    if (!responseText) { stats.errors++; return; }

    quote = cleanResponse(responseText);
    if (!quote) {
      stats.notFound++;
      if (VERBOSE) console.log(`  No quote: ${path.basename(filePath)} — response: "${(responseText || '').slice(0, 80)}"`);
      return;
    }

    stats.extracted++;

    // Reservation check: if the review is positive and the quote opens
    // with a hedge word, reject and retry once with a stronger hint.
    if (shouldRejectAsReservation(quote, score)) {
      if (attempt === 1) {
        stats.reservationRetried++;
        if (VERBOSE) {
          console.log(`  HEDGE on score=${score}: "${quote.slice(0, 80)}..." — retrying`);
        }
        hint = `Your previous attempt opened with a hedge word ("${quote.split(/\s+/)[0]}") and read as a reservation, but this is a POSITIVE review. Pick a DIFFERENT sentence that clearly endorses the show. Do not start with But/Yet/Still/Though/Although/However/Despite/While.`;
        continue;
      }
      // Second attempt still a hedge — give up and don't overwrite.
      stats.reservationRejected++;
      if (VERBOSE) {
        console.log(`  HEDGE (rejected after retry): "${quote.slice(0, 80)}..." — ${path.basename(filePath)}`);
      }
      return;
    }

    // Accepted.
    break;
  }

  // Validate length
  if (quote.length < 30) {
    stats.tooShort++;
    if (VERBOSE) console.log(`  Too short (${quote.length}): "${quote}"`);
    return;
  }
  if (quote.length > 300) {
    stats.tooLong++;
    if (VERBOSE) console.log(`  Too long (${quote.length}): "${quote.slice(0, 80)}..."`);
    return;
  }

  // Verify the quote actually appears in the review text
  if (!verifyInText(quote, data.fullText)) {
    stats.notInText++;
    if (VERBOSE) console.log(`  NOT IN TEXT: "${quote.slice(0, 80)}..." — ${path.basename(filePath)}`);
    return;
  }

  stats.verified++;
  if (hadPrevious) stats.upgraded++;

  const showId = data.showId || path.basename(path.dirname(filePath));
  const reviewer = data.outlet || data.outletId || '';
  const tag = hadPrevious ? 'UPGRADED' : 'NEW';

  if (VERBOSE || stats.verified <= 10) {
    console.log(`  ${tag}: [${showId}] ${reviewer} → "${quote.length > 100 ? quote.slice(0, 97) + '...' : quote}"`);
  }

  if (!DRY_RUN) {
    data.llmPullQuote = quote;
    safeWriteReview(filePath, data);
    stats.written++;
  }
}

async function main() {
  console.log(`\n=== Extract Pull Quotes via LLM ===`);
  console.log(`Provider: ${PROVIDER} | Concurrency: ${CONCURRENCY} | Dry run: ${DRY_RUN} | Overwrite: ${OVERWRITE}`);
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
  console.log(`Found ${files.length} reviews to process (skipped ${stats.skipped})\n`);

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
      console.log(`\n  Progress: ${processed}/${files.length} (${elapsed}s, ${rate}/s) — verified: ${stats.verified}, notInText: ${stats.notInText}, errors: ${stats.errors}`);
    }

    // Small delay between batches to avoid rate limits
    if (i + CONCURRENCY < files.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`LLM calls: ${stats.llmCalls}`);
  console.log(`Extracted: ${stats.extracted}`);
  console.log(`Verified (in text): ${stats.verified}`);
  console.log(`Not in text (rejected): ${stats.notInText}`);
  console.log(`Too short: ${stats.tooShort}`);
  console.log(`Too long: ${stats.tooLong}`);
  console.log(`No quote found: ${stats.notFound}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Written: ${stats.written}`);
  if (stats.upgraded) console.log(`Upgraded (replaced existing): ${stats.upgraded}`);
  if (stats.reservationRetried) console.log(`Hedge-opener retries: ${stats.reservationRetried}`);
  if (stats.reservationRejected) console.log(`Hedge-opener rejects (after retry): ${stats.reservationRejected}`);
  console.log(`Time: ${elapsed}s`);

  if (DRY_RUN) {
    console.log('\n(DRY RUN — no files were modified)');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
