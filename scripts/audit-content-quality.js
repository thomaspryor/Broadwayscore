#!/usr/bin/env node

/**
 * audit-content-quality.js
 *
 * Deep content quality audit for review-text files. Catches issues that
 * validate-data.js doesn't check:
 *
 * 1. Fabricated URLs (repeating UUID patterns, suspicious structures)
 * 2. Wrong-production content (review mentions different venue/director/year)
 * 3. Critic name mismatches (file says critic X but fullText says "Review by Y")
 * 4. URL-outlet domain mismatches (outletId=washpost but URL is journaltimes.com)
 * 5. Cross-show duplicate URLs (same URL used for different shows)
 * 6. fullText identical to excerpt (no real scrape happened)
 * 7. Source "web-search" reviews with suspicious data patterns
 *
 * Usage:
 *   node scripts/audit-content-quality.js [--fix] [--show=SLUG]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');

// Parse CLI args
const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const SHOW_FILTER = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Known outlet → domain mappings
const OUTLET_DOMAINS = {
  washpost: ['washingtonpost.com'],
  nytimes: ['nytimes.com', 'nyti.ms'],
  wsj: ['wsj.com'],
  vulture: ['vulture.com', 'nymag.com', 'thecut.com'],
  newyorker: ['newyorker.com'],
  variety: ['variety.com'],
  deadline: ['deadline.com'],
  timeout: ['timeout.com'],
  guardian: ['theguardian.com'],
  nypost: ['nypost.com'],
  'hollywood-reporter': ['hollywoodreporter.com'],
  observer: ['observer.com'],
  ew: ['ew.com'],
  theatermania: ['theatermania.com'],
  thewrap: ['thewrap.com'],
  nydailynews: ['nydailynews.com'],
  chicagotribune: ['chicagotribune.com'],
  telegraph: ['telegraph.co.uk'],
  financialtimes: ['ft.com'],
  latimes: ['latimes.com'],
  thestage: ['thestage.co.uk'],
};

// Track findings
const findings = {
  fabricatedUrls: [],
  wrongProduction: [],
  criticMismatch: [],
  domainMismatch: [],
  crossShowDuplicateUrls: [],
  textMatchesExcerpt: [],
  suspiciousWebSearch: [],
};

let totalFiles = 0;
let showsData;
try {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  showsData = raw.shows || raw;
} catch (e) {
  console.error('Could not load shows.json');
  process.exit(1);
}

// Build show lookup by ID
const showById = {};
if (Array.isArray(showsData)) {
  for (const s of showsData) showById[s.id] = s;
} else {
  for (const [id, s] of Object.entries(showsData)) showById[id] = s;
}

// Track all URLs across all shows for cross-show duplicate detection
const urlToFiles = {};

// Load and iterate all review-text files
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

for (const showDir of showDirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

  for (const file of files) {
    totalFiles++;
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      continue;
    }

    const relPath = `${showDir}/${file}`;
    const show = showById[showDir] || showById[data.showId];

    // Skip already-flagged wrong production/show reviews
    if (data.wrongProduction || data.wrongShow) continue;

    // ---- CHECK 1: Fabricated URLs ----
    if (data.url) {
      checkFabricatedUrl(data.url, relPath, data);
    }

    // ---- CHECK 2: Wrong production content ----
    if (data.fullText && show && !data.wrongProduction && !data.wrongShow) {
      checkWrongProduction(data.fullText, show, relPath, data);
    }

    // ---- CHECK 3: Critic name mismatch ----
    if (data.fullText && data.criticName) {
      checkCriticMismatch(data.fullText, data.criticName, relPath);
    }

    // ---- CHECK 4: URL-outlet domain mismatch ----
    if (data.url && data.outletId) {
      checkDomainMismatch(data.url, data.outletId, relPath);
    }

    // ---- CHECK 5: Track URLs for cross-show duplicate detection ----
    if (data.url) {
      const normalizedUrl = normalizeUrl(data.url);
      if (!urlToFiles[normalizedUrl]) urlToFiles[normalizedUrl] = [];
      urlToFiles[normalizedUrl].push(relPath);
    }

    // ---- CHECK 6: fullText identical to excerpt ----
    if (data.fullText) {
      checkTextMatchesExcerpt(data, relPath);
    }

    // ---- CHECK 7: Suspicious web-search source ----
    if (data.source === 'web-search') {
      checkSuspiciousWebSearch(data, relPath);
    }
  }
}

// Cross-show duplicate URLs
for (const [url, files] of Object.entries(urlToFiles)) {
  if (files.length > 1) {
    // Check if they're in different show directories
    const shows = new Set(files.map(f => f.split('/')[0]));
    if (shows.size > 1) {
      findings.crossShowDuplicateUrls.push({
        url: url.substring(0, 100),
        files,
        showCount: shows.size,
      });
    }
  }
}

// ---- Report ----
console.log('\n=== Content Quality Audit ===\n');
console.log(`Scanned ${totalFiles} review files across ${showDirs.length} shows\n`);

let totalIssues = 0;

function reportSection(title, items, severity) {
  if (items.length === 0) {
    console.log(`✅ ${title}: 0 issues`);
    return;
  }
  totalIssues += items.length;
  const icon = severity === 'error' ? '❌' : '⚠️';
  console.log(`${icon} ${title}: ${items.length} issue(s)`);
  for (const item of items) {
    if (typeof item === 'string') {
      console.log(`   ${item}`);
    } else {
      console.log(`   ${item.file || item.files?.join(', ')}: ${item.reason || item.url || ''}`);
    }
  }
  console.log();
}

reportSection('Fabricated URLs', findings.fabricatedUrls, 'error');
reportSection('Wrong Production Content', findings.wrongProduction, 'error');
reportSection('Critic Name Mismatch', findings.criticMismatch, 'warn');
reportSection('URL-Outlet Domain Mismatch', findings.domainMismatch, 'warn');
reportSection('Cross-Show Duplicate URLs', findings.crossShowDuplicateUrls, 'warn');
reportSection('fullText Matches Excerpt Only', findings.textMatchesExcerpt, 'warn');
reportSection('Suspicious web-search Source', findings.suspiciousWebSearch, 'warn');

console.log(`\nTotal issues: ${totalIssues}`);

// Write report
const reportPath = path.join(DATA_DIR, 'audit', 'content-quality-report.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  scannedAt: new Date().toISOString(),
  totalFiles,
  totalIssues,
  findings,
}, null, 2) + '\n');
console.log(`\nReport written to ${reportPath}`);

process.exit(totalIssues > 0 ? 1 : 0);


// ---- Check implementations ----

function checkFabricatedUrl(url, relPath, data) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/');

    // Check for repeating UUID patterns (like 8b8f4c4e-8b8f-4c4e-8b8f-4c4e8b8f4c4e)
    for (const part of pathParts) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) {
        // Check for repeating hex patterns
        const hex = part.replace(/-/g, '');
        const chunks = hex.match(/.{4}/g);
        const uniqueChunks = new Set(chunks);
        if (uniqueChunks.size <= 2) {
          findings.fabricatedUrls.push({
            file: relPath,
            reason: `Repeating UUID pattern: ${part}`,
            url,
          });
          return;
        }
      }
    }

    // Check for URLs that are clearly not review URLs
    if (parsed.hostname === 'example.com' || parsed.hostname === 'localhost') {
      findings.fabricatedUrls.push({
        file: relPath,
        reason: `Non-real domain: ${parsed.hostname}`,
        url,
      });
    }
  } catch (e) {
    findings.fabricatedUrls.push({
      file: relPath,
      reason: `Invalid URL format: ${url.substring(0, 80)}`,
    });
  }
}

function checkWrongProduction(fullText, show, relPath, data) {
  if (!fullText || fullText.length < 200) return;

  const text = fullText.toLowerCase();
  const showTitle = (show.title || '').toLowerCase();

  // Skip if show title isn't in text (already caught by showNotMentioned flag)
  // Focus on venue/director mismatches

  // NOTE: Tour/venue indicator checks removed — too many false positives.
  // Reviews legitimately mention Kennedy Center pre-Broadway runs, National Theatre
  // London origins, touring history, Ford's Theatre in plot context, etc.
  // The URL year check below is more precise.

  // Check for year mismatches in URL vs show opening date
  // Only flag if year difference is very large (>5 years) — long-running shows
  // legitimately have reviews from later years, and shows with pre-Broadway
  // runs may have earlier URLs
  if (data.url && show.openingDate) {
    try {
      const urlYear = extractYearFromUrl(data.url);
      const showYear = new Date(show.openingDate).getFullYear();
      // URL year before show opened by >3 years, or after by >5 years
      if (urlYear && ((showYear - urlYear > 3) || (urlYear - showYear > 5))) {
        findings.wrongProduction.push({
          file: relPath,
          reason: `URL year (${urlYear}) differs from show opening year (${showYear}) by ${Math.abs(urlYear - showYear)} years`,
          url: data.url,
        });
      }
    } catch (e) {}
  }

  // NOTE: Ford's Theatre check removed — Oh Mary! mentions it in plot context,
  // many reviews discuss historical context. URL year check is more precise.
}

function checkCriticMismatch(fullText, expectedCritic, relPath) {
  if (!fullText || fullText.length < 100) return;
  if (!expectedCritic || expectedCritic.toLowerCase() === 'unknown') return;

  // Look for "Review by X" or "By X" at the start of the text
  const bylinePatterns = [
    /Review by ([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/,
    /^(?:Democracy Dies in Darkness)?(?:clock[^.]*\.)?(?:\s*)By ([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/,
  ];

  for (const pattern of bylinePatterns) {
    const match = fullText.match(pattern);
    if (match) {
      const foundCritic = match[1].trim();
      const expectedNorm = expectedCritic.toLowerCase().replace(/[^a-z ]/g, '');
      const foundNorm = foundCritic.toLowerCase().replace(/[^a-z ]/g, '');

      // Check if names are different
      if (foundNorm !== expectedNorm &&
          !expectedNorm.includes(foundNorm) &&
          !foundNorm.includes(expectedNorm)) {
        findings.criticMismatch.push({
          file: relPath,
          reason: `File says "${expectedCritic}" but text says "by ${foundCritic}"`,
        });
      }
      break;
    }
  }
}

function checkDomainMismatch(url, outletId, relPath) {
  const expectedDomains = OUTLET_DOMAINS[outletId];
  if (!expectedDomains) return; // Unknown outlet, skip

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');

    if (!expectedDomains.some(d => hostname.includes(d))) {
      findings.domainMismatch.push({
        file: relPath,
        reason: `outletId="${outletId}" but URL domain is ${hostname}`,
        url: url.substring(0, 100),
      });
    }
  } catch (e) {}
}

function checkTextMatchesExcerpt(data, relPath) {
  if (!data.fullText) return;

  const text = data.fullText.trim();
  const excerpts = [
    data.dtliExcerpt,
    data.bwwExcerpt,
    data.showScoreExcerpt,
    data.nycTheatreExcerpt,
  ].filter(Boolean);

  for (const excerpt of excerpts) {
    const cleanExcerpt = excerpt.trim();
    const cleanText = text.replace(/^Democracy Dies in Darkness\s*/, '')
      .replace(/^Review by [A-Za-z ]+\s*/, '')
      .replace(/^clock[^.]*\.\s*/, '')
      .trim();

    // Check if fullText is essentially the same as the excerpt
    if (cleanText === cleanExcerpt ||
        (cleanText.length > 0 && cleanExcerpt.length > 0 &&
         cleanText.length < cleanExcerpt.length * 1.2 &&
         cleanExcerpt.includes(cleanText.substring(0, Math.min(100, cleanText.length))))) {
      findings.textMatchesExcerpt.push({
        file: relPath,
        reason: `fullText (${text.length} chars) essentially matches excerpt (${cleanExcerpt.length} chars) - no real scrape`,
      });
      break;
    }
  }
}

function checkSuspiciousWebSearch(data, relPath) {
  const suspicious = [];

  // web-search source with no aggregator excerpts or thumbs
  if (!data.dtliExcerpt && !data.bwwExcerpt && !data.showScoreExcerpt) {
    suspicious.push('no aggregator excerpts');
  }

  // web-search with fullText that exactly matches any excerpt
  if (data.fullText && data.dtliExcerpt && data.fullText.trim() === data.dtliExcerpt.trim()) {
    suspicious.push('fullText identical to dtliExcerpt');
  }
  if (data.fullText && data.showScoreExcerpt && data.fullText.trim() === data.showScoreExcerpt.trim()) {
    suspicious.push('fullText identical to showScoreExcerpt');
  }

  // web-search with null URL
  if (!data.url) {
    suspicious.push('null URL');
  }

  if (suspicious.length > 0) {
    findings.suspiciousWebSearch.push({
      file: relPath,
      reason: `web-search source: ${suspicious.join(', ')}`,
    });
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Keep query parameters for sites that use them for routing (e.g., story.asp?ID=X, page.php?id=X)
    // Strip only known tracking params (utm_*, fbclid, etc.)
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    const search = parsed.searchParams.toString();
    const base = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
    return search ? `${base}?${search}` : base;
  } catch {
    return url.toLowerCase();
  }
}

function extractYearFromUrl(url) {
  // Match year-like segments in URL paths: /2024/04/ or /2024-04-19 or /2024/
  // Must be a plausible year (1990-2030) to avoid matching article IDs like /6910/
  const match = url.match(/\/((?:19|20)\d{2})\//);
  if (match) return parseInt(match[1]);

  const match2 = url.match(/\/((?:19|20)\d{2})-/);
  if (match2) return parseInt(match2[1]);

  return null;
}
