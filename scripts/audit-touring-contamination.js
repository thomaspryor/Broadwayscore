#!/usr/bin/env node
/**
 * Audit & Fix Touring / Out-of-Market Reviews
 *
 * Detects reviews filed under a show ID that are actually about a DIFFERENT
 * production — a touring company, regional tryout, transfer origin, or
 * cross-market version.
 *
 * Markets supported via --market:
 *   - broadway (default): catches tour stops (SF Cursed Child, Beetlejuice El Paso),
 *     pre-Broadway tryouts (Chicago Shakespeare, Goodman, Kennedy Center), West End
 *     transfers of the same title, regional roundups mentioning a Broadway show.
 *   - west-end: catches UK regional productions (Chichester, Manchester Royal Exchange,
 *     Bristol Old Vic, Sheffield Crucible), Edinburgh Fringe runs, UK touring company
 *     stops, pre-West End tryouts at off-West End houses (Almeida, Young Vic, Donmar
 *     pre-transfer), Broadway productions of the same show.
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
 *      out-of-market venue mentions, regional outlet name patterns.
 *   2. LLM verification on each candidate, BYPASSING existing verifiedBy stamps.
 *      Uses Claude (most accurate) by default — Gemini missed these the first time.
 *   3. Apply mode: writes wrongProduction=true with reasoning, preserves text in
 *      wrongFullText, sets fullText=null. Matches existing convention from
 *      verify-existing-reviews.js.
 *   4. Score-impact preflight: aborts apply if any show would fall below
 *      hasEnoughReviews() threshold unless --allow-tbd-regressions is set.
 *
 * Usage:
 *   node scripts/audit-touring-contamination.js [options]
 *
 * Options:
 *   --market=NAME                broadway (default) | west-end
 *   --dry-run                    Run candidates + LLM, do not write files (default)
 *   --candidates-only            Generate candidate list only, no LLM calls
 *   --apply                      Write wrongProduction flag for high-confidence verdicts
 *   --allow-tbd-regressions      Required with --apply if any shows would fall below
 *                                hasEnoughReviews() threshold (5 for Broadway/WE, 3 for OB/OWE).
 *   --limit=N                    Cap LLM calls (default: 0 = unlimited)
 *   --concurrency=N              Parallel LLM calls (default: 5)
 *   --provider=NAME              claude (default) | openai | gemini
 *   --show=SLUG                  Filter to single show
 *   --resume                     Continue from checkpoint
 *   --verbose                    Per-file output
 *   --report=PATH                Output report path (default: data/audit/touring-contamination-report.{market}.json)
 *
 * Env:
 *   ANTHROPIC_API_KEY   Required for claude (default)
 *   OPENAI_API_KEY      Required for openai
 *   GEMINI_API_KEY      Required for gemini
 *
 * Output:
 *   data/audit/touring-contamination-report.{market}.json
 *   data/audit/.touring-contamination-checkpoint.{market}.json (cleaned on completion)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');
const { CLAUDE_HAIKU, GPT4O_MINI, GEMINI_FLASH } = require('./lib/models');

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
const ALLOW_TBD_REGRESSIONS = args.includes('--allow-tbd-regressions');
const CANDIDATES_ONLY = args.includes('--candidates-only');
const RESUME = args.includes('--resume');
const VERBOSE = args.includes('--verbose');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 5;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'claude';
const MARKET = (args.find(a => a.startsWith('--market=')) || '').split('=')[1] || 'broadway';
if (!['broadway', 'west-end'].includes(MARKET)) {
  console.error(`ERROR: --market must be 'broadway' or 'west-end', got '${MARKET}'`);
  process.exit(1);
}
const REPORT_PATH = (args.find(a => a.startsWith('--report=')) || '').split('=')[1]
  || path.join(__dirname, '..', 'data', 'audit', `touring-contamination-report.${MARKET}.json`);

// --- Paths ---
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const CHECKPOINT_PATH = path.join(__dirname, '..', 'data', 'audit', `.touring-contamination-checkpoint.${MARKET}.json`);

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
// Market Configs
// ============================================================

const MARKET_CONFIG = {
  broadway: {
    // Shows included in this market's audit
    showFilter: s => !s.id.includes('west-end') && !s.id.includes('off-broadway')
      && (!s.category || s.category === 'broadway'),

    // Outlet regions that are CORRECT for this market (so we DON'T flag)
    correctRegions: new Set(['new-york', 'nyc', 'dual', 'us']),

    // Outlet name patterns that aren't tagged in outlet-registry but imply regional US coverage
    regionalNamePatterns: [
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
    ],

    // Tour/out-of-market phrases in body text (strict enough to avoid "Broadway in spring 2026")
    tourPhrases: [
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
    ],

    // Non-home venues — strong signal when matched
    nonHomeVenues: [
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
    ],

    // Proximity signal: "[theatre] in [city]" where city isn't a home-city
    homeCityRegex: /(?:new york|brooklyn|manhattan|queens|bronx)/i,
  },

  'west-end': {
    // West End + Off-West End? Scope only West End for this pass — OWE has its own
    // category and venue set; add --market=off-west-end later if useful.
    showFilter: s => s.category === 'west-end'
      || (s.id.includes('west-end') && s.category !== 'off-west-end'),

    // London outlets are correct for West End. Dual-market outlets (NYT, Guardian)
    // cover both markets. 'uk' too vague — too many false positives.
    correctRegions: new Set(['london', 'uk', 'dual']),

    // UK regional outlets and Scottish/Welsh/NI papers — flag when reviewing West End shows
    regionalNamePatterns: [
      [/\bmanchester[\s-]evening[\s-]news\b/i, 'manchester'],
      [/\byorkshire[\s-]post\b/i, 'yorkshire'],
      [/\bbirmingham[\s-]post\b/i, 'birmingham'],
      [/\bliverpool[\s-]echo\b/i, 'liverpool'],
      [/\bthe[\s-]scotsman\b/i, 'edinburgh'],
      [/\bherald[\s-]scotland\b/i, 'glasgow'],
      [/\bglasgow[\s-]herald\b/i, 'glasgow'],
      [/\bwestern[\s-]mail\b/i, 'cardiff'],
      [/\bbelfast[\s-]telegraph\b/i, 'belfast'],
      [/\birish[\s-]times\b/i, 'dublin'],
      [/\bbath[\s-]chronicle\b/i, 'bath'],
      [/\bbristol[\s-]post\b/i, 'bristol'],
      [/\bnottingham[\s-]post\b/i, 'nottingham'],
      [/\boxford[\s-]mail\b/i, 'oxford'],
      [/\bcambridge[\s-]news\b/i, 'cambridge'],
    ],

    // UK touring + regional phrases
    tourPhrases: [
      /\buk tour\b/i,
      /\buk touring\b/i,
      /\bnational tour(?:ing)?\b/i, // UK national tour
      /\btouring (?:company|production|cast|version)\b/i,
      /\btour stop\b/i,
      /\bedinburgh (?:festival )?fringe\b/i,
      /\bedinburgh international festival\b/i,
      /\bworld premi[eè]re (?:at|on|in) (?:chichester|sheffield|manchester|bristol|birmingham|nottingham|leeds|liverpool|bath|glasgow|edinburgh)\b/i,
      /\bpre[- ]west[- ]end (?:run|tryout|engagement)\b/i,
      /\btransfer(?:red|s)? (?:to|from) (?:the )?(?:west end|broadway)\b/i,
      // "before transferring to [West End theatre]" = tryout signal
      /\bbefore transferring to\b/i,
      /\b(?:first )?(?:opened |previewed )?(?:at|in) (?:chichester|sheffield|manchester|bristol|birmingham|nottingham|leeds|liverpool|bath)\b/i,
    ],

    // Non-West-End venues — UK regional, Fringe, Off-West End (for pre-WE tryouts), Broadway
    nonHomeVenues: [
      // UK major regional theatres
      [/\bchichester festival theat(?:re|er)\b/i, 'chichester'],
      [/\bminerva theat(?:re|er)(?:,? chichester)?\b/i, 'chichester'],
      [/\bbristol old vic\b/i, 'bristol'],
      [/\btobacco factory\b/i, 'bristol'],
      [/\bsheffield crucible\b/i, 'sheffield'],
      [/\bcrucible theat(?:re|er),? sheffield\b/i, 'sheffield'],
      [/\blyceum theat(?:re|er),? sheffield\b/i, 'sheffield'],
      [/\bleeds playhouse\b/i, 'leeds'],
      [/\bwest yorkshire playhouse\b/i, 'leeds'],
      [/\bmanchester royal exchange\b/i, 'manchester'],
      [/\broyal exchange theat(?:re|er),? manchester\b/i, 'manchester'],
      [/\bhome manchester\b/i, 'manchester'],
      [/\blowry (?:theatre|salford)\b/i, 'salford'],
      [/\bbirmingham rep(?:ertory)?\b/i, 'birmingham'],
      [/\balexandra theat(?:re|er),? birmingham\b/i, 'birmingham'],
      [/\bnottingham playhouse\b/i, 'nottingham'],
      [/\btheatre royal,? nottingham\b/i, 'nottingham'],
      [/\bliverpool everyman\b/i, 'liverpool'],
      [/\bliverpool playhouse\b/i, 'liverpool'],
      [/\bpalace theat(?:re|er),? manchester\b/i, 'manchester'],
      [/\bopera house,? manchester\b/i, 'manchester'],
      [/\btheatre royal,? bath\b/i, 'bath'],
      [/\bustinov studio\b/i, 'bath'],
      [/\bcurve,? leicester\b/i, 'leicester'],
      [/\bnorthcott theat(?:re|er),? exeter\b/i, 'exeter'],
      [/\bnuffield theat(?:re|er),? southampton\b/i, 'southampton'],
      [/\bmayflower theat(?:re|er),? southampton\b/i, 'southampton'],
      [/\bmarlowe theat(?:re|er),? canterbury\b/i, 'canterbury'],
      [/\brichmond theat(?:re|er)\b/i, 'richmond'],
      [/\bmilton keynes theat(?:re|er)\b/i, 'milton-keynes'],
      [/\btheatre royal,? plymouth\b/i, 'plymouth'],
      [/\bnorwich theatre royal\b/i, 'norwich'],
      [/\bcambridge arts theat(?:re|er)\b/i, 'cambridge'],
      [/\bnew theatre,? oxford\b/i, 'oxford'],
      [/\boxford playhouse\b/i, 'oxford'],
      // Scotland + Wales + NI
      [/\bfestival theat(?:re|er),? edinburgh\b/i, 'edinburgh'],
      [/\bking['']s theat(?:re|er),? edinburgh\b/i, 'edinburgh'],
      [/\broyal lyceum,? edinburgh\b/i, 'edinburgh'],
      [/\btraverse theat(?:re|er)\b/i, 'edinburgh'],
      [/\bking['']s theat(?:re|er),? glasgow\b/i, 'glasgow'],
      [/\btheatre royal,? glasgow\b/i, 'glasgow'],
      [/\bcitizens theat(?:re|er),? glasgow\b/i, 'glasgow'],
      [/\btron theat(?:re|er),? glasgow\b/i, 'glasgow'],
      [/\bwales millennium centre\b/i, 'cardiff'],
      [/\bsherman theat(?:re|er),? cardiff\b/i, 'cardiff'],
      [/\blyric theat(?:re|er),? belfast\b/i, 'belfast'],
      [/\bgrand opera house,? belfast\b/i, 'belfast'],
      // Edinburgh Fringe venues
      [/\bpleasance (?:courtyard|dome)\b/i, 'edinburgh-fringe'],
      [/\bassembly (?:roxy|george square|rooms)\b/i, 'edinburgh-fringe'],
      [/\bsummerhall\b/i, 'edinburgh-fringe'],
      [/\bgilded balloon\b/i, 'edinburgh-fringe'],
      [/\bunderbelly (?:cowgate|bristo square|george square)\b/i, 'edinburgh-fringe'],
      // Off-West End houses — pre-transfer tryouts, commonly confused with WE run
      [/\balmeida theat(?:re|er)\b/i, 'off-west-end'],
      [/\byoung vic\b/i, 'off-west-end'],
      [/\bdonmar warehouse\b/i, 'off-west-end'],
      [/\broyal court (?:theatre|jerwood)\b/i, 'off-west-end'],
      [/\bhampstead theat(?:re|er)\b/i, 'off-west-end'],
      [/\bkiln theat(?:re|er)\b/i, 'off-west-end'],
      [/\bmenier chocolate factory\b/i, 'off-west-end'],
      [/\bsouthwark playhouse\b/i, 'off-west-end'],
      [/\bkiln theat(?:re|er)\b/i, 'off-west-end'],
      [/\bbridge theat(?:re|er)\b/i, 'off-west-end'],
      [/\barcola theat(?:re|er)\b/i, 'off-west-end'],
      [/\bbush theat(?:re|er)\b/i, 'off-west-end'],
      [/\bprinces?['']? theat(?:re|er),? london\b/i, 'off-west-end'],
      // Broadway (same-title cross-market)
      [/\b(?:broadway|new york)(?:['']s)?\s+(?:shubert|imperial|marquis|winter garden|booth|walter kerr|music box|august wilson|hudson|nederlander|broadhurst|belasco|eugene o['']neill|lyceum|gerald schoenfeld|bernard b\.? jacobs|john golden|lyric|majestic|minskoff|neil simon|new amsterdam|palace|richard rodgers|vivian beaumont|circle in the square|gershwin|american airlines|todd haimes|st\.? james|helen hayes|hayes theat|stephen sondheim|james earl jones|lena horne|ethel barrymore|al hirschfeld|samuel j\.? friedman|studio 54)\b/i, 'broadway'],
    ],

    // West End home cities
    homeCityRegex: /(?:london|west[\s-]?end)/i,
  },
};

const cfg = MARKET_CONFIG[MARKET];

// ============================================================
// Heuristic Signals (market-driven via cfg)
// ============================================================

function regionalOutletSignal(review) {
  const oid = review.outletId
    || (review.outlet || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const oi = outletInfo[oid];
  if (!oi || oi.isDual) return null;
  if (!oi.region) return null;
  if (cfg.correctRegions.has(oi.region.toLowerCase())) return null;
  return `regional-outlet:${oi.region}`;
}

function regionalOutletNameSignal(review) {
  const oid = review.outletId || '';
  const oname = (review.outlet || '').toLowerCase();
  for (const [re, region] of cfg.regionalNamePatterns) {
    if (re.test(oname) || re.test(oid)) return `regional-outlet-name:${region}`;
  }
  return null;
}

function tourPhraseSignal(text) {
  if (!text) return null;
  for (const re of cfg.tourPhrases) {
    if (re.test(text)) return `tour-phrase:${re.source.replace(/\\b/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '').trim().slice(0, 40)}`;
  }
  return null;
}

function venueSignal(text) {
  if (!text) return null;
  for (const [re, label] of cfg.nonHomeVenues) {
    if (re.test(text)) return `non-home-venue:${label}`;
  }
  return null;
}

function proximitySignal(text) {
  if (!text) return null;
  const m = text.match(/\b(?:theatre|theater),?\s+in\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (m) {
    const city = m[1];
    if (!cfg.homeCityRegex.test(city)) {
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
    model: CLAUDE_HAIKU,
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
    model: GPT4O_MINI,
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
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
// Market-Aware Verification Prompts
// ============================================================

const SYSTEM_PROMPTS = {
  broadway: `You are a content verification assistant for a Broadway theater review database. Your job is to determine whether a given review is about the BROADWAY production it is currently filed under, or about a DIFFERENT production of the same show — specifically a national tour, a regional/out-of-town production, an Off-Broadway run, or a West End/London staging.

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
- Mentions a Broadway venue: Imperial, Shubert, Marquis, Booth, Walter Kerr, Music Box, August Wilson, Hudson, Nederlander, Broadhurst, Belasco, Eugene O'Neill, Lyceum, Gerald Schoenfeld, Bernard Jacobs, Helen Hayes/Hayes Theater, John Golden, Lyric, Majestic, Minskoff, Neil Simon, New Amsterdam, Palace, Richard Rodgers, Vivian Beaumont, Winter Garden, Circle in the Square, Gershwin, **American Airlines Theatre** (also known as **Todd Haimes Theatre** — Roundabout's Broadway venue at 227 W 42nd St — DO NOT confuse with anything in DC even if the byline is Washington Post), James Earl Jones (formerly Cort), Lena Horne (formerly Brooks Atkinson), Stephen Sondheim (formerly Henry Miller's), August Wilson (formerly Virginia), Samuel J. Friedman (formerly Biltmore), Lunt-Fontanne, Ethel Barrymore, Studio 54, Al Hirschfeld (formerly Martin Beck), St. James, etc.
- **Important:** The OUTLET location (Washington Post, LA Times, Chicago Tribune) does NOT determine the production location. Many out-of-town newspapers have Broadway critics. Peter Marks (Washington Post), Chris Jones (Chicago Tribune), Charles McNulty (LA Times), Jesse Green (NYT), and many others write Broadway reviews from NYC.
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
- **CRITICAL EDGE CASE — touring company playing AT a Broadway theatre:** Sometimes a Broadway show entry IS a touring company doing a limited engagement at a Broadway venue (e.g., Mamma Mia 2025 at Winter Garden, The Wiz 2024 at Marquis). Critics may write "the national tour has settled into the [Broadway theatre]" or "this is a touring production playing on Broadway." This is CORRECT — the Broadway show entry represents that specific limited engagement. The KEY signal: if the venue named in the review is a known BROADWAY theatre (Winter Garden, Marquis, Imperial, Booth, etc.), it's CORRECT regardless of whether the production is described as "touring." Only flag WRONG_PRODUCTION when the venue is explicitly NON-NYC (Curran SF, Ahmanson LA, Kennedy Center DC, Goodman Chicago, Cadillac Palace Chicago, etc.).
- **Pre-Broadway tryouts** (Chicago Shakespeare, Goodman Theatre, Kennedy Center, La Jolla Playhouse, Old Globe, Mark Taper Forum, ART Cambridge, etc.) reviewed BEFORE the Broadway transfer ARE wrong-production for the Broadway entry. Even if the same show later moved to Broadway, the tryout review describes the pre-Broadway venue and pre-Broadway version.

Return ONLY a JSON object (no markdown, no commentary):
{"verdict": "WRONG_PRODUCTION|CORRECT|UNCERTAIN", "confidence": "high|medium|low", "venue": "<non-NYC venue if identified, else null>", "tourLabel": "<e.g. 'San Francisco run', 'National tour', 'Cape Cod tryout', else null>", "reasoning": "<1-2 sentences citing the strongest signal>"}`,

  'west-end': `You are a content verification assistant for a West End (London) theater review database. Your job is to determine whether a given review is about the WEST END production it is currently filed under, or about a DIFFERENT production of the same show — specifically a UK regional production, Edinburgh Fringe run, UK national tour stop, a pre-West-End tryout at an Off-West-End venue (Almeida, Young Vic, Donmar, Royal Court, Hampstead, etc.), or a Broadway/New York staging.

You will be given:
- The West End show title and the production's opening year
- The outlet, critic, publish date
- A list of audit signals that flagged this review as suspect (regional UK outlet, UK tour phrases, non-London venues, etc.)
- The review text

CLASSIFICATION RULES:
- "WRONG_PRODUCTION" = the review is clearly about a non-West-End production (UK tour stop, UK regional theatre, Edinburgh Fringe, pre-WE tryout at OWE venue, Broadway, etc.)
- "CORRECT" = the review is about the West End production it's filed under (even if it briefly mentions other productions in passing)
- "UNCERTAIN" = signals exist but text is ambiguous or insufficient

KEY POSITIVE INDICATORS (suggests CORRECT — review IS about the West End production):
- Mentions a West End venue: Palace, Apollo, Lyceum London, Dominion, Savoy, Noel Coward, Prince of Wales, His/Her Majesty's, Novello, Phoenix, Piccadilly, Cambridge, Shaftesbury, Victoria Palace, Theatre Royal Drury Lane, Theatre Royal Haymarket, Gillian Lynne, Adelphi, Aldwych, Lyric (Shaftesbury), Duke of York's, Vaudeville, Garrick, Harold Pinter, Trafalgar, Fortune, Duchess, Ambassadors, St Martin's, Wyndham's, Gielgud, Queen's/Sondheim, Apollo Victoria, London Palladium, @sohoplace, Old Vic (note: The Old Vic is classified as West End on this site — treat as CORRECT venue)
- **Important:** The OUTLET being UK-based does NOT by itself mean the review is about the West End. Many UK outlets also cover touring and regional productions. Look at the VENUE named in the body.
- Says "West End" + a credit specific to the London run (named cast, opening, "now in the West End", "London revival")
- Published within ~14 days of the West End opening night
- The byline is a recognized London theatre critic (Dominic Cavendish/Telegraph, Matt Wolf/London Theatre, Michael Billington/Guardian, Mark Shenton, etc.)

KEY NEGATIVE INDICATORS (suggests WRONG_PRODUCTION — review is NOT about the West End production):
- Names a specific non-London UK theatre as the venue: Chichester Festival Theatre/Minerva, Bristol Old Vic, Sheffield Crucible, Manchester Royal Exchange, Leeds Playhouse, Birmingham Rep, Nottingham Playhouse, Liverpool Everyman, Theatre Royal Bath, Curve Leicester, Royal Lyceum Edinburgh, Traverse Edinburgh, Citizens Theatre Glasgow, Wales Millennium Centre Cardiff, Lyric Belfast, etc.
- Says "UK tour", "UK touring", "national tour" (in UK context), "transferred from Chichester/Sheffield/etc.", "opened at the Bristol Old Vic before transferring"
- Mentions Edinburgh Fringe or Edinburgh International Festival venues (Pleasance, Assembly, Summerhall, Gilded Balloon, Underbelly)
- **Pre-West-End tryouts at Off-West-End houses:** A review at the Almeida, Young Vic, Donmar Warehouse, Royal Court, Hampstead Theatre, Menier Chocolate Factory, Southwark Playhouse, or Bridge Theatre BEFORE the West End transfer IS wrong-production for the West End entry. Even if the same show later moved to the West End, the tryout review describes the pre-transfer version at a different venue.
- Is a year-end UK regional theatre roundup that mentions a West End show in passing
- Reviews the Broadway production (named US cast, "at the [Broadway venue]", "New York —" dateline)

CRITICAL NUANCES:
- A UK critic writing from a "CHICHESTER —" or "SHEFFIELD —" dateline is reviewing the regional production, NOT the West End transfer. WRONG_PRODUCTION.
- A Guardian or Telegraph review of the West End opening is CORRECT even though Guardian/Telegraph also cover regional UK. Look at the venue named in the body.
- Boilerplate share buttons, footers, related-article snippets, navigation links can mention other productions — IGNORE these. Look at what the article ACTUALLY discusses.
- A passing mention of "the original Broadway production" or "the earlier Chichester run" in an otherwise-West-End review is NOT wrong-production.
- **Touring company doing a limited West End engagement:** Sometimes a West End show entry IS a touring company doing a limited run at a West End venue. If the venue named is a West End theatre, lean CORRECT regardless of whether the production is described as "touring."
- **The Old Vic and Sadler's Wells** — this site classifies The Old Vic as West End, Sadler's Wells varies. Treat reviews naming The Old Vic as the venue as CORRECT for West End shows.

Return ONLY a JSON object (no markdown, no commentary):
{"verdict": "WRONG_PRODUCTION|CORRECT|UNCERTAIN", "confidence": "high|medium|low", "venue": "<non-London venue if identified, else null>", "tourLabel": "<e.g. 'Chichester pre-WE tryout', 'UK national tour', 'Edinburgh Fringe', 'Broadway transfer', else null>", "reasoning": "<1-2 sentences citing the strongest signal>"}`,
};

const SYSTEM_PROMPT = SYSTEM_PROMPTS[MARKET];

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

  const marketLabel = MARKET === 'west-end' ? 'WEST END' : 'BROADWAY';
  return `${marketLabel} SHOW: "${showTitle}"
FILED UNDER: ${item.showId}
${marketLabel} VENUE: ${venue}
${marketLabel} OPENING YEAR: ${showYear}
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
  const marketShows = showsData.shows.filter(cfg.showFilter);

  const candidates = [];
  for (const show of marketShows) {
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
// Score-Impact Preflight
// ============================================================

// Mirrors src/config/score-buckets.ts MIN_REVIEWS_FOR_SCORE_*. Kept inline so the
// audit script doesn't need a TS import. If those constants change, update here too.
const MIN_REVIEWS = {
  broadway: 5,
  'west-end': 5,
  'off-broadway': 3,
  'off-west-end': 3,
};

function getScoreableCount(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Mirror isScoreable() filter — these flags exclude reviews from scoring
      if (r.wrongProduction || r.wrongShow || r.wrongAttribution) continue;
      if (r.duplicateOf) continue;
      if (r.contentTier === 'invalid') continue;
      if (r.isRoundupArticle) continue;
      count++;
    } catch {}
  }
  return count;
}

function computeScoreImpact(wrongVerdicts) {
  // Group by show
  const byShow = {};
  for (const v of wrongVerdicts) {
    if (!byShow[v.showId]) byShow[v.showId] = [];
    byShow[v.showId].push(v);
  }

  const wouldRemainScored = [];
  const alreadyTBD = [];
  const wouldBecomeTBD = [];

  for (const [showId, flags] of Object.entries(byShow)) {
    const show = showById.get(showId);
    if (!show) continue;
    const cat = show.category || 'broadway';
    const threshold = MIN_REVIEWS[cat] ?? 5;

    const before = getScoreableCount(showId);
    const after = Math.max(0, before - flags.length);
    const wasScored = before >= threshold;
    const willBeScored = after >= threshold;

    const entry = { showId, category: cat, threshold, before, after, flagsApplied: flags.length };
    if (!wasScored) alreadyTBD.push(entry);
    else if (willBeScored) wouldRemainScored.push(entry);
    else wouldBecomeTBD.push(entry);
  }

  return { wouldRemainScored, alreadyTBD, wouldBecomeTBD };
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
  // Honor manual clears — don't re-flag a human-verified review.
  if (shouldSkipWrongProductionAudit(data)) return false;

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
  console.log(`=== Touring/Out-of-Market Contamination Audit (${MARKET}) ===`);
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
          // Note: apply moved to after-loop second pass so the score-impact
          // preflight can run on the full verdict set first.
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

  // ============================================================
  // Score-impact preflight + apply pass
  // ============================================================
  const wrongHigh = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'high');
  const wrongMed = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'medium');
  const wrongLow = results.filter(r => r.verdict === 'WRONG_PRODUCTION' && r.confidence === 'low');

  const impact = computeScoreImpact(wrongHigh);
  console.log('\n=== SCORE IMPACT (high-confidence verdicts only) ===');
  console.log(`Affected shows total:               ${impact.wouldRemainScored.length + impact.alreadyTBD.length + impact.wouldBecomeTBD.length}`);
  console.log(`  Will remain scored:               ${impact.wouldRemainScored.length}`);
  console.log(`  Already TBD (no visible change):  ${impact.alreadyTBD.length}`);
  console.log(`  Newly TBD (regression):           ${impact.wouldBecomeTBD.length}`);
  if (impact.wouldBecomeTBD.length > 0) {
    console.log('\nShows that would lose their displayed score:');
    impact.wouldBecomeTBD
      .sort((a, b) => (b.before - b.after) - (a.before - a.after))
      .forEach(e => console.log(`  ${e.showId} [${e.category}]: ${e.before} → ${e.after} reviews (need ${e.threshold}+, dropping ${e.flagsApplied})`));
  }

  if (APPLY && impact.wouldBecomeTBD.length > 0 && !ALLOW_TBD_REGRESSIONS) {
    console.error(`\nERROR: --apply blocked. ${impact.wouldBecomeTBD.length} shows would fall below the hasEnoughReviews() threshold and lose their displayed score.`);
    console.error('To proceed, either:');
    console.error('  1. Re-run with --allow-tbd-regressions to accept the regressions');
    console.error('  2. Use --show=ID to apply per-show, manually backfilling reviews for affected shows first');
    console.error('  3. Inspect the verdicts for those shows in the report and confirm they are legitimate before allowing');
    process.exit(2);
  }

  // Apply pass — high-confidence verdicts only
  if (APPLY) {
    for (const v of wrongHigh) {
      // Need an item-shaped object for applyFlag (it expects { showId, file })
      if (applyFlag({ showId: v.showId, file: v.file }, {
        venue: v.venue,
        tourLabel: v.tourLabel,
        reasoning: v.reasoning,
      })) {
        stats.appliedFlag++;
      }
    }
  }

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
      scoreImpact: {
        wouldRemainScoredCount: impact.wouldRemainScored.length,
        alreadyTBDCount: impact.alreadyTBD.length,
        wouldBecomeTBDCount: impact.wouldBecomeTBD.length,
        wouldBecomeTBDShows: impact.wouldBecomeTBD,
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
