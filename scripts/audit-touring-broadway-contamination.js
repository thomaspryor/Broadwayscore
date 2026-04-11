#!/usr/bin/env node
/**
 * Audit & Fix Touring/Non-NYC Reviews on Broadway Shows
 *
 * Detects reviews filed under Broadway show IDs that are actually about
 * a touring company, regional production, or non-NYC city run (e.g.
 * SF Cursed Child, Beetlejuice tour, Mean Girls Oklahoma, Pretty Woman
 * Cape Cod, A Little Night Music LA Greenway).
 *
 * Distinct from existing audits:
 *   - audit-pre2005-reviews.js: catches REVIVAL contamination (year mismatch)
 *   - audit-wrong-production-reviews.js: catches REVIVAL by cast/director cross-check
 *   - verify-existing-reviews.js: misses reviews already stamped verifiedBy:llm:*
 *     (Gemini classified them as clean before the prompt was tour-strict, OR they
 *      were never verified at all)
 *
 * This script:
 *   1. Heuristic candidate generation: regional outlets, tour phrases in fullText,
 *      non-NYC venue mentions, regional outlet name patterns.
 *   2. LLM verification on each candidate, BYPASSING existing verifiedBy stamps.
 *      Uses Claude (most accurate) by default — Gemini missed these the first time.
 *   3. Apply mode: writes wrongProduction=true with reasoning, preserves text in
 *      wrongFullText, sets fullText=null. Matches existing convention from
 *      verify-existing-reviews.js.
 *
 * Usage:
 *   node scripts/audit-touring-broadway-contamination.js [options]
 *
 * Options:
 *   --dry-run         Run candidates + LLM, do not write files (default)
 *   --candidates-only Generate candidate list only, no LLM calls
 *   --apply           Write wrongProduction flag for high-confidence verdicts
 *   --limit=N         Cap LLM calls (default: 0 = unlimited)
 *   --concurrency=N   Parallel LLM calls (default: 5)
 *   --provider=NAME   claude (default) | openai | gemini
 *   --show=SLUG       Filter to single show
 *   --resume          Continue from checkpoint
 *   --verbose         Per-file output
 *   --report=PATH     Output report path (default: data/audit/touring-contamination-report.json)
 *
 * Env:
 *   ANTHROPIC_API_KEY   Required for claude (default)
 *   OPENAI_API_KEY      Required for openai
 *   GEMINI_API_KEY      Required for gemini
 *
 * Output:
 *   data/audit/touring-contamination-report.json
 *   data/audit/.touring-contamination-checkpoint.json (cleaned on completion)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

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

// --- CLI ---
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY; // dry-run unless --apply
const CANDIDATES_ONLY = args.includes('--candidates-only');
const RESUME = args.includes('--resume');
const VERBOSE = args.includes('--verbose');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 5;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'claude';
const REPORT_PATH = (args.find(a => a.startsWith('--report=')) || '').split('=')[1]
  || path.join(__dirname, '..', 'data', 'audit', 'touring-contamination-report.json');

// --- Paths ---
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const CHECKPOINT_PATH = path.join(__dirname, '..', 'data', 'audit', '.touring-contamination-checkpoint.json');

// --- Load core data ---
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showById = new Map(showsData.shows.map(s => [s.id, s]));
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const outletInfo = {};
for (const [id, o] of Object.entries(registry.outlets || {})) {
  outletInfo[id] = {
    region: o.region || null,
    isDual: !!o.isDualMarket,
    name: o.displayName,
  };
}

// --- Stats ---
const stats = {
  candidatesScanned: 0,
  candidatesFound: 0,
  alreadyFlagged: 0,
  noText: 0,
  llmCalled: 0,
  wrongProduction: 0,
  correct: 0,
  uncertain: 0,
  appliedFlag: 0,
  errors: 0,
  rateLimitHits: 0,
  byProvider: {},
};

// ============================================================
// Heuristic Signals
// ============================================================

// Regional outlets the registry knows about (region tag set, not dual-market)
function regionalOutletSignal(review) {
  const oid = review.outletId
    || (review.outlet || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const oi = outletInfo[oid];
  if (!oi || oi.isDual) return null;
  if (!oi.region) return null;
  if (['new-york', 'nyc', 'dual', 'us'].includes(oi.region.toLowerCase())) return null;
  return `regional-outlet:${oi.region}`;
}

// Outlet name pattern: city-named papers we don't have tagged
const REGIONAL_OUTLET_NAME_PATTERNS = [
  // (regex, region label)
  [/\b(?:san[\s-]?francisco|sf)[\s-]chronicle\b/i, 'san-francisco'],
  [/\bsfgate\b/i, 'san-francisco'],
  [/\bdallas[\s-]morning[\s-]news\b/i, 'dallas'],
  [/\bdetroit[\s-]free[\s-]press\b/i, 'detroit'],
  [/\bdenver[\s-]post\b/i, 'denver'],
  [/\bcleveland[\s-](?:plain[\s-]dealer|com)\b/i, 'cleveland'],
  [/\bseattle[\s-]times\b/i, 'seattle'],
  [/\bhouston[\s-]chronicle\b/i, 'houston'],
  [/\bminneapolis[\s-]star[\s-]tribune\b/i, 'minneapolis'],
  [/\bbaltimore[\s-]sun\b/i, 'baltimore'],
  [/\bmilwaukee[\s-]journal[\s-]sentinel\b/i, 'milwaukee'],
  [/\borlando[\s-]sentinel\b/i, 'orlando'],
  [/\btampa[\s-]bay[\s-]times\b/i, 'tampa'],
  [/\bcincinnati[\s-]enquirer\b/i, 'cincinnati'],
  [/\baz[\s-]?central\b/i, 'phoenix'],
  [/\bcape[\s-]cod[\s-]times\b/i, 'cape-cod'],
  [/\bel[\s-]paso[\s-]times\b/i, 'el-paso'],
  [/\boklahoma\b/i, 'oklahoma'],
  [/\baurora[\s-]beacon\b/i, 'aurora'],
  [/\bworcester\b/i, 'worcester'],
  [/\bpatchogue\b/i, 'patchogue'],
];

function regionalOutletNameSignal(review) {
  const oid = review.outletId || '';
  const oname = (review.outlet || '').toLowerCase();
  for (const [re, region] of REGIONAL_OUTLET_NAME_PATTERNS) {
    if (re.test(oname) || re.test(oid)) return `regional-outlet-name:${region}`;
  }
  return null;
}

// Tour phrasing in body text — strict patterns to avoid "Broadway in spring 2026" type false positives
const TOUR_PHRASES = [
  /\bnational tour\b/i,
  /\btouring (?:company|production|cast|version)\b/i,
  /\btouring at the\b/i,
  /\bfirst national tour\b/i,
  /\bsecond national tour\b/i,
  /\bequity tour\b/i,
  /\bnon-equity tour\b/i,
  /\btour stop\b/i,
  /\bbus[- ]and[- ]truck\b/i,
  /\bbroadway across (?:america|canada)\b/i,
  // City-named "Broadway in" series — only known tour brands
  /\bbroadway in (?:chicago|boston|detroit|milwaukee|minneapolis|cincinnati|cleveland|st\.?\s?louis|kansas\s?city|charlotte|atlanta|miami|orlando|tampa|jacksonville|new\s?orleans|memphis|nashville|louisville|indianapolis|columbus|pittsburgh|philadelphia|baltimore|denver|salt\s?lake|phoenix|tucson|albuquerque|las\s?vegas|los\s?angeles|san\s?diego|san\s?francisco|sacramento|portland|seattle|spokane|honolulu|austin|dallas|houston|san\s?antonio|fort\s?worth|el\s?paso|toronto|vancouver|montreal|ottawa|edmonton|calgary)\b/i,
  /\bout-of-town tryout\b/i,
  /\bpre-broadway tryout\b/i,
];

function tourPhraseSignal(text) {
  if (!text) return null;
  for (const re of TOUR_PHRASES) {
    if (re.test(text)) return `tour-phrase:${re.source.replace(/\\b/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '').trim()}`;
  }
  return null;
}

// Non-NYC theatre venues — strong signal when matched
const NON_NYC_VENUES = [
  // San Francisco
  [/\bcurran theat(?:re|er),? san francisco\b/i, 'sf'],
  [/\bgolden gate theat(?:re|er),? san francisco\b/i, 'sf'],
  [/\borpheum theat(?:re|er),? san francisco\b/i, 'sf'],
  [/\bsan francisco['']s? (?:curran|orpheum|golden gate)\b/i, 'sf'],
  // Los Angeles
  [/\bahmanson theat(?:re|er)\b/i, 'la'],
  [/\bpantages theat(?:re|er)\b/i, 'la'],
  [/\bdolby theat(?:re|er)\b/i, 'la'],
  [/\bgreenway court theat(?:re|er)\b/i, 'la'],
  [/\bmark taper forum\b/i, 'la'],
  // DC
  [/\bkennedy center\b/i, 'dc'],
  [/\bnational theat(?:re|er),? washington\b/i, 'dc'],
  // Chicago
  [/\bcadillac palace\b/i, 'chicago'],
  [/\bcibc theat(?:re|er)\b/i, 'chicago'],
  [/\bauditorium theat(?:re|er),? chicago\b/i, 'chicago'],
  [/\bnederlander theat(?:re|er),? chicago\b/i, 'chicago'],
  [/\bgoodman theat(?:re|er)\b/i, 'chicago'],
  // Boston
  [/\bboch (?:wang|shubert) theat(?:re|er)\b/i, 'boston'],
  [/\bcolonial theat(?:re|er),? boston\b/i, 'boston'],
  [/\bemerson colonial\b/i, 'boston'],
  // Other US
  [/\bproctors theat(?:re|er)\b/i, 'schenectady'],
  [/\bproviedence performing arts/i, 'providence'],
  [/\bdurham performing arts center\b/i, 'durham'],
  [/\bdr[\s.]+phillips center\b/i, 'orlando'],
  [/\bcape (?:cod )?playhouse\b/i, 'cape-cod'],
  [/\bnational arts centre\b/i, 'ottawa'], // Canada — Beetlejuice tour
];

function venueSignal(text) {
  if (!text) return null;
  for (const [re, label] of NON_NYC_VENUES) {
    if (re.test(text)) return `non-nyc-venue:${label}`;
  }
  return null;
}

// City + theatre proximity — last resort, lower precision
function proximitySignal(text) {
  if (!text) return null;
  // "[Theatre/Theater] in [City]" where city is not New York
  const m = text.match(/\b(?:theatre|theater),?\s+in\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (m) {
    const city = m[1];
    if (!/(?:new york|brooklyn|manhattan|queens|bronx)/i.test(city)) {
      return `theatre-in-city:${city}`;
    }
  }
  return null;
}

function gatherSignals(review) {
  const text = review.fullText || review.bwwExcerpt || review.dtliExcerpt
    || review.showScoreExcerpt || review.pullQuote || '';
  const sigs = [];
  let s;
  if ((s = regionalOutletSignal(review))) sigs.push(s);
  if ((s = regionalOutletNameSignal(review))) sigs.push(s);
  if ((s = tourPhraseSignal(text))) sigs.push(s);
  if ((s = venueSignal(text))) sigs.push(s);
  if ((s = proximitySignal(text))) sigs.push(s);
  return sigs;
}

// ============================================================
// LLM Providers
// ============================================================

function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return new Promise((resolve, reject) => {
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
          } catch (e) { reject(new Error(`Claude parse: ${e.message}`)); }
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

function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 400,
    temperature: 0.1,
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (e) { reject(new Error(`OpenAI parse: ${e.message}`)); }
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

function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 400 },
  });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
          } catch (e) { reject(new Error(`Gemini parse: ${e.message}`)); }
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
  if (PROVIDER === 'openai') return callOpenAI(systemPrompt, userPrompt);
  if (PROVIDER === 'gemini') return callGemini(systemPrompt, userPrompt);
  return callClaude(systemPrompt, userPrompt);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLMWithRetry(sysP, userP, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callLLM(sysP, userP);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        stats.rateLimitHits++;
        const delay = Math.pow(2, attempt) * 5000;
        if (VERBOSE) console.log(`  rate limited, waiting ${delay / 1000}s`);
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
// Tour-Aware Verification Prompt
// ============================================================

const SYSTEM_PROMPT = `You are a content verification assistant for a Broadway theater review database. Your job is to determine whether a given review is about the BROADWAY production it is currently filed under, or about a DIFFERENT production of the same show — specifically a national tour, a regional/out-of-town production, an Off-Broadway run, or a West End/London staging.

You will be given:
- The Broadway show title and the production's opening year
- The outlet, critic, publish date
- A list of audit signals that flagged this review as suspect (regional outlet, tour phrases, non-NYC venues, etc.)
- The review text

CLASSIFICATION RULES:
- "WRONG_PRODUCTION" = the review is clearly about a non-Broadway production (tour stop, regional theater, OB run, West End)
- "CORRECT" = the review is about the Broadway production it's filed under (even if it briefly mentions other productions in passing)
- "UNCERTAIN" = signals exist but text is ambiguous or insufficient

KEY POSITIVE INDICATORS (suggests CORRECT — review IS about the Broadway production):
- Mentions a Broadway venue: Imperial, Shubert, Marquis, Booth, Walter Kerr, Music Box, August Wilson, Hudson, Nederlander, Broadhurst, Belasco, Eugene O'Neill, Lyceum, Gerald Schoenfeld, Bernard Jacobs, Helen Hayes, John Golden, Lyric, Majestic, Minskoff, Neil Simon, New Amsterdam, Palace, Richard Rodgers, Vivian Beaumont, Winter Garden, Circle in the Square, Gershwin, etc.
- Says "Broadway" + a credit specific to the Broadway run (named cast, opening, "now on Broadway")
- Published within ~14 days of the Broadway opening (reviews near opening night are almost always the Broadway production)
- The byline is a recognized Broadway critic (Chris Jones, Charles Isherwood, etc. — many Chicago/LA critics also cover Broadway openings via "NEW YORK —" datelines)

KEY NEGATIVE INDICATORS (suggests WRONG_PRODUCTION — review is NOT about the Broadway production):
- Names a specific non-NYC theatre as the venue: Curran (SF), Ahmanson/Pantages (LA), Kennedy Center (DC), Cadillac Palace/CIBC/Goodman (Chicago), Cape Cod Playhouse, National Arts Centre (Ottawa), Greenway Court, Mark Taper Forum
- Says "national tour", "touring company", "tour stop", "Broadway in Chicago/Boston/etc.", "Broadway Across America/Canada"
- Says "I caught the show at [non-NYC venue]" or "now playing at [non-NYC venue]"
- Reviews a regional / pre-Broadway tryout
- Is a roundup of regional theater season

CRITICAL NUANCES:
- A Broadway critic from Chicago Tribune (Chris Jones) writing "NEW YORK —" is reviewing the Broadway production, NOT the Chicago tour. CORRECT.
- An LA Times year-end "best of LA theater" listicle that mentions a Broadway show in passing is WRONG_PRODUCTION (it's actually a regional review).
- Boilerplate share buttons, footers, related-article snippets, navigation links can mention other productions — IGNORE these. Look at what the article ACTUALLY discusses.
- A passing mention of "the original Broadway production" or "the touring cast" in an otherwise-Broadway review is NOT wrong-production.
- If the publishDate is within 21 days of the Broadway opening AND the venue is not explicitly non-NYC, lean CORRECT.

Return ONLY a JSON object (no markdown, no commentary):
{"verdict": "WRONG_PRODUCTION|CORRECT|UNCERTAIN", "confidence": "high|medium|low", "venue": "<non-NYC venue if identified, else null>", "tourLabel": "<e.g. 'San Francisco run', 'National tour', 'Cape Cod tryout', else null>", "reasoning": "<1-2 sentences citing the strongest signal>"}`;

function buildUserPrompt(item, reviewData) {
  const show = showById.get(item.showId);
  const showTitle = show?.title || item.showId;
  const showYear = show?.openingDate ? new Date(show.openingDate).getFullYear() : '?';
  const venue = show?.venue || 'unknown';

  const text = reviewData.fullText
    || reviewData.bwwExcerpt
    || reviewData.dtliExcerpt
    || reviewData.showScoreExcerpt
    || reviewData.pullQuote
    || '';

  // Truncate long texts
  let truncated = text;
  if (text.length > 3000) {
    truncated = text.substring(0, 2000) + '\n\n[...truncated...]\n\n' + text.substring(text.length - 1000);
  }

  return `BROADWAY SHOW: "${showTitle}"
FILED UNDER: ${item.showId}
BROADWAY VENUE: ${venue}
BROADWAY OPENING YEAR: ${showYear}
OUTLET: ${reviewData.outlet || 'Unknown'} (${reviewData.outletId || ''})
CRITIC: ${reviewData.criticName || 'Unknown'}
PUBLISH DATE: ${reviewData.publishDate || 'Unknown'}
URL: ${reviewData.url || ''}

AUDIT SIGNALS THAT FLAGGED THIS REVIEW AS SUSPECT:
${item.signals.map(s => '  - ' + s).join('\n')}

REVIEW TEXT:
${truncated || '(no text available)'}`;
}

function parseResponse(raw) {
  const text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj.verdict && obj.confidence) {
      return {
        verdict: obj.verdict.toUpperCase(),
        confidence: obj.confidence.toLowerCase(),
        venue: obj.venue || null,
        tourLabel: obj.tourLabel || null,
        reasoning: (obj.reasoning || '').slice(0, 400),
      };
    }
  } catch (e) {
    const verdictMatch = text.match(/"verdict"\s*:\s*"(\w+)"/);
    const confMatch = text.match(/"confidence"\s*:\s*"(\w+)"/);
    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toUpperCase(),
        confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
        venue: null,
        tourLabel: null,
        reasoning: '(parsed from malformed JSON)',
      };
    }
  }
  return null;
}

// ============================================================
// Candidate Generation
// ============================================================

function generateCandidates() {
  const broadwayShows = showsData.shows.filter(s =>
    !s.id.includes('west-end')
    && !s.id.includes('off-broadway')
    && (!s.category || s.category === 'broadway')
  );

  const candidates = [];
  for (const show of broadwayShows) {
    if (SHOW_FILTER && show.id !== SHOW_FILTER && !show.id.includes(SHOW_FILTER)) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
      stats.candidatesScanned++;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (r.wrongProduction || r.wrongShow || r.wrongAttribution) {
        stats.alreadyFlagged++;
        continue;
      }
      const sigs = gatherSignals(r);
      if (sigs.length === 0) continue;
      const text = r.fullText || r.bwwExcerpt || r.dtliExcerpt || r.showScoreExcerpt || r.pullQuote || '';
      if (text.trim().length < 50) {
        stats.noText++;
        continue;
      }
      candidates.push({
        showId: show.id,
        showTitle: show.title,
        file: f,
        outletId: r.outletId || '',
        outlet: r.outlet || '',
        criticName: r.criticName || '',
        publishDate: r.publishDate || '',
        signals: sigs,
        existingVerifiedBy: r.verifiedBy || null,
      });
      stats.candidatesFound++;
    }
  }
  return candidates;
}

// ============================================================
// Apply
// ============================================================

function applyFlag(item, parsed) {
  const filePath = path.join(REVIEW_TEXTS_DIR, item.showId, item.file);
  if (!fs.existsSync(filePath)) return false;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Don't double-flag
  if (data.wrongProduction) return false;

  data.wrongProduction = true;
  const venuePart = parsed.venue ? ` at ${parsed.venue}` : '';
  const tourPart = parsed.tourLabel ? ` (${parsed.tourLabel})` : '';
  data.wrongProductionReason = `Touring/non-NYC audit (${PROVIDER})${tourPart}${venuePart}: ${parsed.reasoning}`;
  data.verifiedBy = `llm:${PROVIDER}`;
  data.touringContaminationAuditDate = new Date().toISOString().slice(0, 10);

  // Preserve fullText (matching verify-existing-reviews.js convention)
  if (data.fullText) {
    data.wrongFullText = data.fullText;
    data.fullText = null;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`=== Touring/Non-NYC Broadway Contamination Audit ===`);
  console.log(`Provider: ${PROVIDER}`);
  console.log(`Mode:     ${APPLY ? 'APPLY (writes files)' : 'DRY-RUN (no writes)'}`);
  if (SHOW_FILTER) console.log(`Show:     ${SHOW_FILTER}`);
  if (LIMIT) console.log(`Limit:    ${LIMIT}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  console.log('Step 1: Generating candidates from heuristic signals...');
  const candidates = generateCandidates();
  console.log(`  Reviews scanned:     ${stats.candidatesScanned}`);
  console.log(`  Already flagged:     ${stats.alreadyFlagged}`);
  console.log(`  Skipped (no text):   ${stats.noText}`);
  console.log(`  Candidates found:    ${stats.candidatesFound}`);

  if (CANDIDATES_ONLY) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      _meta: { generatedAt: new Date().toISOString(), mode: 'candidates-only', stats },
      candidates,
    }, null, 2));
    console.log(`\nWrote candidates to ${REPORT_PATH}`);
    return;
  }

  // Apply limit
  const items = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
  console.log(`\nStep 2: LLM verification on ${items.length} candidates...`);

  // Load checkpoint
  let checkpoint = {};
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    console.log(`  Resuming from checkpoint (${Object.keys(checkpoint).length} prior verdicts)`);
  }

  const results = [];

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (item) => {
      const key = `${item.showId}/${item.file}`;
      if (checkpoint[key]) {
        results.push(checkpoint[key]);
        return;
      }

      const filePath = path.join(REVIEW_TEXTS_DIR, item.showId, item.file);
      if (!fs.existsSync(filePath)) { stats.errors++; return; }
      let reviewData;
      try { reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (e) { stats.errors++; return; }

      // Re-check: was the file already flagged in a parallel session?
      if (reviewData.wrongProduction) { stats.alreadyFlagged++; return; }

      try {
        const raw = await callLLMWithRetry(SYSTEM_PROMPT, buildUserPrompt(item, reviewData));
        stats.llmCalled++;
        stats.byProvider[PROVIDER] = (stats.byProvider[PROVIDER] || 0) + 1;
        const parsed = parseResponse(raw);
        if (!parsed) {
          stats.errors++;
          if (VERBOSE) console.log(`  PARSE_ERR ${key}`);
          return;
        }

        const result = {
          showId: item.showId,
          showTitle: item.showTitle,
          file: item.file,
          outlet: item.outlet,
          criticName: item.criticName,
          publishDate: item.publishDate,
          signals: item.signals,
          existingVerifiedBy: item.existingVerifiedBy,
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          venue: parsed.venue,
          tourLabel: parsed.tourLabel,
          reasoning: parsed.reasoning,
        };
        results.push(result);
        checkpoint[key] = result;

        if (parsed.verdict === 'WRONG_PRODUCTION') {
          stats.wrongProduction++;
          if (VERBOSE || parsed.confidence === 'high') {
            console.log(`  WRONG[${parsed.confidence}] ${key}: ${parsed.tourLabel || ''}${parsed.venue ? ' @ ' + parsed.venue : ''} — ${parsed.reasoning}`);
          }
          if (APPLY && parsed.confidence === 'high') {
            if (applyFlag(item, parsed)) stats.appliedFlag++;
          }
        } else if (parsed.verdict === 'CORRECT') {
          stats.correct++;
          if (VERBOSE) console.log(`  OK ${key}`);
        } else {
          stats.uncertain++;
          if (VERBOSE) console.log(`  UNCERTAIN ${key}: ${parsed.reasoning}`);
        }
      } catch (e) {
        stats.errors++;
        console.error(`  ERROR ${key}: ${e.message}`);
      }
    });

    await Promise.all(promises);

    // Persist checkpoint
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));

    const done = Math.min(i + CONCURRENCY, items.length);
    const pct = Math.round((done / items.length) * 100);
    console.log(`  ${done}/${items.length} (${pct}%) — wrong=${stats.wrongProduction} correct=${stats.correct} uncertain=${stats.uncertain}`);
  }

  // Write report
  const wrongHigh = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'high');
  const wrongMed = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'medium');
  const wrongLow = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'low');
  const byShow = {};
  for (const r of results.filter(x => x.verdict === 'WRONG_PRODUCTION')) {
    if (!byShow[r.showId]) byShow[r.showId] = [];
    byShow[r.showId].push(r);
  }

  const report = {
    _meta: {
      generatedAt: new Date().toISOString(),
      provider: PROVIDER,
      apply: APPLY,
      stats,
      counts: {
        wrongHigh: wrongHigh.length,
        wrongMedium: wrongMed.length,
        wrongLow: wrongLow.length,
        correct: stats.correct,
        uncertain: stats.uncertain,
      },
    },
    byShow,
    results,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote report to ${REPORT_PATH}`);

  console.log('\n=== SUMMARY ===');
  console.log(`Candidates scanned:    ${stats.candidatesScanned}`);
  console.log(`Already flagged:       ${stats.alreadyFlagged}`);
  console.log(`LLM calls:             ${stats.llmCalled}`);
  console.log(`  WRONG_PRODUCTION:    ${stats.wrongProduction}`);
  console.log(`    high confidence:   ${wrongHigh.length}`);
  console.log(`    medium confidence: ${wrongMed.length}`);
  console.log(`    low confidence:    ${wrongLow.length}`);
  console.log(`  CORRECT:             ${stats.correct}`);
  console.log(`  UNCERTAIN:           ${stats.uncertain}`);
  console.log(`Errors:                ${stats.errors}`);
  console.log(`Rate limit hits:       ${stats.rateLimitHits}`);
  if (APPLY) {
    console.log(`Applied flags:         ${stats.appliedFlag}`);
  }

  // Show top wrong-production shows
  if (Object.keys(byShow).length > 0) {
    console.log('\nTop shows with wrong-production reviews:');
    Object.entries(byShow)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 15)
      .forEach(([id, list]) => console.log(`  ${list.length}\t${id}`));
  }

  // Cleanup checkpoint on full completion
  if (results.length === items.length && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
