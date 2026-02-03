#!/usr/bin/env node
/**
 * Backfill critic names for Playbill Verdict reviews with "unknown" critic.
 *
 * Strategy:
 * 1. Extract from URL patterns (HuffPost author slugs)
 * 2. Direct HTTP fetch + meta tag / JSON-LD / byline extraction
 * 3. ScrapingBee fallback for pages that block direct access
 *
 * Usage:
 *   node scripts/backfill-pv-critics.js [--dry-run] [--limit=N] [--outlet=X]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const outletArg = args.find(a => a.startsWith('--outlet='));
const outletFilter = outletArg ? outletArg.split('=')[1] : null;

const reviewsDir = 'data/review-texts';
const normalization = require('./lib/review-normalization');

// --- Collect PV unknown-critic reviews ---
function collectUnknowns() {
  const dirs = fs.readdirSync(reviewsDir).filter(d => {
    try { return fs.statSync(path.join(reviewsDir, d)).isDirectory(); } catch { return false; }
  });

  const unknowns = [];
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(reviewsDir, d)).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, d, f), 'utf8'));
        if (data.source === 'playbill-verdict' && (data.criticName || '').toLowerCase() === 'unknown') {
          if (outletFilter && data.outletId !== outletFilter) continue;
          unknowns.push({
            dir: d,
            file: f,
            filePath: path.join(reviewsDir, d, f),
            outletId: data.outletId,
            url: data.url || '',
            data
          });
        }
      } catch {}
    }
  }
  return unknowns;
}

// --- URL pattern extraction ---
function extractCriticFromUrl(url) {
  const lower = url.toLowerCase();

  // HuffPost: huffingtonpost.com/author-name/article
  const huffMatch = lower.match(/huffingtonpost\.com\/([a-z]+-[a-z]+(?:-[a-z]+)*)\//);
  if (huffMatch) {
    const slug = huffMatch[1];
    const skip = ['entry', 'news', 'post', 'blog', 'article', 'life', 'entertainment',
                  'culture', 'arts', 'theater', 'comedy', 'style', 'travel', 'food',
                  'tech', 'politics', 'business', 'world', 'us', 'media'];
    if (!skip.includes(slug)) {
      return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
  }

  return null;
}

// --- HTML author extraction ---
function extractAuthorFromHtml(html) {
  if (!html) return null;

  // Priority 1: Standard meta tags
  const metaPatterns = [
    /<meta\s+name="author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+name="author"/i,
    /<meta\s+property="article:author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+property="article:author"/i,
    /<meta\s+property="mrf:authors"\s+content="([^"]+)"/i,
    /<meta\s+name="parsely-author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+name="parsely-author"/i,
    /<meta\s+property=article:author\s+content="([^"]+)"/i,
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  // Priority 2: JSON-LD structured data
  const jsonLdPatterns = [
    // "author":[{"@type":"Person","name":"X"}]
    /"author"\s*:\s*\[\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i,
    // "author":{"@type":"Person","name":"X"}
    /"author"\s*:\s*\{\s*"@type"\s*:\s*"Person"[^}]*"name"\s*:\s*"([^"]+)"/i,
    // "author":{"name":"X"}
    /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i,
    // "author":"X" (string, not a number)
    /"author"\s*:\s*"([A-Z][a-z]+ [A-Z][a-z]+[^"]*)"/,
    // "author":["X"] (array of strings)
    /"author"\s*:\s*\[\s*"([A-Z][a-z]+ [A-Z][a-z]+[^"]*)"\s*\]/,
  ];

  for (const pattern of jsonLdPatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  // Priority 3: Byline elements
  const bylinePatterns = [
    // <... class="byline">By Name</...>
    /class="[^"]*byline[^"]*"[^>]*>(?:<[^>]+>)*\s*(?:By\s+)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // <h4 class="article-byline">By Name</h4>
    /class="article-byline"[^>]*>\s*(?:By\s+)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // itemprop="author"
    /itemprop="author"[^>]*>(?:<[^>]+>)*\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // rel="author"
    /rel="author"[^>]*>([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  ];

  for (const pattern of bylinePatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  return null;
}

function isValidAuthorName(name) {
  if (!name) return false;
  const trimmed = name.trim();
  // Must look like a person name: 2-4 words, reasonable length
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  if (trimmed.includes('<') || trimmed.includes('>')) return false;
  if (trimmed.includes('http') || trimmed.includes('www')) return false;
  // Must have at least 2 words
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  // Should not be a publication name
  const skipNames = ['the new', 'associated press', 'nbc', 'abc', 'cbs', 'fox', 'bloomberg',
                     'entertainment weekly', 'time out', 'daily news', 'new york',
                     'los angeles', 'chicago tribune', 'washington post', 'staff writer',
                     'staff reporter', 'theater critic', 'drama critic'];
  if (skipNames.some(s => trimmed.toLowerCase().includes(s))) return false;
  return true;
}

function cleanAuthorName(name) {
  let cleaned = name.trim();
  // Remove "By " prefix
  cleaned = cleaned.replace(/^By\s+/i, '');
  // Remove trailing punctuation
  cleaned = cleaned.replace(/[,;|]+$/, '').trim();
  // Title case
  cleaned = cleaned.split(/\s+/).map(w => {
    if (w.length <= 2) return w; // Don't touch short words like "de", "Le"
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
  return cleaned;
}

// --- HTTP fetch with timeout ---
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow'
    });

    clearTimeout(timer);

    if (!resp.ok) return { status: resp.status, html: null };

    const html = await resp.text();
    return { status: resp.status, html };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'error', error: e.message, html: null };
  }
}

// --- File operations ---
function updateReviewFile(filePath, dir, oldFile, outletId, criticName, data) {
  // Update the data
  data.criticName = criticName;

  // Generate new filename
  const normalizedCritic = normalization.normalizeCritic(criticName);
  const normalizedOutlet = normalization.normalizeOutlet(outletId);
  const newFile = `${normalizedOutlet}--${normalizedCritic}.json`;
  const newPath = path.join(reviewsDir, dir, newFile);

  if (oldFile === newFile) {
    // Same filename, just update content
    if (!dryRun) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return { renamed: false, newFile };
  }

  // Check if target file already exists (would be a duplicate)
  if (fs.existsSync(newPath)) {
    return { renamed: false, duplicate: true, newFile };
  }

  if (!dryRun) {
    // Write to new path, delete old
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
    fs.unlinkSync(filePath);
  }

  return { renamed: true, newFile };
}

// --- Main ---
async function main() {
  const unknowns = collectUnknowns();
  console.log(`Found ${unknowns.length} PV reviews with unknown critic`);
  if (outletFilter) console.log(`Filtering to outlet: ${outletFilter}`);
  if (dryRun) console.log('DRY RUN — no files will be modified');

  const toProcess = limit ? unknowns.slice(0, limit) : unknowns;
  console.log(`Processing ${toProcess.length} reviews\n`);

  let urlExtracted = 0;
  let httpExtracted = 0;
  let failed404 = 0;
  let failedNoAuthor = 0;
  let failedError = 0;
  let duplicatesSkipped = 0;
  let renamed = 0;
  let updated = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const u = toProcess[i];
    let critic = null;
    let method = '';

    // Step 1: URL pattern extraction
    critic = extractCriticFromUrl(u.url);
    if (critic) {
      method = 'url-pattern';
      urlExtracted++;
    }

    // Step 2: Direct HTTP fetch
    if (!critic && u.url) {
      const result = await fetchWithTimeout(u.url);

      if (result.status === 404 || result.status === 410) {
        failed404++;
        if (i < 5 || i % 200 === 0) console.log(`  [${i+1}/${toProcess.length}] 404: ${u.outletId} ${u.url.slice(0, 60)}`);
        continue;
      }

      if (result.html) {
        critic = extractAuthorFromHtml(result.html);
        if (critic) {
          method = 'http-fetch';
          httpExtracted++;
        } else {
          failedNoAuthor++;
        }
      } else {
        failedError++;
      }

      // Rate limit: 5 requests/second
      await new Promise(r => setTimeout(r, 200));
    }

    if (!critic) {
      if (i % 200 === 0) console.log(`  [${i+1}/${toProcess.length}] no author: ${u.outletId} ${u.url.slice(0, 60)}`);
      continue;
    }

    // Update file
    const result = updateReviewFile(u.filePath, u.dir, u.file, u.outletId, critic, u.data);

    if (result.duplicate) {
      duplicatesSkipped++;
      if (duplicatesSkipped <= 10) {
        console.log(`  [${i+1}] DUPE SKIP: ${u.dir}/${u.file} → ${result.newFile} already exists`);
      }
      // Delete the unknown file since the named one already exists
      if (!dryRun) {
        fs.unlinkSync(u.filePath);
      }
      continue;
    }

    if (result.renamed) {
      renamed++;
    } else {
      updated++;
    }

    if (i < 20 || i % 100 === 0) {
      const action = result.renamed ? 'RENAME' : 'UPDATE';
      console.log(`  [${i+1}] ${action} (${method}): ${u.dir}/${u.file} → ${critic}${result.renamed ? ' → ' + result.newFile : ''}`);
    }
  }

  console.log(`\n=== RESULTS ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`Processed: ${toProcess.length}`);
  console.log(`Critic extracted from URL: ${urlExtracted}`);
  console.log(`Critic extracted from HTTP: ${httpExtracted}`);
  console.log(`Total resolved: ${urlExtracted + httpExtracted}`);
  console.log(`Renamed files: ${renamed}`);
  console.log(`Updated in-place: ${updated}`);
  console.log(`Duplicates removed: ${duplicatesSkipped}`);
  console.log(`Failed - 404: ${failed404}`);
  console.log(`Failed - no author found: ${failedNoAuthor}`);
  console.log(`Failed - error: ${failedError}`);
  console.log(`Success rate: ${((urlExtracted + httpExtracted) / toProcess.length * 100).toFixed(1)}%`);
}

main().catch(console.error);
