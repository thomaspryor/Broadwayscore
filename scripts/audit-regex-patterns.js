#!/usr/bin/env node
/**
 * audit-regex-patterns.js — standing FP gate for content-quality regex families.
 *
 * Scans every pattern array exported from scripts/lib/content-quality.js against
 * real review-text content. Reports hits per pattern. Exits 1 if any pattern
 * exceeds the FP threshold.
 *
 * Why this exists: 2026-04-24 audit found /recipe|ingredients|cook(ing)?/i
 * matching "cookie" substring and theater metaphors ("recipe for disaster")
 * — 167 hits / 5.9% of reviews. Unit tests with synthetic samples never
 * exercised real-review metaphors. This is the empirical gate.
 *
 * Also audits the discovery exclude-substring arrays in
 * scripts/discover-new-shows.js (NON_THEATER_PATTERNS, WE_EXTRA_PATTERNS,
 * VENUE_PAGE_EXCLUDE_PATTERNS) against real tracked show titles
 * (public/data/mobile-shows.json). Those arrays gate which candidate shows
 * ever reach shows.json — a hit against a real title means a real production
 * would be silently dropped from discovery, so unlike the content-quality
 * families above (which only affect review-scoring, not existence), the
 * default allowance here is 0. Confirmed 2026-07-31: bare 'gala' matched
 * "Via Galactica"; confirmed 2026-08-26 (BRO-181): bare 'quartet' matched
 * "Million Dollar Quartet", bare 'tour' matched "Armory Public Tours" /
 * "September L. Davis: The Apology Tour", and 'classic penguins' matched a
 * since-legitimized tracked show — all fixed in discover-new-shows.js.
 *
 * BRO-2315 extends the same audit to scripts/discover-opera-shows.js's
 * NON_OPERA_TITLE_PATTERNS (isNonOpera(), same title.includes(p) gate,
 * scoped to Met Opera season-page titles). Scanned against the corpus of
 * real tracked opera titles (public/data/mobile-shows.json entries with
 * ty === 'opera') rather than the full theatre-wide title list —
 * isNonOpera() only ever evaluates titles scraped from Met's own season
 * pages, so the general corpus would be noise for this family.
 *
 * Usage:
 *   node scripts/audit-regex-patterns.js              # sample 400 recent shows, threshold 5
 *   node scripts/audit-regex-patterns.js --full       # scan all ~36k reviews
 *   node scripts/audit-regex-patterns.js --max-hits N # override threshold
 *   node scripts/audit-regex-patterns.js --json       # machine-readable output
 *
 * Exit codes:
 *   0 — all patterns under threshold
 *   1 — one or more patterns exceed threshold (detail in stdout)
 *   2 — scan failed (missing data/review-texts or malformed content-quality.js)
 *
 * Wired into .github/workflows/test.yml on content-quality.js edits.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_QUALITY = require('./lib/content-quality.js');
const { listShowDirs } = require('./lib/list-show-dirs');

// Pattern families we gate. Keys must match exported names from content-quality.js.
// Add new families here when they land in content-quality.js — the gate will pick them up.
const PATTERN_FAMILIES = [
  'AD_BLOCKER_PATTERNS',
  'PAYWALL_PATTERNS',
  'LEGAL_PAGE_PATTERNS',
  'COOKIE_CONSENT_PATTERNS',
  'ERROR_PAGE_PATTERNS',
  // Whole-body 404/error chrome scanned position-independently (detectStrongError
  // PageAnywhere). Phrases never appear in real review prose or footers, so raw
  // corpus hits among scored-tier reviews are 0. Registered for FP-gate coverage.
  'STRONG_ERROR_PAGE_PATTERNS',
  // Position-independent chrome-dump markers (gated at runtime on no-review +
  // non-trailing). Raw corpus hits are ~0; the gate trips only if a scraper
  // regression starts emitting these as bulk chrome. See content-quality.js
  // STRONG_CHROME_DUMP_PATTERNS.
  'STRONG_CHROME_DUMP_PATTERNS',
  'NEWSLETTER_PATTERNS',
  'NAVIGATION_PATTERNS',
  'WRONG_ARTICLE_PATTERNS',
  'HORROR_FILM_PATTERNS',
];

// Per-pattern hit allowances. Default is DEFAULT_MAX_HITS. Add entries here
// for patterns that legitimately fire at higher rates — typically because they
// detect real scrape pollution that's absorbed by layered guards in
// isGarbageContent (trailing/leading-junk mitigation, 5+ threshold for nav).
//
// Allowances are calibrated against the full review-text corpus (`--full`) on
// 2026-04-28 with ~30% headroom. If a pattern's baseline shifts materially,
// update this list rather than raising DEFAULT_MAX_HITS.
// Entry format: `${FAMILY}::${index}` → max allowed hits.
//
// Calibration provenance lives in PATTERN_CALIBRATION below — when you bump
// a threshold, ALSO add an entry there so the next regression triage gets
// the date/commit/reasoning auto-surfaced in the audit failure message.
const PATTERN_ALLOWLIST = {
  // Ad-blocker: Playbill's "disable your ad blocker" support-request overlay
  // bleeds into scraped text verbatim across many Playbill reviews.
  // 2026-08-15 calibration: raw 11. Sized to baseline + 30%.
  'AD_BLOCKER_PATTERNS::0': 15, // /\bad\s*block(er)?/i — raw 11
  // Paywall: HuffPost "Already a member"/"BECOME A MEMBER", subscriber prompts.
  // 2026-04-28 recalibration: NYT "Already a subscriber? Log in" chrome bleeds
  // into ~28 archived NYT reviews (raw 28). Sized to baseline + 30%.
  'PAYWALL_PATTERNS::7': 40,    // /already\s+a\s+(member|subscriber)/ — raw 28
  'PAYWALL_PATTERNS::8': 15,    // /become\s+a\s+(member|subscriber)/
  'PAYWALL_PATTERNS::11': 20,   // /exclusive\s+(content|access)/
  // 2026-08-15 calibration: "subscribers only" archive-paper chrome
  // (Bloomberg, WaPo) bleeds into scraped text. Raw 9. Sized to baseline + 30%.
  'PAYWALL_PATTERNS::4': 12,    // /subscribers?\s+(only|content|exclusive|access)/i — raw 9
  // Legal: copyright footers are ubiquitous in scraped content
  'LEGAL_PAGE_PATTERNS::0': 50,   // /^privacy\s+policy/im
  'LEGAL_PAGE_PATTERNS::1': 20,   // /^terms\s+(of\s+)?(use|service)/im
  'LEGAL_PAGE_PATTERNS::5': 300,  // /all\s+rights\s+reserved\./
  'LEGAL_PAGE_PATTERNS::6': 1000, // /©\s*\d{4}.*all\s+rights\s+reserved/
  // Cookie consent: Telegraph GDPR text bleeds into many Telegraph scrapes
  'COOKIE_CONSENT_PATTERNS::1': 100, // /legitimate\s+interest/
  // BRO-38: STRONG_CHROME_DUMP_PATTERNS::6/7/8 mirror LEGAL_PAGE_PATTERNS::0/1
  // and COOKIE_CONSENT_PATTERNS::1 position-independently (see content-quality.js
  // comment above the array). Same underlying raw-hit source as those families —
  // real "Privacy Policy"/"Terms of Use" footer links and WhatsOnStage's embedded
  // GDPR cookie-notice bleed — but a 2026-08-26 full-corpus parity diff (33,945
  // files) confirmed 0 of those raw hits reach isGarbageContent's actual gate
  // (hasSubstantialReviewContent + non-trailing), because every hit either sits
  // in a substantial real review (gate blocks it) or in trailing junk. Sized to
  // the observed full-corpus raw count + 30% headroom, same convention as the
  // source families.
  'STRONG_CHROME_DUMP_PATTERNS::6': 60,  // /^privacy\s+policy/im — raw 43
  'STRONG_CHROME_DUMP_PATTERNS::7': 20,  // /^terms\s+(of\s+)?(use|service)/im — raw 14
  'STRONG_CHROME_DUMP_PATTERNS::8': 130, // /legitimate\s+interest/i — raw 101
  // Newsletter: real newsletter prompts in Guardian, artsdesk, TimeOut scrapes —
  // leading/trailing-junk mitigation absorbs them in isGarbageContent
  'NEWSLETTER_PATTERNS::0': 200,  // /thanks?\s+for\s+subscribing/ — raw 154, 2026-08-15 recal
  'NEWSLETTER_PATTERNS::1': 150,  // /enter\s+your\s+email/
  'NEWSLETTER_PATTERNS::3': 10,   // /subscribe\s+to\s+(our\s+)?newsletter/i — raw 7, 2026-08-26 (BRO-33, see PATTERN_CALIBRATION)
  'NEWSLETTER_PATTERNS::4': 28,   // /get\s+(the\s+)?latest\s+(news|updates)/i — raw 21, 2026-08-15 recal (see PATTERN_CALIBRATION)
  'NEWSLETTER_PATTERNS::5': 22,   // /newsletter\s+sign[-\s]?up/ — raw 17, 2026-08-15 recal (see PATTERN_CALIBRATION)
  'NEWSLETTER_PATTERNS::6': 60,   // /join\s+(our\s+)?(mailing\s+)?list/
  // Navigation: scraped pages have real nav/footer bleed; the 5+ threshold in
  // detectNavigationJunk prevents single-match rejection.
  // 2026-04-28 recalibration: NAVIGATION_PATTERNS::1 baseline jumped 30 → 143
  // as more archived NYT/about-entertainment scrapes accumulated unstripped
  // "Skip to main content" headers. Each is real chrome bleed at the start of
  // fullText; the multi-keyword guard in detectNavigationJunk still rejects
  // garbage content. Sized to current baseline + 30%.
  'NAVIGATION_PATTERNS::0': 50,   // /^(home|about|contact|faq|...)\s*$/im
  'NAVIGATION_PATTERNS::1': 200,  // /skip\s+to\s+(main\s+)?content/ — raw 143
  'NAVIGATION_PATTERNS::2': 260,  // /\b(footer|header|sidebar|navigation|...)\b/ — raw 201
  'NAVIGATION_PATTERNS::4': 1200, // /related\s+(articles?|stories|posts)/
  'NAVIGATION_PATTERNS::5': 70,   // /popular\s+(articles?|stories|posts)/
  'NAVIGATION_PATTERNS::6': 400,  // /latest\s+(articles?|stories|news)/
  'NAVIGATION_PATTERNS::7': 15,   // /trending\s+(now|stories|articles)/ — raw 11, 2026-08-15 recal (see PATTERN_CALIBRATION)
  // Wrong-article: ^breaking news catches genuine news-sidebar pollution
  'WRONG_ARTICLE_PATTERNS::7': 50, // /^breaking\s+news/im
  // Paywall: bare /paywall/i matches critics discussing their publication's
  // funding model in trailing editor notes — absorbed by trailing-junk mitigation.
  // 2026-08-15 recalibration: corpus grew to 25 diffuse hits (small nonprofit/indie
  // outlets — Parterre Box, NJArts, Forward — discussing their own no-paywall
  // funding model in editorial notes). Sized to baseline + 30%.
  'PAYWALL_PATTERNS::12': 35, // /paywall/i — raw 25
  // NYT bot-detection JS-loader artifact appears literally in 171 archived NYT reviews.
  // Each match is a real positive — the scraper got partial article + this anti-bot stub.
  // No FP risk: phrase is too specific to occur in legitimate review prose. Sized to
  // current corpus + headroom; revisit if NYT changes the stub wording.
  'PAYWALL_PATTERNS::15': 250, // /trouble\s+retrieving\s+the\s+article\s+content/i — raw 171
  // Horror-film: bare patterns fire on 312 reviews (metaphors — "insidious plot",
  // "horror movie genre comparison", "haunted house set", "spirit world in Hamlet").
  // detectHorrorFilmContent's 3+-theater-keyword guard absorbs 100% — zero pass
  // through to rejection. Allowlist to current full-corpus baseline + 30%.
  'HORROR_FILM_PATTERNS::0': 150, // /insidious/ — raw 101
  'HORROR_FILM_PATTERNS::1': 205, // /horror\s*(film|movie|sequel)/ — raw 158, 2026-08-31 recal (see PATTERN_CALIBRATION)
  'HORROR_FILM_PATTERNS::3': 100, // /haunted\s+(family|house|lambert)/ — raw 76, 2026-08-26 recal (see PATTERN_CALIBRATION)
  'HORROR_FILM_PATTERNS::4': 20,  // /spirit\s+world/ — raw 9
  'HORROR_FILM_PATTERNS::5': 15,  // /scary\s+movies?/ — raw 5
  'HORROR_FILM_PATTERNS::6': 110, // /horror\s+film/ — raw 82, 2026-08-31 recal (duplicate of ::1, see PATTERN_CALIBRATION)
};

// Per-pattern calibration provenance. Optional companion to PATTERN_ALLOWLIST.
// When a threshold is bumped, add an entry here documenting WHEN, WHY, and
// AGAINST WHAT. The audit's failure message renders these inline next to
// the offending pattern so the next regression triage doesn't have to
// excavate commit history. Read this BEFORE bumping a threshold —
// duplicate calibrations on a pattern are a smell ("we keep raising
// because the scraper keeps regressing").
//
// Schema:
//   '${FAMILY}::${index}': {
//     commit: '<git-sha>',  // commit that set the current threshold
//     date: 'YYYY-MM-DD',   // when the calibration was done
//     rawHits: <number>,    // observed corpus count at calibration time
//     headroom: <ratio>,    // allowlist value / rawHits (1.3 = 30% headroom)
//     note: '<short prose>' // why hits diffuse vs concentrated, what to look
//                           //   for if the threshold trips again
//   }
const PATTERN_CALIBRATION = {
  'NAVIGATION_PATTERNS::1': {
    commit: '5eab60d60c',
    date: '2026-04-28',
    rawHits: 143,
    headroom: 1.4,
    note: 'Diffuse across defunct archive outlets (theater-news-online, '
        + 'about-entertainment, new-jersey-newsroom — top 5 = 54% of hits, '
        + '51% of dated fetches from 2026-02). No single commit drives the '
        + 'baseline; mostly cached chrome bleed in re-unscrapable archives. '
        + "detectNavigationJunk's 5+ keyword guard absorbs these at runtime "
        + 'so review scoring is unaffected. Next bump: probe by-outlet — '
        + 'if the bump comes from an ACTIVE outlet (not the documented '
        + 'archives), it is a scraper regression, fix the strip; if from '
        + 'an archive, accept and bump.',
  },
  'NAVIGATION_PATTERNS::2': {
    commit: 'pending',
    date: '2026-06-01',
    rawHits: 201,
    headroom: 1.3,
    note: '/\\b(footer|header|sidebar|navigation|...)\\b/ — bare nav-chrome '
        + 'keywords. Diffuse: sampled hits span distinct outlets (newyorker '
        + 'prose "navigation problems", cleveland + bloomberg archive chrome) '
        + '1-per-outlet, not concentrated — corpus-growth drift, not a scraper '
        + 'regression. Surfaced 201/200 only after the duplicateOf gate stopped '
        + 'short-circuiting this step (it ran earlier in Data Validation and '
        + 'failed first, skipping this audit). Runtime scoring unaffected: '
        + "detectNavigationJunk requires 5+ keyword hits, so a single bare "
        + 'match never excludes a review. Next bump: probe by-outlet; '
        + 'concentration in one ACTIVE outlet = scraper chrome leak, fix the strip.',
  },
  'NAVIGATION_PATTERNS::7': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 11,
    headroom: 1.36,
    note: '/trending (now|stories|articles)/ — recent-articles widget bleed. '
        + 'Corpus-growth recalibration from raw 6 (2026-04-28) to raw 11: same '
        + 'widget pattern (Playbill, Daily Beast), diffuse across outlets, not '
        + 'a scraper regression. Sized to baseline + ~30%.',
  },
  'NEWSLETTER_PATTERNS::3': {
    commit: 'pending',
    date: '2026-08-26',
    rawHits: 7,
    headroom: 1.43,
    note: 'BRO-33 triage: /subscribe to (our )?newsletter/i first breached the '
        + 'default-5 threshold (raw 7). Diffuse across 4 outlets — nytg (New '
        + 'York Theatre Guide, 4 hits), new-statesman, queerty, london-theatre '
        + '— corpus growth, not a scraper regression. 5/7 hits sit in the '
        + 'trailing >60% of fullText (footer CTA) and are absorbed by '
        + "isGarbageContent's trailing-junk mitigation (_isPatternInTrailingJunk); "
        + 'the queerty hit at 16% is absorbed by the leading-junk mitigation '
        + '(<20%). The new-statesman hit at 56% sits in neither safe window —  '
        + 'verified this file is NOT protected by position, but detectNewsletter() '
        + 'iterates NEWSLETTER_PATTERNS in array order and returns on the first '
        + 'INDEX that matches anywhere in the text, not the first occurrence by '
        + 'position; this file also matches NEWSLETTER_PATTERNS[1] '
        + '("enter your email", allowlisted at 150) at 59%, which is checked '
        + 'first and wins, so index 3 is never the operative match for this '
        + 'file today. That is order-of-evaluation luck, not a structural '
        + 'guarantee — if a future scrape drops the "enter your email" phrase '
        + 'from this outlet while keeping "subscribe to our newsletter" in the '
        + 'unprotected 20-60% zone, this specific file would flip to garbage. '
        + 'Next bump: if this pattern regresses again, check whether the new '
        + 'hits are mid-text (unprotected) rather than assuming trailing/leading '
        + 'absorption. Sized to raw + 30%.',
  },
  'NEWSLETTER_PATTERNS::4': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 21,
    headroom: 1.33,
    note: '"Get the latest news/updates" CTA. Corpus-growth recalibration from '
        + 'raw 9 (2026-06-16) to raw 21 — same chrome class (outlet-footer '
        + 'newsletter CTAs: Chicago News, Cleveland.com, South London Press), '
        + 'not a new FP mode. Runtime unaffected: detectNewsletterSignup '
        + 'requires 2+ pattern hits to reject. Next bump: probe by-outlet.',
  },
  'NEWSLETTER_PATTERNS::5': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 17,
    headroom: 1.29,
    note: 'HuffPost/TheaterMania/Observer newsletter widget footer. Corpus-growth '
        + 'recalibration from raw 10 (2026-04-28) to raw 17. Caught in '
        + 'leading/trailing-junk mitigation downstream.',
  },
  'PAYWALL_PATTERNS::7': {
    commit: '07bfb0c497',
    date: '2026-04-28',
    rawHits: 28,
    headroom: 1.4,
    note: 'NYT "Already a subscriber? Log in" chrome that bleeds into '
        + '~28 archived NYT reviews. Sized baseline + 30%.',
  },
  'PAYWALL_PATTERNS::4': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 9,
    headroom: 1.33,
    note: '"Subscribers only" archive-paper chrome (Bloomberg, Washington Post) '
        + 'bleeding into scraped text — genuine paywall chrome, not prose. '
        + 'Sized to raw + 30%.',
  },
  'PAYWALL_PATTERNS::12': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 25,
    headroom: 1.4,
    note: 'Bare /paywall/i — diffuse across small nonprofit/indie outlets '
        + '(Parterre Box, NJArts, Forward) discussing their own no-paywall '
        + 'funding model in editorial notes, not a single scraper regression. '
        + 'Runtime unaffected: single bare match never excludes a review on '
        + 'its own.',
  },
  'AD_BLOCKER_PATTERNS::0': {
    commit: 'pending',
    date: '2026-08-15',
    rawHits: 11,
    headroom: 1.36,
    note: 'Playbill\'s "disable your ad blocker" support-request overlay '
        + 'bleeding verbatim into scraped Playbill reviews. Concentrated in '
        + 'one outlet (Playbill), consistent with a static footer widget, '
        + 'not a scraper regression. Sized to raw + ~35%.',
  },
  'HORROR_FILM_PATTERNS::3': {
    commit: 'pending',
    date: '2026-08-26',
    rawHits: 76,
    headroom: 1.32,
    note: 'BRO-33 triage: /haunted (family|house|lambert)/i corpus growth from '
        + 'raw 47 (prior baseline) to 76 — theater-metaphor bleed ("haunted '
        + 'house version of the Seventies", horror-adjacent staging '
        + 'descriptions in Appropriate, Abigail\'s Party reviews), diffuse '
        + "across outlets, not concentrated in one active scraper. detectHorror"
        + "FilmContent's 3+-theater-keyword guard absorbs these at runtime — "
        + 'zero pass through to rejection. Sized to raw + 30%.',
  },
  'HORROR_FILM_PATTERNS::1': {
    commit: 'pending',
    date: '2026-08-31',
    rawHits: 158,
    headroom: 1.3,
    note: 'BRO-2662 triage (surfaced while confirming --full exits 0 after the '
        + 'circus title-exclude fix): /horror\\s*(film|movie|sequel)/i corpus '
        + 'growth from raw 107 (prior baseline) to 158 — theater-metaphor '
        + 'bleed ("worthy of a Blumhouse horror film", "reminiscent of a '
        + 'horror movie", genre-comparison prose in Appropriate, American '
        + 'Son, Variety/LSA/TWiNY reviews), diffuse across outlets, not a '
        + 'scraper regression. Verified directly: scanning the full corpus '
        + "with detectHorrorFilmContent() (not the bare regex) finds only 2 "
        + 'texts where the 3+-theater-keyword guard fails to absorb the '
        + 'match (My Neighbour Totoro / Paranormal Activity West End '
        + "reviews), and both already carry contentTier: 'invalid' — outside "
        + "this audit's own tier filter and already excluded by other gates, "
        + 'not caused by this pattern. Sized to raw + 30%.',
  },
  'HORROR_FILM_PATTERNS::6': {
    commit: 'pending',
    date: '2026-08-31',
    rawHits: 82,
    headroom: 1.34,
    note: 'BRO-2662 triage, same corpus-growth event as HORROR_FILM_PATTERNS::1 '
        + '(this pattern is a subset/duplicate of ::1 — /horror\\s+film/i vs '
        + '/horror\\s*(film|movie|sequel)/i). Raw 43 (prior baseline) to 82. '
        + 'See ::1 above for the verification that detectHorrorFilmContent\'s '
        + 'guard absorbs these. Sized to raw + 30%.',
  },
};

const DEFAULT_MAX_HITS = 5;
const DEFAULT_SAMPLE_SHOWS = 400;
const MAX_REVIEWS_PER_SHOW = 30;

// Discovery exclude-substring families (scripts/discover-new-shows.js). Unlike
// PATTERN_FAMILIES above (regex, tested against review fullText), these are
// plain lowercase substrings tested via String.includes() against show
// titles — they gate which candidates ever become shows.json entries. See
// the file-header comment for why the default allowance is 0.
const TITLE_EXCLUDE_FAMILIES = [
  'NON_THEATER_PATTERNS',
  'WE_EXTRA_PATTERNS',
  'VENUE_PAGE_EXCLUDE_PATTERNS',
];
const TITLE_EXCLUDE_DEFAULT_MAX_HITS = 0;

// Calibrated exceptions, mirrors PATTERN_ALLOWLIST. Empty by design — a hit
// here means a currently-tracked real show would be excluded from future
// re-discovery, which should be fixed (tighten the pattern), not allowlisted.
// Add an entry ONLY if a pattern is confirmed intentional against a specific
// title (document why in a comment here, same as PATTERN_CALIBRATION above).
const TITLE_EXCLUDE_ALLOWLIST = {};

// Opera-specific title-exclude family (scripts/discover-opera-shows.js).
// Same substring-gate shape and 0-hit-default rationale as
// TITLE_EXCLUDE_FAMILIES above, but scanned against a narrower, opera-only
// corpus (see loadOperaTitleCorpus) since isNonOpera() only ever sees
// Met-season-page titles, not general theatre titles.
const OPERA_TITLE_EXCLUDE_FAMILIES = ['NON_OPERA_TITLE_PATTERNS'];
const OPERA_TITLE_EXCLUDE_DEFAULT_MAX_HITS = 0;
const OPERA_TITLE_EXCLUDE_ALLOWLIST = {};

function parseArgs(argv) {
  const args = { full: false, maxHits: DEFAULT_MAX_HITS, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--json') args.json = true;
    else if (a === '--max-hits') args.maxHits = parseInt(argv[++i], 10);
    else if (a.startsWith('--max-hits=')) args.maxHits = parseInt(a.split('=')[1], 10);
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(2, 25).join('\n'));
      process.exit(0);
    }
  }
  return args;
}

function loadPatterns() {
  const families = {};
  for (const name of PATTERN_FAMILIES) {
    const arr = CONTENT_QUALITY[name];
    if (!Array.isArray(arr)) {
      console.error(`FATAL: ${name} not exported from content-quality.js (got ${typeof arr})`);
      process.exit(2);
    }
    families[name] = arr;
  }
  return families;
}

function loadTitleExcludeFamilies() {
  let discovery;
  try {
    discovery = require('./discover-new-shows.js');
  } catch (e) {
    console.error(`FATAL: failed to require discover-new-shows.js: ${e.message}`);
    process.exit(2);
  }
  const families = {};
  for (const name of TITLE_EXCLUDE_FAMILIES) {
    const arr = discovery[name];
    if (!Array.isArray(arr)) {
      console.error(`FATAL: ${name} not exported from discover-new-shows.js (got ${typeof arr})`);
      process.exit(2);
    }
    families[name] = arr;
  }
  return families;
}

function loadMobileShows() {
  const p = path.resolve(__dirname, '..', 'public', 'data', 'mobile-shows.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`FATAL: failed to read/parse ${p}: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(raw.shows)) {
    console.error(`FATAL: ${p} has no shows array`);
    process.exit(2);
  }
  return raw.shows;
}

function loadTitleCorpus() {
  return loadMobileShows().map(s => s.t).filter(Boolean);
}

function loadOperaTitleExcludeFamilies() {
  let discovery;
  try {
    discovery = require('./discover-opera-shows.js');
  } catch (e) {
    console.error(`FATAL: failed to require discover-opera-shows.js: ${e.message}`);
    process.exit(2);
  }
  const families = {};
  for (const name of OPERA_TITLE_EXCLUDE_FAMILIES) {
    const arr = discovery[name];
    if (!Array.isArray(arr)) {
      console.error(`FATAL: ${name} not exported from discover-opera-shows.js (got ${typeof arr})`);
      process.exit(2);
    }
    families[name] = arr;
  }
  return families;
}

// Opera-only corpus: real tracked opera productions (mobile-shows.json
// entries with ty === 'opera'), not the full theatre-wide title list. See
// the file-header BRO-2315 note for why the narrower corpus is correct here.
// Floor is well below the 35-title baseline observed at calibration
// (2026-08-31) — catches a corrupted/partial mobile-shows.json (e.g. most
// opera entries silently losing their `ty` field) that a bare `> 0` check
// would miss, without being brittle to normal corpus growth.
const OPERA_TITLE_CORPUS_MIN_SIZE = 15;
function loadOperaTitleCorpus() {
  const titles = loadMobileShows().filter(s => s.ty === 'opera').map(s => s.t).filter(Boolean);
  if (titles.length < OPERA_TITLE_CORPUS_MIN_SIZE) {
    console.error(`FATAL: only ${titles.length} ty==="opera" entries found in ` +
      `public/data/mobile-shows.json (expected >= ${OPERA_TITLE_CORPUS_MIN_SIZE}) — ` +
      'either the corpus genuinely shrank (update OPERA_TITLE_CORPUS_MIN_SIZE) or ' +
      'mobile-shows.json is corrupted/partial and the opera title-exclude audit ' +
      'would be running against too little evidence to be meaningful.');
    process.exit(2);
  }
  return titles;
}

// Substring (not regex) scan: real discovery call sites use
// title.toLowerCase().includes(pattern), so the audit mirrors that exactly.
function scanTitleFamilies({ families, titles }) {
  const lowerTitles = titles.map(t => ({ title: t, lower: t.toLowerCase() }));
  const counts = {};
  for (const [familyName, patterns] of Object.entries(families)) {
    counts[familyName] = patterns.map(pattern => {
      const matches = lowerTitles.filter(t => t.lower.includes(pattern));
      return {
        hits: matches.length,
        examples: matches.slice(0, 3).map(m => ({ match: m.title })),
      };
    });
  }
  return counts;
}

function evaluateTitleFamilies({ counts, allowlist = TITLE_EXCLUDE_ALLOWLIST, defaultMaxHits = TITLE_EXCLUDE_DEFAULT_MAX_HITS }) {
  const violations = [];
  for (const [familyName, arr] of Object.entries(counts)) {
    arr.forEach((entry, i) => {
      const allow = allowlist[`${familyName}::${i}`] ?? defaultMaxHits;
      if (entry.hits > allow) {
        violations.push({ family: familyName, index: i, hits: entry.hits, allow, examples: entry.examples });
      }
    });
  }
  return violations;
}

function reportTitleFamilies({
  titleCount, counts, violations, families,
  corpusLabel = 'tracked show titles (public/data/mobile-shows.json)',
  allowlist = TITLE_EXCLUDE_ALLOWLIST, defaultMaxHits = TITLE_EXCLUDE_DEFAULT_MAX_HITS,
}) {
  const lines = [];
  lines.push('');
  lines.push(`[audit-regex-patterns] Discovery exclude-substring audit: ${titleCount} ${corpusLabel}, ` +
    `threshold ${defaultMaxHits} hits per pattern.`);
  lines.push('');
  lines.push('Pattern family              Patterns  Max hits  Over threshold');
  lines.push('--------------------------  --------  --------  --------------');
  for (const [familyName, arr] of Object.entries(counts)) {
    const max = Math.max(0, ...arr.map(e => e.hits));
    const over = arr.filter((e, i) => e.hits > (allowlist[`${familyName}::${i}`] ?? defaultMaxHits)).length;
    lines.push(`${familyName.padEnd(26)}  ${String(arr.length).padStart(8)}  ${String(max).padStart(8)}  ${String(over).padStart(14)}`);
  }
  lines.push('');

  if (violations.length === 0) {
    lines.push('✅ No discovery exclude pattern matches a tracked show title.');
    return lines.join('\n');
  }

  lines.push(`❌ ${violations.length} discovery exclude pattern(s) match a real tracked show title:`);
  lines.push('');
  for (const v of violations) {
    const pattern = families[v.family][v.index];
    lines.push(`  ${v.family}[${v.index}] — ${v.hits} hits (allow ${v.allow})`);
    lines.push(`    pattern: ${JSON.stringify(pattern)}`);
    for (const ex of v.examples) {
      lines.push(`    matched title: "${ex.match}"`);
    }
    lines.push('');
  }
  lines.push('A hit here means a real production would be silently excluded from ' +
    'discovery — tighten the pattern (multi-word variant, see the "gala"/"quartet" ' +
    'precedents in discover-new-shows.js), do not allowlist unless confirmed intentional.');
  return lines.join('\n');
}

function findReviewTextsDir() {
  const candidates = [
    path.resolve(process.cwd(), 'data/review-texts'),
    path.resolve(__dirname, '../data/review-texts'),
  ];
  for (const d of candidates) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch { /* try next */ }
  }
  console.error('FATAL: data/review-texts not found. Run from repo root after restoring private repo.');
  process.exit(2);
}

function scanCorpus({ full, families }) {
  const dir = findReviewTextsDir();
  const showDirs = listShowDirs(dir).filter(d => {
    const p = path.join(dir, d);
    try { return fs.statSync(p).isDirectory() && d !== '_pending'; } catch { return false; }
  });

  const pool = full ? showDirs : showDirs.slice(-DEFAULT_SAMPLE_SHOWS);
  const reviewLimit = full ? Infinity : MAX_REVIEWS_PER_SHOW;

  // Initialize counters
  const counts = {};
  for (const [familyName, patterns] of Object.entries(families)) {
    counts[familyName] = patterns.map(() => ({ hits: 0, examples: [] }));
  }

  let scanned = 0;
  for (const show of pool) {
    const showDir = path.join(dir, show);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); } catch { continue; }
    const take = full ? files : files.slice(0, reviewLimit);
    for (const f of take) {
      let review;
      try { review = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf-8')); } catch { continue; }
      const text = review.fullText || '';
      if (text.length < 500) continue;
      const tier = review.contentTier;
      if (tier && tier !== 'complete' && tier !== 'truncated' && tier !== 'excerpt') continue;
      scanned++;
      for (const [familyName, patterns] of Object.entries(families)) {
        for (let i = 0; i < patterns.length; i++) {
          const m = text.match(patterns[i]);
          if (m) {
            counts[familyName][i].hits++;
            if (counts[familyName][i].examples.length < 3) {
              const idx = text.indexOf(m[0]);
              counts[familyName][i].examples.push({
                show, file: f, match: m[0],
                snippet: text.substring(Math.max(0, idx - 30), Math.min(text.length, idx + m[0].length + 60)).replace(/\s+/g, ' ').trim(),
              });
            }
          }
        }
      }
    }
  }
  return { scanned, counts };
}

function evaluate({ counts, maxHits }) {
  const violations = [];
  for (const [familyName, arr] of Object.entries(counts)) {
    arr.forEach((entry, i) => {
      const allow = PATTERN_ALLOWLIST[`${familyName}::${i}`] ?? maxHits;
      if (entry.hits > allow) {
        violations.push({ family: familyName, index: i, hits: entry.hits, allow, examples: entry.examples });
      }
    });
  }
  return violations;
}

function reportText({ scanned, counts, violations, args, families }) {
  const lines = [];
  lines.push(`[audit-regex-patterns] Scanned ${scanned} substantial reviews (tier=complete/truncated/excerpt, length>=500).`);
  lines.push(`[audit-regex-patterns] Threshold: ${args.maxHits} hits per pattern (per-pattern allowlist overrides possible).`);
  lines.push('');

  // Always show a summary table
  lines.push('Pattern family            Patterns  Max hits  Over threshold');
  lines.push('------------------------  --------  --------  --------------');
  for (const [familyName, arr] of Object.entries(counts)) {
    const max = Math.max(0, ...arr.map(e => e.hits));
    const over = arr.filter((e, i) => e.hits > (PATTERN_ALLOWLIST[`${familyName}::${i}`] ?? args.maxHits)).length;
    lines.push(`${familyName.padEnd(24)}  ${String(arr.length).padStart(8)}  ${String(max).padStart(8)}  ${String(over).padStart(14)}`);
  }
  lines.push('');

  if (violations.length === 0) {
    lines.push('✅ All patterns under threshold.');
    return lines.join('\n');
  }

  lines.push(`❌ ${violations.length} pattern(s) exceed threshold:`);
  lines.push('');
  for (const v of violations) {
    const regex = families[v.family][v.index];
    lines.push(`  ${v.family}[${v.index}] — ${v.hits} hits (allow ${v.allow})`);
    lines.push(`    regex: ${regex}`);
    const cal = PATTERN_CALIBRATION[`${v.family}::${v.index}`];
    if (cal) {
      lines.push(`    calibrated: ${cal.date} @ ${cal.commit} (rawHits ${cal.rawHits}, headroom ${cal.headroom}x)`);
      lines.push(`    note: ${cal.note}`);
    } else {
      lines.push('    calibrated: <no provenance entry — add one to PATTERN_CALIBRATION when bumping>');
    }
    for (const ex of v.examples) {
      lines.push(`    [${ex.show}/${ex.file}] match: "${ex.match}"`);
      lines.push(`      …${ex.snippet}…`);
    }
    lines.push('');
  }
  lines.push('See memory/feedback_content_quality_regex_fps.md for tightening strategy.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const families = loadPatterns();
  const { scanned, counts } = scanCorpus({ full: args.full, families });
  const violations = evaluate({ counts, maxHits: args.maxHits });

  const titleFamilies = loadTitleExcludeFamilies();
  const titles = loadTitleCorpus();
  const titleCounts = scanTitleFamilies({ families: titleFamilies, titles });
  const titleViolations = evaluateTitleFamilies({ counts: titleCounts });

  const operaTitleFamilies = loadOperaTitleExcludeFamilies();
  const operaTitles = loadOperaTitleCorpus();
  const operaTitleCounts = scanTitleFamilies({ families: operaTitleFamilies, titles: operaTitles });
  const operaTitleViolations = evaluateTitleFamilies({
    counts: operaTitleCounts, allowlist: OPERA_TITLE_EXCLUDE_ALLOWLIST, defaultMaxHits: OPERA_TITLE_EXCLUDE_DEFAULT_MAX_HITS,
  });

  const allViolations = violations.length + titleViolations.length + operaTitleViolations.length;

  if (args.json) {
    const out = {
      scanned, maxHits: args.maxHits, violations, allowlist: PATTERN_ALLOWLIST, calibration: PATTERN_CALIBRATION,
      titleCorpusSize: titles.length, titleViolations, titleAllowlist: TITLE_EXCLUDE_ALLOWLIST,
      operaTitleCorpusSize: operaTitles.length, operaTitleViolations, operaTitleAllowlist: OPERA_TITLE_EXCLUDE_ALLOWLIST,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(reportText({ scanned, counts, violations, args, families }));
    console.log(reportTitleFamilies({ titleCount: titles.length, counts: titleCounts, violations: titleViolations, families: titleFamilies }));
    console.log(reportTitleFamilies({
      titleCount: operaTitles.length, counts: operaTitleCounts, violations: operaTitleViolations, families: operaTitleFamilies,
      corpusLabel: 'tracked opera titles (public/data/mobile-shows.json, ty==="opera")',
      allowlist: OPERA_TITLE_EXCLUDE_ALLOWLIST, defaultMaxHits: OPERA_TITLE_EXCLUDE_DEFAULT_MAX_HITS,
    }));
  }

  process.exit(allViolations > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

// Exports for unit tests (scripts/audit-regex-patterns.test.mjs) — guarded
// above so requiring this file doesn't also execute main()/process.exit().
module.exports = {
  TITLE_EXCLUDE_FAMILIES,
  TITLE_EXCLUDE_DEFAULT_MAX_HITS,
  TITLE_EXCLUDE_ALLOWLIST,
  loadTitleExcludeFamilies,
  loadTitleCorpus,
  scanTitleFamilies,
  evaluateTitleFamilies,
  OPERA_TITLE_EXCLUDE_FAMILIES,
  OPERA_TITLE_EXCLUDE_DEFAULT_MAX_HITS,
  OPERA_TITLE_EXCLUDE_ALLOWLIST,
  loadOperaTitleExcludeFamilies,
  loadOperaTitleCorpus,
};
