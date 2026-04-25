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

// Pattern families we gate. Keys must match exported names from content-quality.js.
// Add new families here when they land in content-quality.js — the gate will pick them up.
const PATTERN_FAMILIES = [
  'AD_BLOCKER_PATTERNS',
  'PAYWALL_PATTERNS',
  'LEGAL_PAGE_PATTERNS',
  'COOKIE_CONSENT_PATTERNS',
  'ERROR_PAGE_PATTERNS',
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
// 2026-04-24 with ~30% headroom. If a pattern's baseline shifts materially,
// update this list rather than raising DEFAULT_MAX_HITS.
// Entry format: `${FAMILY}::${index}` → max allowed hits.
const PATTERN_ALLOWLIST = {
  // Paywall: HuffPost "Already a member"/"BECOME A MEMBER", subscriber prompts
  'PAYWALL_PATTERNS::7': 25,    // /already\s+a\s+(member|subscriber)/
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
  'NEWSLETTER_PATTERNS::6': 60,   // /join\s+(our\s+)?(mailing\s+)?list/
  // Navigation: scraped pages have real nav/footer bleed; the 5+ threshold in
  // detectNavigationJunk prevents single-match rejection
  'NAVIGATION_PATTERNS::0': 50,   // /^(home|about|contact|faq|...)\s*$/im
  'NAVIGATION_PATTERNS::1': 30,   // /skip\s+to\s+(main\s+)?content/
  'NAVIGATION_PATTERNS::2': 200,  // /\b(footer|header|sidebar|navigation|...)\b/
  'NAVIGATION_PATTERNS::4': 1200, // /related\s+(articles?|stories|posts)/
  'NAVIGATION_PATTERNS::5': 70,   // /popular\s+(articles?|stories|posts)/
  'NAVIGATION_PATTERNS::6': 400,  // /latest\s+(articles?|stories|news)/
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
  const showDirs = fs.readdirSync(dir).filter(d => {
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
    const out = { scanned, maxHits: args.maxHits, violations, allowlist: PATTERN_ALLOWLIST };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(reportText({ scanned, counts, violations, args, families }));
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main();
