/**
 * LLM-Based Content Verification
 *
 * Primary content gate for scraped review texts. Runs by default on all
 * reviews with 200+ chars. Detects:
 *   1. Wrong article (different topic, different show entirely)
 *   2. Wrong production (tour, regional, off-Broadway, West End — not Broadway)
 *   3. Film/TV content (movie adaptation, streaming, TV special)
 *   4. Truncation (paywall, incomplete content)
 *   5. Navigation/junk (scraped footer instead of article)
 *
 * Provider chain: Gemini Flash (cheapest) → GPT-4o-mini → Claude Sonnet → heuristic fallback
 * Falls back to heuristic checks when no API keys are available.
 */

const https = require('https');
const crypto = require('crypto');
const { isLondonMarket } = require('./venue-classification');
const { applyTemporalOverrides } = require('./review-guards');
const { buildVenueContext: _expandVenueContext } = require('./venue-aliases');
const { getCvStyle } = require('./outlet-canonicalize');
const { hasOpinionLanguage } = require('./content-quality');

/**
 * Extract a sensible publication year from a URL path.
 *
 * Matches `/YYYY/` segments (the Variety/NYT/Guardian convention) and the
 * YYYYMMDD-suffix pattern used by BWW article slugs. Returns null when no
 * signal is found or the extracted year is out of a sensible [1990, currentYear+1]
 * window. Per CLAUDE.md rule 3 the result is NOT authoritative for positive
 * matching — callers should surface it as context, not act on it.
 *
 * Private to content-verifier — if other modules need URL-year extraction
 * they should extract this to scripts/lib/url-year.js first.
 */
function _extractUrlYear(url) {
  if (!url || typeof url !== 'string') return null;
  // Try /YYYY/ path segment first (Variety, NYT, Guardian, etc.)
  const pathMatch = url.match(/\/((?:19|20)\d{2})\//);
  if (pathMatch) {
    const y = parseInt(pathMatch[1], 10);
    if (y >= 1990 && y <= new Date().getFullYear() + 1) return y;
  }
  // Fallback: YYYYMMDD suffix (BWW article IDs)
  const suffixMatch = url.match(/-((?:19|20)\d{2})(\d{2})(\d{2})\d{0,2}(?:[/?#]|$)/);
  if (suffixMatch) {
    const y = parseInt(suffixMatch[1], 10);
    if (y >= 1990 && y <= new Date().getFullYear() + 1) return y;
  }
  return null;
}

/**
 * Hash the first 2500 chars of text — used to detect when contentVerification
 * was done on different content than the stored fullText.
 */
function contentHash(text) {
  if (!text) return null;
  return crypto.createHash('md5').update(text.substring(0, 2500)).digest('hex');
}

// ============================================================
// LLM Provider Implementations (cheapest → most expensive)
// ============================================================

/**
 * Call Gemini Flash — ~$0.0001/review (practically free)
 */
function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // gemini-2.0-flash was retired by Google (HTTP 404 "no longer available")
  // ~2026-06; 2.5-flash is the current equivalent (already used by the
  // llm-scoring ensemble). NOTE: ~30 other scripts still hardcode the dead
  // 2.0-flash — tracked as a separate class-fix card.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // thinkingBudget:0 — gemini-2.5-flash is a thinking model; without this it
      // spends the whole maxOutputTokens budget on internal thinking and returns
      // empty/truncated text (memory: feedback_gemini_thinking_token_budget).
      generationConfig: { temperature: 0.1, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } }
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
    req.write(body);
    req.end();
  });
}

/**
 * Call OpenAI GPT-4o-mini — ~$0.0003/review
 */
function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.1
    });

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

/**
 * Call Claude Sonnet — ~$0.003/review (most expensive, last resort)
 */
function callAnthropic(model) {
  return function (prompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = https.request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json.content?.[0]?.text || '');
            } catch (e) {
              reject(new Error(`Anthropic parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

const callClaudeHaiku = callAnthropic('claude-haiku-4-5-20251001');
const callClaudeSonnet = callAnthropic('claude-sonnet-4-6');

// ============================================================
// Provider Chain
// ============================================================

/**
 * Provider chain — accuracy-ordered (was cheapest-first until 2026-04-15).
 *
 * Switched primary from Gemini 2.0 Flash to Claude Haiku 4.5 after a 7-model
 * sweep against a 30-case golden fixture (scripts/evals/content-verifier-
 * model-sweep.js). Numbers:
 *   Gemini Flash:  precision 52%, recall 93%, FP rate 87%, $6/yr
 *   Claude Haiku:  precision 74%, recall 93%, FP rate 33%, $120/yr
 * +20pp precision and -54pp FP rate for ~$114/yr extra. The previous chain
 * shipped 33% wrong-production garbage downstream into scoring.
 *
 * Fallback order keeps cheaper models available if Haiku quota runs out.
 */
function getProviderChain() {
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({ name: 'claude-haiku', call: callClaudeHaiku });
  }
  if (process.env.GEMINI_API_KEY) providers.push({ name: 'gemini', call: callGemini });
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'openai', call: callOpenAI });
  if (process.env.ANTHROPIC_API_KEY) {
    // Keep Sonnet as final fallback — same vendor but stronger model.
    providers.push({ name: 'claude-sonnet', call: callClaudeSonnet });
  }
  return providers;
}

/**
 * Call LLM with automatic fallback through provider chain
 * @returns {{ text: string, provider: string }}
 */
async function callWithFallback(prompt) {
  const chain = getProviderChain();
  if (chain.length === 0) return null;

  for (let i = 0; i < chain.length; i++) {
    const { name, call } = chain[i];
    try {
      const text = await call(prompt);
      return { text, provider: name };
    } catch (e) {
      console.log(`    ${name} verify error: ${e.message}`);
      if (i < chain.length - 1) {
        console.log(`    Falling back to ${chain[i + 1].name}...`);
      }
    }
  }

  return null; // All providers failed
}

// ============================================================
// Main Verification
// ============================================================

/**
 * Verify scraped content matches expected review for the correct market
 *
 * @param {Object} params
 * @param {string} params.scrapedText - The scraped full text
 * @param {string} params.excerpt - Known excerpt from aggregator
 * @param {string} params.showTitle - Show title for context
 * @param {string} params.outletName - Outlet name
 * @param {string} params.criticName - Critic name
 * @param {string} [params.openingDate] - Opening date (YYYY-MM-DD) for temporal context
 * @param {string} [params.publishDate] - Review publish date (YYYY-MM-DD) — used with openingDate to prevent false wrongProduction flags
 * @param {string} [params.venue] - Venue name
 * @param {string} [params.market] - Market: 'broadway' (default), 'west-end', 'off-west-end', 'off-broadway'
 * @param {boolean} [params.isLongRunningProduction] - True when the production has run
 *   continuously for many years (Mousetrap 1952, Phantom WE 1986, Les Mis WE 1985, Mamma Mia 1999).
 *   When set, the LLM is told NOT to flag wrongProduction based on publishDate-vs-openingDate
 *   age gap alone. See WE long-runner CV hardening card 34c637c5-416f-812b issue #3.
 * @param {string} [params.url] - Review URL. Used to surface URL-year-vs-publishDate conflicts
 *   to the LLM (issue #4). Per CLAUDE.md rule 3 the URL year is not authoritative but it's a
 *   useful signal when publishDate disagrees by multiple years.
 * @returns {Object} { isValid, confidence, issues, truncated, wrongArticle, wrongProduction, isFilmTv, reasoning, verifiedBy }
 */
async function verifyContent({ scrapedText, excerpt, showTitle, outletName, criticName, openingDate, venue, market, publishDate, isLongRunningProduction, url, show }) {
  if (!scrapedText || scrapedText.length < 200) {
    return {
      isValid: false,
      confidence: 'high',
      issues: ['Content too short (<200 chars)'],
      truncated: true,
      wrongArticle: false,
      wrongProduction: false,
      isFilmTv: false,
      verifiedBy: 'skip-short'
    };
  }

  // Market-aware prompt construction
  const effectiveMarket = market || 'broadway';
  const marketConfig = {
    'broadway': {
      label: 'Broadway',
      description: 'shows performed in Broadway theaters in New York City',
      dateLabel: 'Broadway opening date',
      venueLabel: 'Broadway venue',
      wrongProdExamples: [
        'National tour, touring production, touring company, "on tour"',
        'Regional theater (Ahmanson, Kennedy Center, Old Globe, Goodman, etc.)',
        'Off-Broadway or Off-Off-Broadway venue',
        'West End / London production',
        'Pre-Broadway tryout or out-of-town engagement'
      ]
    },
    'west-end': {
      label: 'West End',
      description: 'shows performed in West End theaters in London',
      dateLabel: 'West End opening date',
      venueLabel: 'West End venue',
      wrongProdExamples: [
        'UK touring production, "on tour"',
        'Regional UK theater (not a West End venue)',
        'Broadway / New York production',
        'Edinburgh Fringe or other festival',
        'Pre-West End tryout or transfer preview'
      ]
    },
    'off-west-end': {
      label: 'Off-West End',
      description: 'shows performed in Off-West End theaters in London',
      dateLabel: 'Off-West End opening date',
      venueLabel: 'Off-West End venue',
      wrongProdExamples: [
        'UK touring production, "on tour"',
        'Regional UK theater (not a London venue)',
        'Broadway / New York production',
        'Edinburgh Fringe or other festival',
        'Pre-West End tryout or transfer preview'
      ]
    },
    'off-broadway': {
      label: 'Off-Broadway',
      description: 'shows performed in Off-Broadway theaters in New York City',
      dateLabel: 'Off-Broadway opening date',
      venueLabel: 'Off-Broadway venue',
      wrongProdExamples: [
        'Broadway production (different from Off-Broadway run)',
        'National tour, touring production',
        'Regional theater production',
        'West End / London production'
      ]
    },
    // 'opera' is set by callers when show.type === 'opera' (e.g. Met Opera at
    // Lincoln Center). Met productions are tagged category=off-broadway in our
    // data model but the off-broadway prompt flags Met-venue mentions as wrong.
    // Met IS the canonical venue for these shows; flag wrong PRODUCTION (different
    // season, different cast, prior revival) but NOT wrong VENUE.
    'opera': {
      label: 'Met Opera',
      description: 'opera productions performed at the Metropolitan Opera House in New York City',
      dateLabel: 'Met Opera opening date',
      venueLabel: 'Met Opera venue',
      wrongProdExamples: [
        'Different opera house (Royal Opera House, Paris Opera, Sydney Opera, Bolshoi, Glyndebourne, etc.)',
        'Prior season or prior Met revival of the same opera (different cast/conductor/year)',
        'Touring production / Met "Live in HD" cinema broadcast (not the staged production)',
        'Festival performance (Salzburg, Bayreuth, etc.)'
      ]
    }
  };
  const mc = marketConfig[effectiveMarket] || marketConfig['broadway'];

  const dateContext = openingDate ? `\n- ${mc.dateLabel}: ${openingDate}` : '';
  const publishDateContext = publishDate ? `\n- Review publish date: ${publishDate}` : '';
  // Venue context expands known renames ("His Majesty's" → "formerly Her Majesty's...")
  // so the LLM doesn't flag legitimate pre-rename reviews as wrongProduction.
  // See memory WE long-runner CV hardening card 34c637c5-416f-812b.
  const venueContext = venue ? `\n- ${mc.venueLabel}: ${_expandVenueContext(venue)}` : '';
  const excerptContext = excerpt ? `\n- Known excerpt: "${excerpt.substring(0, 300)}"` : '';

  // Temporal proximity: if review published within 30 days of opening, very likely correct production
  let temporalHint = '';
  if (openingDate && publishDate) {
    const daysDiff = Math.abs((new Date(publishDate) - new Date(openingDate)) / 86400000);
    if (daysDiff <= 30) {
      temporalHint = `\n\n**IMPORTANT**: This review was published ${daysDiff <= 1 ? 'on opening night' : `within ${Math.round(daysDiff)} days of the ${mc.label} opening`}. Reviews published near opening night are almost always reviewing the current ${mc.label} production. Be very cautious about flagging wrongProduction or isFilmTv for opening-week reviews. Do NOT confuse the show with same-name films, musicals, or prior productions — use the publish date as strong evidence this is the current ${mc.label} production. Do NOT hallucinate prior productions that may not exist.`;
    }
  }

  // Long-runner hint: Mousetrap (1952), Phantom WE (1986), Les Mis WE (1985),
  // Mamma Mia (1999) — these are continuous-run productions. Any review from
  // any year during that run is legitimate. Without this hint the LLM sees a
  // 40-year publishDate-vs-openingDate gap and flags wrongProduction because
  // its mental model is "revival" not "continuous run". See issue #3 of
  // Notion 34c637c5-416f-812b.
  let longRunnerHint = '';
  if (isLongRunningProduction && openingDate) {
    longRunnerHint = `\n\n**LONG-RUNNING PRODUCTION**: This is a continuous-run ${mc.label} production that has been playing since ${openingDate}. Reviews from ANY year in that continuous run are valid — do NOT flag wrongProduction based on publishDate-vs-openingDate age gap alone. A 2010 review of a show that opened in 1986 is not "wrong production"; it is a review of the same ongoing production 24 years in. Treat the publish date as irrelevant to wrongProduction for long-runners. Only flag wrongProduction if the content explicitly references a DIFFERENT named production (e.g., a touring company, a Broadway transfer, a film adaptation), not based on date math.`;
  }

  // URL-year conflict hint: when the URL path contains /YYYY/ that's significantly
  // earlier than publishDate, the page's metadata date is likely a re-crawl/update
  // timestamp while the URL slug preserves the true publication year. Don't
  // auto-override — CLAUDE.md rule 3 says URLs are unreliable for positive matching.
  // Surface both dates to the LLM and let it decide. See Mamma Mia WE 2021 case:
  // URL was /1999/legit/reviews/mamma-mia-... but publishDate came out as 2015-09-03,
  // leading CV to flag the "time gap" on a legitimate 1999 Variety review.
  // Issue #4 of Notion 34c637c5-416f-812b.
  let urlYearHint = '';
  const urlYear = _extractUrlYear(url);
  if (urlYear && publishDate) {
    const pubYear = new Date(publishDate).getFullYear();
    if (Number.isFinite(pubYear) && Math.abs(pubYear - urlYear) >= 3) {
      urlYearHint = `\n\n**URL-YEAR / PUBLISHDATE CONFLICT**: The review URL path contains "/${urlYear}/" but the stored publishDate is ${publishDate} (year ${pubYear}) — a ${Math.abs(pubYear - urlYear)}-year gap. This often happens when the outlet recrawls / republishes an older article and the metadata date gets updated while the URL slug preserves the original publication year. Treat the URL year as ONE signal, not authoritative. If the review text itself reads as contemporary to the ${urlYear} opening of the production, the URL year is probably correct. Do NOT flag wrongProduction based solely on the publishDate being far from openingDate when this conflict is present.`;
    }
  }

  const wrongProdList = mc.wrongProdExamples.map(e => `   - ${e}`).join('\n');

  const prompt = `You are a content verification assistant for a theater review aggregator. We are verifying reviews of **${mc.label}** productions (${mc.description}).

I scraped what should be a ${mc.label} theater review. Verify if the content is valid.

**Expected Review:**
- Show: "${showTitle}"
- Market: ${mc.label}
- Outlet: ${outletName}
- Critic: ${criticName || 'Unknown'}${dateContext}${publishDateContext}${venueContext}${excerptContext}

**Scraped Content (first 2500 chars):**
${scrapedText.substring(0, 2500)}

**Total scraped length:** ${scrapedText.length} characters

Analyze the content and respond with ONLY valid JSON (no markdown fences):
{
  "isValid": true/false,
  "confidence": "high"/"medium"/"low",
  "wrongArticle": true/false,
  "articleType": "review"/"preview"/"interview"/"news"/"feature"/"box-office"/"obituary"/"listicle"/"other",
  "articleTypeConfidence": "high"/"medium"/"low",
  "wrongProduction": true/false,
  "isFilmTv": true/false,
  "truncated": true/false,
  "issues": ["list of issues found"],
  "reasoning": "1-2 sentence explanation"
}

**Check these specific things:**

1. **Article type (CRITICAL)**: Is this a REVIEW — a critic evaluating a show after seeing it and giving their opinion? Or is it something else:
   - **preview**: written before opening, previewing what to expect
   - **interview**: conversation with cast/creatives
   - **news/feature**: reporting on the show (casting, box office, closings)
   - **box-office**: grosses/financial data
   Set wrongArticle=true if it is NOT a review. Set articleType to the correct category.
   A review MUST contain the critic's assessment of the show's quality.

2. **Wrong article (legacy)**: Is this about a completely different show, or not a theater review at all?

2. **Wrong production** (IMPORTANT): Is this reviewing a NON-${mc.label} production of "${showTitle}"? Red flags:
${wrongProdList}
   A review of the ${mc.label} production that merely *mentions* other productions is NOT a wrong production — it must be *reviewing* a non-${mc.label} staging.

   **"Reviews OF" vs "mentions OF" — the critical distinction (Schmigadoon 2026 FP class):**
   Before flagging wrongProduction=true, ask yourself: is this critic evaluating the ${mc.label} run that just opened, or is the critic evaluating a different run?
     - **Evaluates the ${mc.label} run** (NOT wrongProduction, even if other productions are named): critic attended the ${mc.label} performance, the opinion-bearing sentences describe the ${mc.label} cast/staging, phrases like "the show at [${mc.label} theatre]", "this ${mc.label} outing", "on Broadway/West End now", "in its new ${mc.label} incarnation".
     - **Evaluates a different run** (IS wrongProduction): the opinion-bearing sentences describe a Kennedy Center / Almeida / La Jolla / TV / film / prior-revival cast and venue — the review was WRITTEN about that run and merely refiled on a ${mc.label} show page.
   Background paragraphs that contextualize ("this is a transfer from the Kennedy Center pre-Broadway tryout"), historical asides ("the show was famously a 2021 Apple TV+ series"), or comparative references ("like NBC's Smash…") are NOT evidence of wrongProduction. Do not flag on mention alone.
   **Confidence calibration for this flag:** Only set wrongProduction=true with confidence="high" when the review's opinion-bearing content evaluates a non-${mc.label} production. If the evidence is only a passing mention, contextual aside, or comparative reference, set wrongProduction=false. If you're uncertain whether the review is OF the ${mc.label} run or OF a different run, set confidence="low" — the rebuild gate requires confidence>=medium for promotion.

   **YEAR / PRODUCTION MATCHING (most common failure mode):** The showTitle may contain a year suffix (e.g. "Cats 1982", "A Christmas Carol 2001", "Art 1998"). Many shows have multiple revivals — Cats had a 1982 original and a 2016 Broadway revival at different venues. DO NOT assume the review matches the showTitle year just because the show name matches. Cross-check:
   - What year/run does the review actually describe? Look for opening-year mentions, cast names, venue names, and the review's publishDate.
   - If the showTitle says "Cats 1982" but the review describes a production at Neil Simon Theatre (the 2016 revival was at Neil Simon; the 1982 original was at Winter Garden), that is wrongProduction=true.
   - If the showTitle says "Art 1998" and the review mentions cast members famously in a LATER revival (e.g. Bobby Cannavale / NPH were in the 2025 Art revival, not 1998), that is wrongProduction=true.
   - If the review's publishDate is more than 2 years away from the year in the showTitle, treat it as a strong signal the review is for a different production.
   - Do NOT hallucinate or invent a cast/venue to match the showTitle. Only use facts actually in the scraped text.

3. **Film/TV content**: Is this a review of a film adaptation, TV special, streaming version, or filmed stage production (not a live ${mc.label} performance)?

4. **Truncation**: Does the text end mid-sentence, hit a paywall ("subscribe to read more"), or appear incomplete?

5. **Junk content**: Is this mostly navigation, footer, cookie notices, or non-article content?

**CRITICAL NUANCES — avoid known false positives:**

- **Outlet location does NOT determine production location.** Many out-of-town newspapers have critics who cover ${mc.label} reviews from NYC/London. Peter Marks (Washington Post), Chris Jones (Chicago Tribune), Charles McNulty (LA Times), Matt Wolf (London Theatre / International Herald Tribune), Dominic Cavendish (Telegraph), Michael Billington (Guardian), and many others file reviews of the ${mc.label} production from their home paper. The byline/outlet being "Washington Post" or "Chicago Tribune" or "Manchester Evening News" is NOT by itself evidence of wrong production — look at the VENUE named in the body.

- **American Airlines Theatre / Todd Haimes Theatre** is on Broadway at 227 W 42nd Street (Roundabout's venue). It is NOT in Washington DC even if the review is in the Washington Post. Do not confuse it with the name.

${effectiveMarket === 'broadway' ? `- **Touring company playing AT a Broadway venue (CRITICAL EDGE CASE):** Sometimes a Broadway show entry IS a touring company doing a limited engagement at a Broadway venue (e.g., Mamma Mia 2025 at Winter Garden, The Wiz 2024 at Marquis). Critics may write "the national tour has settled into the [Broadway theatre]" or "this is a touring production playing on Broadway." This is CORRECT (not wrongProduction) — the Broadway show entry represents that specific limited engagement. The KEY signal: if the venue named in the review is a known Broadway theatre (Winter Garden, Marquis, Imperial, Booth, Shubert, Music Box, Majestic, Palace, St. James, etc.), lean CORRECT regardless of whether the production is described as "touring." Only flag wrongProduction when the venue is explicitly non-NYC (Curran SF, Ahmanson LA, Kennedy Center DC, Goodman Chicago, Cadillac Palace Chicago, etc.).` : ''}

${effectiveMarket === 'west-end' || effectiveMarket === 'off-west-end' ? `- **Touring company playing AT a West End venue:** Sometimes a West End show entry IS a touring company doing a limited run at a West End theatre. If the venue named is a West End theatre (Palace, Apollo, Lyceum London, Savoy, Dominion, etc.), lean CORRECT regardless of whether the production is described as "touring."

- **Pre-West-End tryouts at Off-West-End / regional venues:** Reviews at the Almeida, Young Vic, Donmar Warehouse, Royal Court, Hampstead, Menier Chocolate Factory, Southwark Playhouse, Bridge Theatre, Chichester Festival Theatre, Sheffield Crucible, Bristol Old Vic, Manchester Royal Exchange, etc. BEFORE the West End transfer ARE wrong production for the West End entry. Even if the same show later moved to the West End, the tryout review describes the pre-transfer version.` : ''}

${effectiveMarket === 'broadway' ? `- **Pre-Broadway tryouts at regional houses:** Reviews at Chicago Shakespeare, Goodman Theatre, Kennedy Center, La Jolla Playhouse, Old Globe, Mark Taper Forum, ART Cambridge, etc. BEFORE the Broadway transfer ARE wrong production for the Broadway entry. Even if the same show later moved to Broadway, the tryout review describes the pre-Broadway venue.` : ''}

Set isValid=true only if the content is a review of the ${mc.label} production and is not truncated/junk.${temporalHint}${longRunnerHint}${urlYearHint}`;

  const result = await callWithFallback(prompt);

  if (!result) {
    // No LLM providers available — fall back to heuristics
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      let wpFlag = parsed.wrongProduction || false;
      let wpConfidence = parsed.confidence || 'medium';
      let wpReasoning = parsed.reasoning || '';

      // Temporal proximity guards — pure logic lives in review-guards.js (testable in isolation).
      // Call site keeps logging and wpReasoning annotation so CI output remains informative.
      let filmTvFlag = parsed.isFilmTv || false;
      let filmTvConfidence = parsed.confidence || 'medium';
      const temporalOverrides = applyTemporalOverrides(wpFlag, filmTvFlag, wpConfidence, openingDate, publishDate, {
        issues: parsed.issues,
        reasoning: parsed.reasoning,
        show,
        fullText: scrapedText,
      });
      if (temporalOverrides.bypassedForStrongSignal && wpFlag) {
        console.log(`    ✓ LLM wrongProduction NOT overridden: CV issues contain explicit "different show" markers — keeping ${wpConfidence} confidence`);
      }
      if (temporalOverrides.wpConfidence !== wpConfidence && wpFlag && openingDate && publishDate) {
        const daysDiff = Math.round(Math.abs((new Date(publishDate) - new Date(openingDate)) / 86400000));
        console.log(`    ⚠ LLM wrongProduction overridden: review published ${daysDiff}d from opening — downgrading to low confidence`);
        wpReasoning = `[OVERRIDE: review within ${daysDiff}d of opening, likely correct production] ${wpReasoning}`;
      }
      if (!temporalOverrides.filmTvFlag && filmTvFlag && openingDate && publishDate) {
        const daysDiff = Math.round(Math.abs((new Date(publishDate) - new Date(openingDate)) / 86400000));
        console.log(`    ⚠ LLM isFilmTv overridden: review published ${daysDiff}d from opening — downgrading to low confidence`);
        filmTvConfidence = 'low';
      }
      wpConfidence = temporalOverrides.wpConfidence;
      filmTvFlag = temporalOverrides.filmTvFlag;

      return {
        isValid: parsed.isValid ?? true,
        confidence: wpFlag ? wpConfidence : filmTvFlag ? filmTvConfidence : (parsed.confidence || 'medium'),
        issues: parsed.issues || [],
        truncated: parsed.truncated || false,
        wrongArticle: parsed.wrongArticle || false,
        articleType: parsed.articleType || 'review',
        articleTypeConfidence: parsed.articleTypeConfidence || 'medium',
        wrongProduction: wpFlag,
        isFilmTv: filmTvFlag,
        reasoning: wpFlag ? wpReasoning : (parsed.reasoning || ''),
        verifiedBy: `llm:${result.provider}`,
        contentHash: contentHash(scrapedText)
      };
    }

    console.log(`    LLM verify (${result.provider}): could not parse JSON, falling back to heuristic`);
    return heuristicVerify({ scrapedText, excerpt, showTitle });

  } catch (error) {
    console.error(`    LLM verify parse error: ${error.message}`);
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }
}

// ============================================================
// Heuristic Fallback
// ============================================================

/**
 * Heuristic-based content verification (no API needed)
 * Used as fallback when all LLM providers are unavailable
 */
function heuristicVerify({ scrapedText, excerpt, showTitle }) {
  const issues = [];
  let truncated = false;
  let wrongArticle = false;

  if (!scrapedText) {
    return {
      isValid: false,
      confidence: 'high',
      issues: ['No content'],
      truncated: true,
      wrongArticle: false,
      wrongProduction: false,
      isFilmTv: false,
      verifiedBy: 'heuristic'
    };
  }

  const text = scrapedText.toLowerCase();
  const showLower = (showTitle || '').toLowerCase();

  // Check if show title appears in text
  const showMentioned = showLower && (
    text.includes(showLower) ||
    text.includes(showLower.replace(/[^a-z0-9]/g, ''))
  );

  if (!showMentioned && showTitle && showTitle.length > 3) {
    issues.push(`Show title "${showTitle}" not found in content`);
    wrongArticle = true;
  }

  // Check for truncation signals
  const truncationSignals = [
    'subscribe to', 'sign in to', 'create an account', 'members only',
    'continue reading', 'read more', 'premium content', 'paywall',
    'already a subscriber', 'log in to continue'
  ];

  for (const signal of truncationSignals) {
    if (text.includes(signal)) {
      issues.push(`Truncation signal: "${signal}"`);
      truncated = true;
    }
  }

  // Check if ends mid-sentence
  const trimmed = scrapedText.trim();
  const lastChar = trimmed.slice(-1);
  if (!['.', '!', '?', '"', "'", ')'].includes(lastChar)) {
    issues.push('Content may be truncated (does not end with punctuation)');
    truncated = true;
  }

  // Check excerpt match (if provided)
  if (excerpt && excerpt.length > 50) {
    const excerptNorm = excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 100);
    const textNorm = text.replace(/[^a-z0-9\s]/g, '');
    const excerptWords = excerptNorm.split(/\s+/).filter(w => w.length > 4);
    const matchingWords = excerptWords.filter(w => textNorm.includes(w));
    const matchRate = matchingWords.length / excerptWords.length;

    if (matchRate < 0.3 && excerptWords.length > 5) {
      issues.push(`Low excerpt match rate: ${(matchRate * 100).toFixed(0)}%`);
      wrongArticle = true;
    }
  }

  // Check for navigation/junk content
  const junkSignals = [
    'privacy policy', 'terms of use', 'cookie policy', 'all rights reserved',
    'advertisement', 'sponsored content', 'related articles'
  ];

  let junkCount = 0;
  for (const signal of junkSignals) {
    if (text.includes(signal)) junkCount++;
  }

  if (junkCount >= 3) {
    issues.push('Content appears to be mostly navigation/footer junk');
  }

  const isValid = !wrongArticle && issues.length <= 1;

  return {
    isValid,
    confidence: issues.length === 0 ? 'high' : issues.length <= 2 ? 'medium' : 'low',
    issues,
    truncated,
    wrongArticle,
    wrongProduction: false, // Heuristics can't reliably detect this
    isFilmTv: false, // Heuristics can't reliably detect this
    verifiedBy: 'heuristic',
    contentHash: contentHash(scrapedText)
  };
}

/**
 * Quick check if content is likely a valid review (fast, no API)
 */
function quickValidityCheck(text, showTitle) {
  if (!text || text.length < 300) return false;

  const lower = text.toLowerCase();

  const theaterWords = ['broadway', 'theater', 'theatre', 'musical', 'stage', 'performance', 'actor', 'cast', 'director'];
  const hasTheaterContent = theaterWords.some(w => lower.includes(w));

  const showMentioned = !showTitle || lower.includes(showTitle.toLowerCase());

  const junkRatio = (lower.match(/privacy|terms|cookie|subscribe|sign in/g) || []).length;

  return hasTheaterContent && showMentioned && junkRatio < 3;
}

/**
 * Decide whether the LLM CV pass's wrongShow promotion should be deferred
 * (flagged for human review instead of auto-promoted) because the outlet is
 * known for long-biographical leads that resemble wrong-show content.
 *
 * Returns true only when ALL of:
 *   1. getCvStyle(outletId) === 'long-biographical'
 *   2. wordCount(fullText) > 500
 *   3. hasOpinionLanguage(fullText) is true
 *
 * Safe defaults: returns false for missing outletId or fullText.
 *
 * @param {{ outletId?: string, fullText?: string }} reviewData
 * @returns {boolean}
 */
function shouldDeferCvWrongShow(reviewData) {
  const { outletId, fullText } = reviewData || {};
  if (!outletId || !fullText) return false;
  if (getCvStyle(outletId) !== 'long-biographical') return false;
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 500) return false;
  return hasOpinionLanguage(fullText);
}

module.exports = {
  verifyContent,
  heuristicVerify,
  quickValidityCheck,
  contentHash,
  shouldDeferCvWrongShow,
  // Generic prompt→text providers, exported so other verifiers (e.g. the
  // slug-misroute content check) can run multi-model agreement without
  // duplicating the HTTPS plumbing. Each takes a prompt string, returns a
  // Promise<string>, and throws if its API key is unset.
  callGemini,
  callOpenAI,
};
