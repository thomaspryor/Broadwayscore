#!/usr/bin/env node
/**
 * verify-image.js
 *
 * Shared Gemini 2.0 Flash vision verification module.
 * Verifies that a Broadway show image matches the correct production.
 *
 * Key improvement over audit-images-llm.js: production-year-aware prompt
 * that catches wrong-production errors (BAM Hamlet vs Broadway Hamlet,
 * Cats 1982 vs Jellicle Ball 2024, etc.)
 *
 * Usage:
 *   const { verifyImage, createRateLimiter } = require('./lib/verify-image');
 *   const result = await verifyImage(imageBuffer, 'Hamlet', { year: '2009' });
 *   // result: { match: true|false, confidence: 'high'|'medium'|'low', description, issues[] }
 */

const fs = require('fs');
const path = require('path');
const { GEMINI_FLASH } = require('./models');
const { getMarketLabel } = require('./market-label');

// ============================================================
// CONFIG
// ============================================================

const RPM_LIMIT = 15;       // Gemini Flash free tier supports 15 RPM
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

// ============================================================
// MARKET PROFILES
// ============================================================
//
// The venue rules below used to be hardcoded to Broadway: the prompt told
// Gemini to reject any image showing a "non-Broadway venue name". For a West
// End, Off-West-End, Off-Broadway or regional show the CORRECT key art names
// exactly those venues, so the verifier rejected real posters and the show
// shipped with no image at all — 26 open/upcoming shows were imageless on
// 2026-08-02, including Brainiac Live (Garrick Theatre) live on the homepage.
// Observed rejections from fetch-all-image-formats run 30521108947:
//   "Martin Guerre ... AT THE OLD VIC, which is a non-Broadway venue"
//   "The Pianist ... PARK 200 ... non-Broadway production"
//   "Work of Devotion ... Pershing Square Signature Center ... Off-Broadway venue"
// Same class as scripts/lib/market-label.js (review prompts) and
// scripts/lib/opera-prompt-context.js — see memory/feedback_llm_prompts_market_aware.md.
//
// Each profile answers two questions for its market: which venue/company
// branding is EXPECTED on a correct poster, and what a genuine cross-market
// mismatch would look like.

const MARKET_PROFILES = {
  broadway: {
    expected: 'Broadway theatres in New York City (Music Box, Lyceum, Shubert, Eugene O\'Neill, Broadhurst, Booth, Majestic, Nederlander, etc.)',
    mismatch: 'a London/West End theatre, "BAM", "State Theatre New Jersey", a US regional playhouse (Berkeley Rep, Goodman Theatre, Arena Stage, Seattle Rep, CenterREP), an Off-Broadway house, or any regional, community, or touring company branding (e.g. "Gallery Players")',
    acceptCompanies: 'Manhattan Theatre Club (MTC), Lincoln Center Theater (LCT), Roundabout Theatre Company, Second Stage Theater, The New Group — these ARE Broadway producers and their logos do NOT mean a non-Broadway production',
    tourRule: true,
  },
  'off-broadway': {
    expected: 'New York City Off-Broadway and non-profit houses (The Public Theater, Pershing Square Signature Center, Atlantic Theater Company, Playwrights Horizons, Vineyard Theatre, MCC, Second Stage, New World Stages, Lucille Lortel, Cherry Lane, Minetta Lane, 59E59, Classic Stage, Soho Rep, Ars Nova, BAM, St. Ann\'s Warehouse, Joe\'s Pub, The Shed, Theatre Row, Irish Rep, etc.). A Broadway theatre name is also fine (transfers).',
    mismatch: 'a London theatre or a US regional playhouse outside New York',
    acceptCompanies: 'any New York producing company or non-profit — an Off-Broadway or non-profit company logo is EXPECTED here, never a reason to reject',
    tourRule: true,
  },
  'west-end': {
    expected: 'London West End theatres (the Old Vic, Garrick, Wyndham\'s, Theatre Royal Haymarket, Noel Coward, Gielgud, Palladium, Sondheim, Dominion, Apollo, Savoy, Adelphi, Duke of York\'s, National Theatre, Charing Cross Theatre, etc.)',
    mismatch: 'a Broadway/New York theatre marquee or a US regional playhouse',
    acceptCompanies: 'any London producing house or company (National Theatre, Royal Shakespeare Company, Donmar Warehouse, Nimax, Delfont Mackintosh, ATG) — London venue and company branding is EXPECTED here, never a reason to reject',
    tourRule: true,
  },
  'off-west-end': {
    expected: 'London fringe / Off-West-End theatres (Bush Theatre, Park Theatre, Southwark Playhouse, Almeida, Young Vic, Arcola, Kiln, Hampstead, Menier Chocolate Factory, Royal Court, Soho Theatre, Finborough, Jermyn Street, Riverside Studios, Omnibus, Wilton\'s Music Hall, etc.). A West End theatre name is also fine.',
    mismatch: 'a Broadway/New York theatre marquee or a US regional playhouse',
    acceptCompanies: 'any London producing house or fringe company — London venue and company branding is EXPECTED here, never a reason to reject',
    tourRule: true,
  },
  // Unknown/absent slug. Never assert venue expectations we cannot justify:
  // the old fallback handed Broadway reject rules to a show the prompt had just
  // described as e.g. "(dublin-fringe)", which is exactly the mislabel this
  // whole module exists to stop. Venue checking is simply disabled here; the
  // wrong-show / placeholder / production-still rules still apply.
  __venue_agnostic__: {
    expected: 'whatever venue or producing company this production actually plays — no venue expectation is asserted for this market',
    mismatch: 'NOTHING — do not reject on venue or company branding at all for this production; judge only by whether the artwork is for this show',
    acceptCompanies: 'any venue or company branding — venue text is not evidence of a mismatch for this production',
    tourRule: false,
  },
  regional: {
    expected: 'the production\'s own US regional theater and resident company (La Jolla Playhouse, Two River Theater, Arena Stage, Goodman Theatre, Berkeley Rep, Old Globe, A.R.T., Alliance Theatre, Paper Mill Playhouse, Center Theatre Group, etc.)',
    mismatch: 'a Broadway theatre marquee or a London/West End theatre',
    acceptCompanies: 'regional and resident-company branding is EXPECTED here — a regional theater logo is the CORRECT signal for this show, never a reason to reject',
    tourRule: false,
  },
};

/**
 * Resolve the venue-rule profile for a show's market/category slug.
 * An ABSENT slug keeps the historical Broadway behaviour; a PRESENT but
 * unrecognised slug gets the venue-agnostic `unknown` profile rather than
 * silently inheriting Broadway's reject rules.
 *
 * @param {string|null|undefined} market shows.json `category` (preferred) or `market`
 * @returns {object} profile from MARKET_PROFILES
 */
function getMarketProfile(market) {
  const key = String(market ?? '').trim().toLowerCase();
  if (MARKET_PROFILES[key]) return MARKET_PROFILES[key];
  // Absent slug = the historical Broadway default (every legacy caller was a
  // Broadway show). A PRESENT but unrecognised slug is a different situation:
  // silently applying Broadway venue rules to it is the mislabel bug, so it
  // gets the venue-agnostic profile.
  return key === '' ? MARKET_PROFILES.broadway : MARKET_PROFILES.__venue_agnostic__;
}

/**
 * Pick the most specific RECOGNISED slug from a show's (category, market) pair.
 * `category` is preferred because it is the finer vocabulary (it carries
 * off-broadway / off-west-end, which `market` does not), but only when it is a
 * slug we actually have rules for — otherwise a typo in `category` would throw
 * away a perfectly good `market` and disable venue checking entirely.
 *
 * @param {string|null|undefined} category shows.json `category`
 * @param {string|null|undefined} market shows.json `market`
 * @returns {string|undefined} the slug to hand to buildVerificationPrompt/verifyImage
 */
function resolveMarketSlug(category, market) {
  const cat = String(category ?? '').trim().toLowerCase();
  if (MARKET_PROFILES[cat]) return cat;
  const mkt = String(market ?? '').trim().toLowerCase();
  if (MARKET_PROFILES[mkt]) return mkt;
  return category || market || undefined;
}

// ============================================================
// PRODUCTION-YEAR-AWARE VERIFICATION PROMPT
// ============================================================

/**
 * Build the verification system prompt for a specific market.
 *
 * @param {object} opts
 * @param {string} [opts.market] shows.json category/market slug
 * @param {string} [opts.venue] the production's venue name, when known
 * @returns {string}
 */
function buildVerificationPrompt({ market, venue, creatives, strict } = {}) {
  const profile = getMarketProfile(market);
  const label = getMarketLabel(market, venue);
  const atVenue = venue ? ` at ${venue}` : '';
  creatives = creativesForPrompt(creatives, strict);
  const creativesLine = formatCreatives(creatives);
  // BRO-5022: without the authors, Beckett's "Endgame" and the Marvel film are
  // the same title to the model. Only a conflicting AUTHOR rejects: the list is
  // partial, so a headliner in the title ("Jamie Allan's AMAZE") or a director
  // the art doesn't name is no conflict.
  const hasAuthor = (Array.isArray(creatives) ? creatives : []).some(c => c && !isDirectorRole(c.role));
  const creativesBlock = creativesLine
    ? `\n\nTHE WORK: ${creativesLine}.${hasAuthor ? ' A poster or cover that credits a DIFFERENT playwright, author or composer for this title is a different work with the same name: REJECT it (issues ["wrong_show"]).' : ''} Our list is incomplete: a name that is not on it (a star or headliner, a magician whose name is in the title, a producer, a designer) is NOT a conflict.`
    : '';

  const venueRejectRule = `- The image names a THEATER or PRODUCING COMPANY belonging to a DIFFERENT market than this production. This is a ${label} production${atVenue}. Venue and company branding consistent with ${label} is EXPECTED on the poster and must be ACCEPTED — expected venues here are ${profile.expected}. Only reject on a genuine cross-market mismatch, e.g. ${profile.mismatch}.`;

  const tourRule = profile.tourRule
    ? '\n- The image is PRIMARILY focused on "National Tour", "US Tour", "UK Tour", or a touring itinerary of multiple cities. (Small-print tour mentions on an otherwise correct poster are OK — only reject when tour branding is the main focus.)'
    : '\n- The image is PRIMARILY focused on a MULTI-CITY touring itinerary. (This production\'s own theater and city on the poster is expected, not tour branding.)';

  return `You are verifying promotional images for theater productions. I will show you an image that is supposed to be for a SPECIFIC ${label} production${atVenue}.

Your task: Look for EVIDENCE that this image is WRONG. Only reject when you see positive proof of a problem. When in doubt, ACCEPT.

REJECT (match=false) only when you see POSITIVE EVIDENCE of these problems:
- The image shows a DIFFERENT SHOW's title (e.g., image says "Hell's Kitchen" but the show is "Illinoise"). This is the most important check.
- The image shows the show's name but with EXTRA WORDS forming a MEANINGFULLY DIFFERENT title (e.g., "Cats: The Jellicle Ball" is NOT "Cats" — it's a completely different show). However, these additions are NOT different titles and must be ACCEPTED:
  * Generic show-type phrases: "The Musical", "A New Musical", "The Broadway Musical", "A Musical Comedy", "A Musical Fable", "A New Play", "A Memory Play"
  * Biographical/descriptive subtitles about the show's subject: "The Tina Turner Musical", "The Donna Summer Musical", "The Carole King Musical", "The Cher Show" — these describe WHO the show is about, not a different show
  * Playwright/author credits: "Noel Coward's [Show]", "Edward Albee's [Show]", "August Wilson's [Show]", "Dr. Seuss' [Show]", "A New Play by [Author]"
  * Star names in marketing: "[Star] in [Show]"
  * Official subtitles that are part of the full title: "In the Next Room or the vibrator play" — the subtitle IS part of the official show name
  * A SHORTER form of the title, without a generic word our listing adds ("AMAZE" or "Jamie Allan's AMAZE" for "AMAZE Magic", "Mamma Mia!" for "Mamma Mia! The Musical")
  * Marketing taglines or slogans (e.g., "Journey to the past", "Every Buddy's Favorite Holiday Musical", "A Great Big Broadway Show") — these are promotional text, not title changes
  Only reject when the added words create a genuinely DIFFERENT show (a separate production with different creative team, story, or concept).
${venueRejectRule}${tourRule}
- Community theater markers: school names, "Community Players", "Youth Production", amateur company logos
- A school, college or university production (a university theatre department, student company, campus news site or high-school drama club), even of the right play. Issue: community_theater
- Artwork for a FILM, TV series, book cover, video game, album or any other NON-STAGE work that shares the title (e.g. the "Avengers: Endgame" movie poster when the show is Samuel Beckett's play "Endgame"; a novel's cover when the show is a stage adaptation with its own key art). Issue: non_theatre_work. (A filmed or streamed version OF this staging is not a different work: see ACCEPT.)
- The image is clearly a "concert version" or "in concert" variant (visible text says "In Concert")
- The image is a generic placeholder: "Coming soon", stock photo, blank/solid color, website logo, app icon
- The image shows a yellow PLAYBILL program cover (physical program photo, not promotional art)
- The image is a seating chart, venue map, ticket listing, or social media logo
- The image shows a completely different show's recognizable artwork or cast
- The image is a stand-alone closing ADVERTISEMENT with just text and no actual poster art (e.g., "MUST CLOSE MAY 26" in plain text, or "FINAL WEEKS" as the entire image without any show artwork)

ACCEPT (match=true) in these cases:
- Official poster art, key art, or promotional graphics showing the correct show title
- Show logos, stylized title treatments, or title cards with design elements
- Closing notice OVERLAID on the show's actual poster art (e.g., "FINAL WEEKS" banner on top of the real poster) — this is fine, the base image is still correct
- Venue or company branding for THIS market: ${profile.acceptCompanies}.
- The production's own theater name printed on the poster${venue ? ` — "${venue}" is this production's venue and is EXPECTED` : ''}. A correct venue name is never a reason to reject.
- Originating company credits: "National Theatre", "Royal Shakespeare Company", "Donmar Warehouse", "Chichester Festival Theatre", "Steppenwolf" on an otherwise correct poster — ACCEPT. Productions transfer between houses and co-produce, and the poster credits the original producer.
- A filmed, streamed, cinema-release or "studio audience" version of THIS staging (e.g. the film poster of a recorded West End musical, NT Live, a theatre's streamed performances): it is this production's art, even when the page is IMDb or its dates fall just after the run.
- The published playtext cover of this play (Nick Hern Books, Methuen Drama, Oberon, Faber, Samuel French): it is the work's own art.
- Promotional art that is clearly for the correct show even if the title text is small, stylized, or partially obscured — judge by the overall artwork/branding, not just readable text
- You cannot determine whether the image is from this specific production year vs another year — ACCEPT (benefit of the doubt)

REJECT production photos (match=false, imageType="production_still"):
- Photos showing actors performing on stage during a show
- Rehearsal photos, backstage photos
- Cast photos taken during performance (not promotional portraits)
These are NOT suitable as show thumbnails — we want poster art, not performance photos.

KEY PRINCIPLE: If the image title matches the show title and there's no visible evidence of a wrong venue/production, ACCEPT IT. Do not reject just because you can't confirm the exact year.

Reply with ONLY this JSON (no markdown fencing, no explanation):
{"match":true,"confidence":"high","description":"brief description of what the image shows","issues":[],"imageType":"promotional_art"}

Or if there's a problem:
{"match":false,"confidence":"high","description":"brief description of what the image actually shows","issues":["category"],"imageType":"other"}

Issue categories: wrong_show, wrong_production, non_theatre_work, non_broadway, regional_production, community_theater, closing_ad, placeholder, playbill_cover, seating_chart, generic_image, social_media_logo, ticket_listing, venue_photo, production_photo

Also classify the image type. Add an "imageType" field to your JSON response:
- "promotional_art" — Official poster, key art, logo treatment, title card with stylized design, marketing material
- "production_still" — Photo from actual stage performance, rehearsal, or backstage
- "headshot_cast" — Individual actor headshot or cast photo not from the show itself
- "other" — Anything else (venue exterior, playbill, generic)

Confidence levels:
- "high": You are very sure of your assessment
- "medium": You think you're right but aren't certain
- "low": You're guessing${creativesBlock}${strict ? STRICT_BLOCK : ''}`;
}

// BRO-5022: the Google Images tier for a CLOSED show searches on the title
// alone, so its hits are dominated by same-title films, other companies'
// stagings and later revivals. Benefit of the doubt is what let those through.
// This block overrides the "when in doubt, ACCEPT" rules above, and the caller
// (applyStrictVerdict) refuses anything without positive evidence.
const STRICT_BLOCK = `

STRICT MODE (overrides "when in doubt, ACCEPT" and "benefit of the doubt" above): this image came from a web image search on the title alone. Results for a title search are often a same-title film, book or game, another company's staging of the same play (a school, a regional or foreign company), or a later revival. Do NOT give benefit of the doubt.
Add two fields to your JSON:
- "workConfirmed": true ONLY if the image or the source page positively shows it is THIS stage work: the author's or composer's name, this production's venue, a credited creative or cast member of this production, or a source page clearly about this production. A title alone is NOT confirmation. Otherwise false.
- "productionMatch": "this" if the image or source page ties it to THIS production (its venue, its year, its creatives or cast); "other" if it ties it to a DIFFERENT production (another venue, company, city, school, country, or performance dates in a different year); "unknown" if nothing says either way. Dates a few weeks outside this run at the same venue or company (previews, an extension, a streamed or studio-audience performance) are still "this". An originating or co-producing theatre's logo, or a playtext cover, is not by itself "other".`;

// Creative-team context for the prompt: "Samuel Beckett (playwright); ...".
// Accepts strings or {name, role} objects (shows.json creativeTeam shape).
function formatCreatives(creatives) {
  if (!Array.isArray(creatives)) return '';
  const parts = [];
  for (const c of creatives) {
    if (!c) continue;
    const name = typeof c === 'string' ? c : c.name;
    if (!name || typeof name !== 'string') continue;
    const role = typeof c === 'object' && c.role ? ` (${String(c.role).toLowerCase()})` : '';
    const entry = `${name.trim()}${role}`;
    if (!parts.includes(entry)) parts.push(entry);
    if (parts.length >= 6) break;
  }
  return parts.length ? `the stage work by ${parts.join('; ')}` : '';
}

// A director alone says nothing about which WORK this is, and naming only
// the director primed the model to reject "Jamie Allan's AMAZE" on the AMAZE
// row (BRO-5022 A/B). Strict mode keeps it: there a director credit is
// positive evidence for this production.
function creativesForPrompt(creatives, strict) {
  if (!Array.isArray(creatives) || strict) return creatives;
  return creatives.some(c => c && typeof c === 'object' && !isDirectorRole(c.role)) || creatives.some(c => typeof c === 'string')
    ? creatives
    : [];
}

const isDirectorRole = (role) => /director/i.test(String(role || '')) && !/music(al)? director/i.test(String(role || ''));

// Roles that identify the WORK (authors) or THIS staging (director). Cast and
// designers rarely appear on art and would only dilute the line.
const WORK_ROLE_RE = /playwright|writer|book|music|lyric|composer|author|adapt|director/i;

// shows.json creativeTeam -> the subset the verifier is told about.
function creativesForVerify(show) {
  const team = Array.isArray(show && show.creativeTeam) ? show.creativeTeam : [];
  return team.filter(c => c && c.name && WORK_ROLE_RE.test(String(c.role || '')));
}

/**
 * Final accept/reject for a verify result (pure; BRO-5022).
 * Non-strict: unchanged legacy behaviour (low-confidence rejections and API
 * errors fail open). Strict: accept only a match with positive evidence of the
 * work and no evidence of another production; anything else is a rejection,
 * EXCEPT a verifier error, which is reported as `errored` so callers never
 * record "no reliable art" because Gemini was down.
 * @returns {{accept: boolean, errored: boolean, reason: string}}
 */
function applyStrictVerdict(result, { strict = false } = {}) {
  const r = result || {};
  const errored = (r.issues || []).some(i => ['api_error', 'download_error', 'parse_error', 'invalid_input'].includes(i))
    || r.confidence === 'error' || r.match === null || r.skipped === true;
  if (!strict) {
    if (r.match === true) return { accept: true, errored: false, reason: 'match' };
    if (r.match === false && (r.confidence === 'high' || r.confidence === 'medium')) return { accept: false, errored: false, reason: 'rejected' };
    return { accept: true, errored, reason: 'uncertain-fail-open' };
  }
  if (errored) return { accept: false, errored: true, reason: 'verifier-error' };
  if (r.match !== true) return { accept: false, errored: false, reason: 'rejected' };
  if (r.strictFieldsMissing === true) return { accept: false, errored: true, reason: 'strict-fields-missing' };
  if (r.confidence === 'low') return { accept: false, errored: false, reason: 'low-confidence' };
  if (r.productionMatch === 'other') return { accept: false, errored: false, reason: 'other-production' };
  if (r.workConfirmed !== true) return { accept: false, errored: false, reason: 'work-not-confirmed' };
  return { accept: true, errored: false, reason: 'confirmed' };
}

// ============================================================
// RATE LIMITER
// ============================================================

class RateLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.timestamps = [];
  }

  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    if (this.timestamps.length >= this.rpm) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 100;
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    this.timestamps.push(Date.now());
  }
}

// ============================================================
// GEMINI CLIENT (lazy-initialized)
// ============================================================

let geminiModel = null;
let initAttempted = false;

function getGeminiModel() {
  if (geminiModel) return geminiModel;
  if (initAttempted) return null;
  initAttempted = true;

  let apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf8').match(/GEMINI_API_KEY=(.+)/);
      if (match) {
        apiKey = match[1].trim();
        process.env.GEMINI_API_KEY = apiKey;
      }
    }
  }

  if (!apiKey) return null;

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  geminiModel = genAI.getGenerativeModel({
    model: GEMINI_FLASH,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 }, // 2.5-flash thinking eats the budget; see feedback_gemini_thinking_token_budget
    }
  });
  return geminiModel;
}

// ============================================================
// RESPONSE PARSER
// ============================================================

function parseResponse(text) {
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      match: Boolean(parsed.match),
      confidence: parsed.confidence || 'low',
      description: parsed.description || '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      imageType: parsed.imageType || 'other',
      workConfirmed: parsed.workConfirmed === true,
      // Strict fields absent (schema drift, truncated reply): applyStrictVerdict treats a
      // match as an error, so a garbled answer never counts as a rejection.
      strictFieldsMissing: typeof parsed.workConfirmed !== 'boolean',
      productionMatch: ['this', 'other', 'unknown'].includes(parsed.productionMatch) ? parsed.productionMatch : 'unknown',
    };
  } catch {
    const matchResult = /\"match\"\s*:\s*(true|false)/i.exec(cleaned);
    const confResult = /\"confidence\"\s*:\s*\"(high|medium|low)\"/i.exec(cleaned);
    const descResult = /\"description\"\s*:\s*\"([^\"]*)\"/i.exec(cleaned);
    const typeResult = /\"imageType\"\s*:\s*\"(promotional_art|production_still|headshot_cast|other)\"/i.exec(cleaned);
    if (matchResult) {
      return {
        match: matchResult[1] === 'true',
        confidence: confResult?.[1] || 'low',
        description: descResult?.[1] || 'Could not fully parse response',
        issues: [],
        imageType: typeResult?.[1] || 'other',
        strictFieldsMissing: true,
      };
    }
    return {
      match: null,
      confidence: 'error',
      description: `Unparseable response: ${cleaned.substring(0, 200)}`,
      issues: ['parse_error'],
      imageType: 'other',
    };
  }
}

// ============================================================
// MIME TYPE DETECTION
// ============================================================

function getMimeType(urlOrPath) {
  const lower = (urlOrPath || '').toLowerCase().split('?')[0];
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.includes('fm=webp')) return 'image/webp';
  return 'image/jpeg';
}

// ============================================================
// MAIN VERIFICATION FUNCTION
// ============================================================

// The per-image half of the prompt. Pure, so tests can assert on it.
// options.pageDomain / pageTitle / pageUrl: where a search hit was found (a
// university news site or a film blog usually names the wrong work outright;
// m.facebook.com alone hides that the page is the Old Vic's own).
const pageRef = (url) => String(url).replace(/^google-images:/, '').replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').slice(0, 160);
function buildUserPrompt(showTitle, options = {}) {
  const year = options.year || (options.openingDate ? String(options.openingDate).substring(0, 4) : null);
  const marketLabel = options.marketLabel || getMarketLabel(options.market, options.venue);
  const venueSuffix = options.venueSuffix !== undefined ? options.venueSuffix : (options.venue ? ` at ${options.venue}` : '');
  let prompt = year
    ? `The ${marketLabel} production is: "${showTitle}" (${year})${venueSuffix}\nThe title is "${showTitle}". If the image shows a COMPLETELY DIFFERENT show name (e.g., "The Thanksgiving Play" instead of "Cult of Love"), REJECT it. But if the image shows "${showTitle}" with added marketing text, subtitles like "The Musical" or a biographical descriptor, playwright credits, or taglines — that is still the SAME show. Apply all REJECT/ACCEPT rules from the system prompt.`
    : `The ${marketLabel} show is: "${showTitle}"${venueSuffix}\nThe title is "${showTitle}". If the image shows a COMPLETELY DIFFERENT show name, REJECT it. But if the image shows "${showTitle}" with added marketing text, subtitles, playwright credits, or taglines — that is still the SAME show. Apply all REJECT/ACCEPT rules.`;
  const creativesLine = formatCreatives(creativesForPrompt(options.creatives, options.strict));
  if (creativesLine) prompt += `\nCreative team: ${creativesLine.replace(/^the stage work by /, '')}.`;
  if (options.closingDate) prompt += `\nThis production ran ${options.openingDate ? `from ${options.openingDate} ` : ''}to ${options.closingDate}.`;
  if (options.pageDomain || options.pageTitle || options.pageUrl) {
    prompt += `\nThe image was found on: ${[options.pageUrl ? pageRef(options.pageUrl) : options.pageDomain, options.pageTitle ? `"${String(options.pageTitle).slice(0, 160)}"` : null].filter(Boolean).join(' — ')}. Use the source page as evidence of which work and production the image is for.`;
  }
  prompt += year
    ? `\nIs this image correct promotional art for this specific ${year} ${marketLabel} production?`
    : `\nIs this image a correct promotional image for this show?`;
  return prompt;
}

/**
 * Verify that an image matches a specific Broadway production.
 *
 * @param {Buffer|string} imageInput - Image data (Buffer) or URL (string, auto-downloaded)
 * @param {string} showTitle - Show title (e.g., "Hamlet")
 * @param {object} options
 * @param {string} options.year - Production year (e.g., "2009")
 * @param {string} options.openingDate - Full opening date (year extracted if options.year not set)
 * @param {string} options.market - shows.json `category` (preferred) or `market` slug.
 *   REQUIRED for anything that is not Broadway: omitting it frames the show as a
 *   Broadway production and the venue rules then reject correct West End /
 *   Off-Broadway / regional key art.
 * @param {string} options.venue - The production's venue, so a correct venue name
 *   on the poster reads as confirmation instead of a mismatch.
 * @param {Array} [options.creatives] - creativeTeam entries (or names) identifying the work (BRO-5022)
 * @param {string} [options.pageDomain] - domain of the page a search hit came from
 * @param {string} [options.pageTitle] - title of that page
 * @param {string} [options.pageUrl] - that page's URL (shown without query string)
 * @param {string} [options.closingDate] - run end, for closed productions
 * @param {boolean} [options.strict] - title-only search hit: require positive
 *   evidence (judge with applyStrictVerdict)
 * @param {RateLimiter} options.rateLimiter - Shared rate limiter instance
 * @returns {Promise<{match: boolean, confidence: string, description: string, issues: string[]}>}
 */
async function verifyImage(imageInput, showTitle, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    return {
      match: true,
      confidence: 'low',
      description: 'Verification skipped (no GEMINI_API_KEY)',
      issues: [],
      imageType: 'other',
      skipped: true,
    };
  }

  // Resolve production year
  const year = options.year
    || (options.openingDate ? options.openingDate.substring(0, 4) : null);

  // Market context — without it the prompt frames every show as Broadway and
  // rejects correct West End / Off-Broadway / regional key art (2026-08-02).
  const marketLabel = getMarketLabel(options.market, options.venue);
  const venueSuffix = options.venue ? ` at ${options.venue}` : '';
  // venue-write-guard-ok: venue only goes into the verifier prompt text, never written to data.
  const systemPrompt = buildVerificationPrompt({
    market: options.market, venue: options.venue, creatives: options.creatives, strict: options.strict,
  });
  const userPrompt = buildUserPrompt(showTitle, { ...options, year, marketLabel, venueSuffix });

  // Resolve image data
  let imageData;
  let mimeType;

  if (Buffer.isBuffer(imageInput)) {
    imageData = imageInput;
    mimeType = options.mimeType || 'image/jpeg';
  } else if (typeof imageInput === 'string') {
    // URL — download first (strip query params that can break Gemini's image download)
    let fetchUrl = imageInput;
    try {
      const parsed = new URL(imageInput);
      if (parsed.search) {
        fetchUrl = parsed.origin + parsed.pathname;
      }
    } catch { /* use original URL if parsing fails */ }

    try {
      const resp = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      });
      if (!resp.ok) {
        return {
          match: true, confidence: 'low',
          description: `Could not download image for verification: HTTP ${resp.status}`,
          issues: ['download_error'],
          imageType: 'other',
        };
      }
      imageData = Buffer.from(await resp.arrayBuffer());
      mimeType = resp.headers.get('content-type') || getMimeType(imageInput);
    } catch (err) {
      return {
        match: true, confidence: 'low',
        description: `Could not download image for verification: ${err.message}`,
        issues: ['download_error'],
        imageType: 'other',
      };
    }
  } else {
    return {
      match: true, confidence: 'low',
      description: 'Invalid image input type',
      issues: ['invalid_input'],
      imageType: 'other',
    };
  }

  // Pre-filter: reject tiny images (<2KB likely broken)
  if (imageData.length < 2000) {
    return {
      match: false, confidence: 'high',
      description: `Image too small (${imageData.length} bytes) — likely broken or placeholder`,
      issues: ['placeholder'],
      imageType: 'other',
    };
  }

  // Rate limit
  const rateLimiter = options.rateLimiter || new RateLimiter(RPM_LIMIT);
  await rateLimiter.wait();

  // Call Gemini with retry
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([
        { text: systemPrompt + '\n\n' + userPrompt },
        {
          inlineData: {
            data: imageData.toString('base64'),
            mimeType: mimeType,
          }
        }
      ]);

      const text = result.response.text().trim();
      return parseResponse(text);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  // Fail open on API errors
  return {
    match: true,
    confidence: 'low',
    description: `Verification failed after ${MAX_RETRIES} retries: ${lastError?.message}`,
    issues: ['api_error'],
    imageType: 'other',
  };
}

// ============================================================
// URL HEURISTIC CLASSIFICATION
// ============================================================

// ============================================================
// ENGAGEMENT STAMP (national tours, BRO-4726)
// ============================================================

const ENGAGEMENT_STAMP_PROMPT = `This image will be the key art on a web page for a NATIONAL TOUR that plays many cities. Presenters often re-upload the tour's art with their own engagement printed on it.

Does the image show text that belongs to ONE engagement only?
- performance dates or a date range (e.g. "JAN 26-31", "October 20 - November 1", "Sept 22 - Oct 11")
- a specific venue's or presenter's name or logo (e.g. "Segerstrom Center for the Arts", "Broadway in Chicago", "Fox Theatre")
- a single city name as the place it plays

These do NOT count: the show title, taglines, award mentions ("Tony-winning"), author or star credits, "National Tour", "10th Anniversary", "Disney".

Reply with ONLY this JSON (no markdown fencing):
{"stamped":true,"text":"the engagement-specific text you see"}
or
{"stamped":false,"text":""}`;

/** 'true'/'false' from a stamp reply, or null when it cannot be read. */
function parseStampResponse(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try {
    const parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned);
    if (typeof parsed.stamped === 'boolean') return { stamped: parsed.stamped, text: String(parsed.text || '') };
  } catch { /* fall through */ }
  const m = /"stamped"\s*:\s*(true|false)/i.exec(cleaned);
  return m ? { stamped: m[1].toLowerCase() === 'true', text: '' } : null;
}

/**
 * Does this art carry one engagement's dates, venue or presenter? A tour page
 * must not show "JAN 26-31 / Segerstrom" art (checked 2026-10-05: TodayTix's
 * Costa Mesa uploads for 4 tours). Fails CLOSED: {stamped: null} on no key,
 * API error or an unreadable reply, which callers treat as a rejection.
 * @param {Buffer} imageData
 * @returns {Promise<{stamped: boolean|null, text: string}>}
 */
async function detectEngagementStamp(imageData, options = {}) {
  const model = getGeminiModel();
  if (!model) return { stamped: null, text: 'no GEMINI_API_KEY' };
  const rateLimiter = options.rateLimiter || new RateLimiter(RPM_LIMIT);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await rateLimiter.wait();
    try {
      const result = await model.generateContent([
        { text: ENGAGEMENT_STAMP_PROMPT },
        { inlineData: { data: imageData.toString('base64'), mimeType: options.mimeType || 'image/png' } },
      ]);
      const parsed = parseStampResponse(result.response.text());
      return parsed || { stamped: null, text: 'unreadable reply' };
    } catch (err) {
      if (attempt === MAX_RETRIES) return { stamped: null, text: `api error: ${err.message}` };
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
  }
  return { stamped: null, text: 'no reply' };
}

/**
 * Classify image type from URL/filename patterns.
 * Used as a tiebreaker when Gemini classification is uncertain.
 */
function classifyImageUrl(url) {
  const lower = (url || '').toLowerCase();
  // Patterns suggesting promotional art
  if (/poster|key[_-]?art|logo|promo|official|title|artwork|keyart/.test(lower)) return 'promotional_art';
  // TodayTix API images are always promotional
  if (lower.includes('todaytix.imgix.net') || lower.includes('tix-content')) return 'promotional_art';
  // Contentful assets are typically curated promotional images
  if (lower.includes('images.ctfassets.net')) return 'promotional_art';
  // Patterns suggesting production stills
  if (/gallery|production|rehearsal|stage|perform|_r\d|IMG_|backstage/.test(lower)) return 'production_still';
  return 'unknown';
}

// ============================================================
// EXPORTS
// ============================================================

function createRateLimiter(rpm) {
  return new RateLimiter(rpm || RPM_LIMIT);
}

module.exports = {
  verifyImage,
  detectEngagementStamp,
  parseStampResponse,
  createRateLimiter,
  classifyImageUrl,
  buildVerificationPrompt,
  buildUserPrompt,
  applyStrictVerdict,
  parseResponse,
  creativesForVerify,
  formatCreatives,
  resolveMarketSlug,
  getMarketProfile,
  MARKET_PROFILES,
};
