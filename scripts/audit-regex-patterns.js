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
  // Paywall: HuffPost "Already a member"/"BECOME A MEMBER", subscriber prompts.
  // 2026-04-28 recalibration: NYT "Already a subscriber? Log in" chrome bleeds
  // into ~28 archived NYT reviews (raw 28). Sized to baseline + 30%.
  'PAYWALL_PATTERNS::7': 40,    // /already\s+a\s+(member|subscriber)/ — raw 28
  'PAYWALL_PATTERNS::8': 15,    // /become\s+a\s+(member|subscriber)/
  'PAYWALL_PATTERNS::11': 20,   // /exclusive\s+(content|access)/
  // Legal: copyright footers are ubiquitous in scraped content
  'LEGAL_PAGE_PATTERNS::0': 50,   // /^privacy\s+policy/im
  'LEGAL_PAGE_PATTERNS::1': 20,   // /^terms\s+(of\s+)?(use|service)/im
  'LEGAL_PAGE_PATTERNS::5': 300,  // /all\s+rights\s+reserved\./
  'LEGAL_PAGE_PATTERNS::6': 1000, // /©\s*\d{4}.*all\s+rights\s+reserved/
  // Cookie consent: Telegraph GDPR text bleeds into many Telegraph scrapes
  'COOKIE_CONSENT_PATTERNS::1': 100, // /legitimate\s+interest/
  // Newsletter: real newsletter prompts in Guardian, artsdesk, TimeOut scrapes —
  // leading/trailing-junk mitigation absorbs them in isGarbageContent
  'NEWSLETTER_PATTERNS::0': 150,  // /thanks?\s+for\s+subscribing/
  'NEWSLETTER_PATTERNS::1': 150,  // /enter\s+your\s+email/
  'NEWSLETTER_PATTERNS::5': 15,   // /newsletter\s+sign[-\s]?up/ — raw 10 (HuffPost/TheaterMania footer)
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
  'NAVIGATION_PATTERNS::7': 10,   // /trending\s+(now|stories|articles)/ — raw 6
  // Wrong-article: ^breaking news catches genuine news-sidebar pollution
  'WRONG_ARTICLE_PATTERNS::7': 50, // /^breaking\s+news/im
  // Paywall: bare /paywall/i matches critics discussing their publication's
  // funding model in trailing editor notes — absorbed by trailing-junk mitigation
  'PAYWALL_PATTERNS::12': 20, // /paywall/i
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
  'HORROR_FILM_PATTERNS::1': 150, // /horror\s*(film|movie|sequel)/ — raw 107
  'HORROR_FILM_PATTERNS::3': 70,  // /haunted\s+(family|house|lambert)/ — raw 47
  'HORROR_FILM_PATTERNS::4': 20,  // /spirit\s+world/ — raw 9
  'HORROR_FILM_PATTERNS::5': 15,  // /scary\s+movies?/ — raw 5
  'HORROR_FILM_PATTERNS::6': 80,  // /horror\s+film/ — raw 43 (duplicate of ::1)
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
    commit: '07bfb0c497',
    date: '2026-04-28',
    rawHits: 6,
    headroom: 1.7,
    note: '/trending (now|stories|articles)/ — recent-articles widget bleed. '
        + 'Sized to default-+30%; widget appears on most modern outlet '
        + 'review pages.',
  },
  'NEWSLETTER_PATTERNS::5': {
    commit: '07bfb0c497',
    date: '2026-04-28',
    rawHits: 10,
    headroom: 1.5,
    note: 'HuffPost/TheaterMania newsletter widget footer. Caught in '
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
};

const DEFAULT_MAX_HITS = 5;
const DEFAULT_SAMPLE_SHOWS = 400;
const MAX_REVIEWS_PER_SHOW = 30;

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

  if (args.json) {
    const out = { scanned, maxHits: args.maxHits, violations, allowlist: PATTERN_ALLOWLIST, calibration: PATTERN_CALIBRATION };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(reportText({ scanned, counts, violations, args, families }));
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main();
