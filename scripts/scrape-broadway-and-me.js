#!/usr/bin/env node
/**
 * Scrape Janice C. Simpson's reviews from Broadway & Me (broadwayandme.blogspot.com).
 *
 * Source: Blogger Atom feed (full HTML body in entry.content.$t).
 * No browser/proxy needed — feed is open and includes the entire post.
 *
 * Per-entry the feed gives us:
 *   - published date
 *   - title (e.g. 'Thrilling New Life for "Death of a Salesman"')
 *   - category[].term  → show name(s); roundup posts have ≥2 terms
 *   - content.$t       → full HTML body of the post
 *
 * We:
 *   1. Page through the feed (start-index) until we cross MIN_DATE
 *   2. Skip non-review labels (10 best list, lists, fall preview, etc.)
 *   3. For each review label, matchTitleToShow() → showId
 *   4. Roundups: write the same fullText to each matched show's file
 *   5. Save data/review-texts/{showId}/broadway-and-me--janice-c-simpson.json
 *      (do not overwrite existing files unless --force)
 *
 * Usage:
 *   node scripts/scrape-broadway-and-me.js --dry-run
 *   node scripts/scrape-broadway-and-me.js --dry-run --limit=10
 *   node scripts/scrape-broadway-and-me.js              # write files
 *   node scripts/scrape-broadway-and-me.js --force      # overwrite existing
 *   node scripts/scrape-broadway-and-me.js --since=2020-01-01
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { decodeHtmlEntities } = require('./lib/text-cleaning');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const MIN_DATE = args.find(a => a.startsWith('--since='))?.split('=')[1] || '2020-01-01';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FEED_URL = 'https://broadwayandme.blogspot.com/feeds/posts/default?alt=json';
const PAGE_SIZE = 150; // Blogger caps per-request results at ~150
const OUTLET_ID = 'broadway-and-me';
const OUTLET_NAME = 'Broadway & Me';
const CRITIC_NAME = 'Janice C. Simpson';
const CRITIC_SLUG = 'janice-c-simpson';
const FILENAME = `${OUTLET_ID}--${CRITIC_SLUG}.json`;

// Labels that indicate a non-review post (lists, roundups-of-the-year,
// holiday wishes, anniversary posts, etc). Lower-cased compare.
const NON_REVIEW_LABELS = new Set([
  '10 best list',
  'best list',
  'lists',
  'list',
  'fall preview',
  'spring preview',
  'summer preview',
  'winter preview',
  'season preview',
  'summer reading list',
  'reading list',
  'anniversary',
  'tony nominations',
  'tony awards',
  'awards',
  'in memoriam',
  'obituary',
]);

// Title patterns that signal a non-review post (label-less holiday/meta posts).
const NON_REVIEW_TITLE_PATTERNS = [
  /^happy /i,
  /^wishing /i,
  /^merry /i,
  /^thank/i,
  /thanksgiving/i,
  /^my .* (list|picks|favorites|favourites)/i,
  /^(spring|summer|fall|autumn|winter) preview/i,
  /tony nomination/i,
  /^the \d+ /i,            // "The 10 Most..." style
  /shows? .* meant the most/i,
  /best.*of \d{4}/i,
  /^a (christmas|new year)/i,
];

const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'BroadwayScorecard/1.0 (review aggregator; +https://broadwayscorecard.com)',
        'Accept': 'application/json',
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTML → readable plain text
// ---------------------------------------------------------------------------

function htmlToReadableText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('style, script, link, meta, .blogger-comment, .comments').remove();
  let text = $.root().text();
  // Old Word-pasted posts (e.g. once-on-this-island-2017) leak `mso-*` CSS as
  // raw text. Only strip CSS-style blocks when we actually see `{ ... }` pairs;
  // otherwise leave prose alone — prose can contain colons + semicolons that
  // would falsely match a `prop:value;` regex.
  if (text.includes('{') && text.includes('}')) {
    text = text
      .replace(/@(?:font-face|page|media|import)[^{]*\{[^}]*\}/g, ' ')
      .replace(/[a-zA-Z0-9_.#:\-,\s"]+\{[^}]*\}/g, ' ')
      .replace(/mso-[a-zA-Z\-]+\s*:\s*[^;{}]+;/g, ' ');
  }
  text = text.replace(/ /g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function wordCount(s) {
  return s ? s.trim().split(/\s+/).filter(Boolean).length : 0;
}

// ---------------------------------------------------------------------------
// Entry classification
// ---------------------------------------------------------------------------

function isNonReviewEntry(entry) {
  const title = (entry.title?.$t || '').trim();
  const labels = (entry.category || []).map(c => (c.term || '').trim());

  if (NON_REVIEW_TITLE_PATTERNS.some(rx => rx.test(title))) return 'title-pattern';

  // No labels at all → almost always a meta/holiday post
  if (labels.length === 0) return 'no-labels';

  // Every label is a non-review label
  const filtered = labels.filter(l => !NON_REVIEW_LABELS.has(l.toLowerCase()));
  if (filtered.length === 0) return 'all-labels-non-review';

  return null;
}

function getShowLabels(entry) {
  // Some posts use a single category term that joins multiple show titles with
  // "; " (e.g. "And Then We Were No More; This Much I Know"). Split those apart
  // so each title can match independently.
  const raw = (entry.category || []).map(c => (c.term || '').trim());
  const split = [];
  for (const term of raw) {
    if (term.includes(';')) {
      term.split(';').map(s => s.trim()).filter(Boolean).forEach(s => split.push(s));
    } else {
      split.push(term);
    }
  }
  return split.filter(l => l && !NON_REVIEW_LABELS.has(l.toLowerCase()));
}

function getEntryUrl(entry) {
  const link = (entry.link || []).find(l => l.rel === 'alternate' && l.type === 'text/html');
  return link ? link.href : null;
}

// ---------------------------------------------------------------------------
// Build review file payload
// ---------------------------------------------------------------------------

function buildReviewFile({ showId, showTitle, url, publishDate, fullText, isRoundup, sourceLabels }) {
  return {
    showId,
    outletId: OUTLET_ID,
    outlet: OUTLET_NAME,
    criticName: CRITIC_NAME,
    url,
    publishDate,
    fullText,
    isFullReview: true,
    contentTier: 'complete',
    contentTierReason: 'Full HTML body retrieved from Blogger Atom feed',
    showTitle,
    source: 'blogger-feed-broadway-and-me',
    sourceMethod: 'atom-feed',
    fetchMethod: 'atom-feed',
    fetchTier: 1,
    fetchAttempts: [{ tier: 1, method: 'atom-feed', success: true }],
    textWordCount: wordCount(fullText),
    wordCount: wordCount(fullText),
    textFetchedAt: new Date().toISOString(),
    textStatus: 'complete',
    textQuality: 'full',
    isRoundupSource: !!isRoundup,
    roundupShowLabels: isRoundup ? sourceLabels : undefined,
    originalScore: null,
    assignedScore: null,
    scoreSource: null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchAllEntries() {
  const collected = [];
  let startIndex = 1;
  let pageNo = 1;
  while (true) {
    const url = `${FEED_URL}&max-results=${PAGE_SIZE}&start-index=${startIndex}`;
    process.stderr.write(`[fetch] page ${pageNo} (start-index=${startIndex})\n`);
    const data = await fetchJSON(url);
    const entries = data.feed?.entry || [];
    if (entries.length === 0) break;
    collected.push(...entries);
    const lastDate = entries[entries.length - 1].published?.$t || '';
    if (lastDate < MIN_DATE) break;
    if (entries.length < PAGE_SIZE) break;
    startIndex += entries.length;
    pageNo++;
  }
  return collected;
}

async function main() {
  const shows = loadShows();
  process.stderr.write(`[load] ${shows.length} shows loaded\n`);

  const entries = await fetchAllEntries();
  const inWindow = entries.filter(e => (e.published?.$t || '') >= MIN_DATE);
  process.stderr.write(`[filter] ${inWindow.length} of ${entries.length} entries on/after ${MIN_DATE}\n`);

  const stats = {
    total: inWindow.length,
    skippedNonReview: 0,
    skippedNoMatch: 0,
    skippedExisting: 0,
    written: 0,
    perShow: 0,
  };

  const examples = { nonReview: [], noMatch: [], existing: [], written: [] };
  let processed = 0;

  for (const entry of inWindow) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    const title = entry.title?.$t || '(untitled)';
    const publishedFull = entry.published?.$t || '';
    const publishDate = publishedFull.slice(0, 10);
    const url = getEntryUrl(entry);

    const nonReason = isNonReviewEntry(entry);
    if (nonReason) {
      stats.skippedNonReview++;
      if (examples.nonReview.length < 5) examples.nonReview.push({ title, reason: nonReason, publishDate });
      continue;
    }

    const labels = getShowLabels(entry);
    const isRoundup = labels.length > 1;

    const matched = [];
    const unmatched = [];
    for (const label of labels) {
      const m = matchTitleToShow(label, shows, { year: parseInt(publishDate.slice(0, 4), 10), market: 'broadway' });
      // Reject `medium` (word-overlap) matches — they false-positive on multi-word
      // labels like "And Then We Were No More" → "this is not about me" where the
      // common word "this" produces a misleading hit.
      if (m && m.show && m.confidence === 'high') matched.push({ label, show: m.show, confidence: m.confidence });
      else unmatched.push(label);
    }

    if (matched.length === 0) {
      stats.skippedNoMatch++;
      if (examples.noMatch.length < 8) examples.noMatch.push({ title, labels, publishDate });
      continue;
    }

    const html = entry.content?.$t || entry.summary?.$t || '';
    const fullText = htmlToReadableText(html);

    if (wordCount(fullText) < 80) {
      stats.skippedNonReview++;
      if (examples.nonReview.length < 5) examples.nonReview.push({ title, reason: 'too-short', publishDate, words: wordCount(fullText) });
      continue;
    }

    for (const { label, show } of matched) {
      const showDir = path.join(reviewTextsDir, show.id);
      const filePath = path.join(showDir, FILENAME);
      const exists = fs.existsSync(filePath);

      if (exists && !FORCE) {
        stats.skippedExisting++;
        if (examples.existing.length < 5) examples.existing.push({ showId: show.id, title, publishDate });
        continue;
      }

      const payload = buildReviewFile({
        showId: show.id,
        showTitle: show.title || label,
        url,
        publishDate,
        fullText,
        isRoundup,
        sourceLabels: labels,
      });

      if (!DRY_RUN) {
        fs.mkdirSync(showDir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
      }
      stats.written++;
      stats.perShow++;
      if (examples.written.length < 8) examples.written.push({ showId: show.id, title, publishDate, words: wordCount(fullText), roundup: isRoundup });
    }
  }

  // ---- Report ----
  console.log('');
  console.log('=== Broadway & Me scrape report ===');
  console.log(`mode:           ${DRY_RUN ? 'DRY RUN' : 'WRITE'}${FORCE ? ' (force overwrite)' : ''}`);
  console.log(`since:          ${MIN_DATE}`);
  console.log(`entries:        ${stats.total} processed=${processed}`);
  console.log(`written:        ${stats.written} (${stats.perShow} show-files)`);
  console.log(`skip non-review:${stats.skippedNonReview}`);
  console.log(`skip no-match:  ${stats.skippedNoMatch}`);
  console.log(`skip existing:  ${stats.skippedExisting}`);

  const dump = (label, arr) => {
    if (!arr.length) return;
    console.log(`\n--- examples: ${label} ---`);
    for (const x of arr) console.log(' ', JSON.stringify(x));
  };
  dump('written', examples.written);
  dump('skipped non-review', examples.nonReview);
  dump('skipped no-match', examples.noMatch);
  dump('skipped existing', examples.existing);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err);
  process.exit(1);
});
