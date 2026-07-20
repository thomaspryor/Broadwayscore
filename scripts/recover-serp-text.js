#!/usr/bin/env node

/**
 * Recover full text for thin (truncated/excerpt/stub) T1 reviews by re-fetching
 * the live page — either the file's existing URL, or a fresh URL found via
 * Google SERP when the existing one is stale/wrong.
 *
 * Built for New Yorker + AP: unlike WSJ (recover-wayback-reviews.js handles
 * that via the Wayback Machine), these outlets' original excerpt-only capture
 * often used the CORRECT domain but a URL that has since moved or a fetch path
 * that got paywall-limited. A plain fetchPage() re-fetch of the current live
 * URL — no cookies, no login — recovers full text in a meaningful fraction of
 * cases (2026-07-19 probe: 2/12 New Yorker URLs, no auth). When the existing
 * URL 404s or the re-fetch is still thin, SERP rediscovery finds the article's
 * current URL and that gets fetched instead.
 *
 * Usage:
 *   node scripts/recover-serp-text.js --domain=newyorker.com [options]
 *   node scripts/recover-serp-text.js --outlet=ap [options]
 *
 * Options:
 *   --domain=X       Outlet domain to target (newyorker.com). Matches data.url's hostname.
 *   --outlet=X       Outlet ID to target (ap). Matches data.outletId directly — use for wire
 *                    services syndicated across many domains, where no single --domain covers
 *                    them (AP reviews live on apnews.com, hosted.ap.org, huffpost.com, local
 *                    papers, etc). One of --domain/--outlet is required.
 *   --limit=N        Max candidates to process (default: 20)
 *   --dry-run        Discovery + fetch only, no file writes
 *   --show=SLUG      Only process one show
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { classifyContentTier, isGarbageContent, validateShowMentioned, countWords } = require('./lib/content-quality');
const { cleanText, stripTrailingJunk } = require('./lib/text-cleaning');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { setExtractedScore } = require('./lib/score-routing');
const { extractArticleText } = require('./lib/article-extractor');
const { discoverCorrectUrl } = require('./lib/url-discovery');
const { updateFileUrlWithInvariant } = require('./lib/url-change-invariant');
const { fetchPage, unwrapRedirectUrl } = require('./lib/scraper');

const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const CONFIG = {
  domain: getArg('domain'),
  // --outlet matches data.outletId directly instead of the URL's hostname.
  // Needed for wire-service outlets like AP, whose reviews live on dozens of
  // syndication domains (apnews.com, hosted.ap.org, huffpost.com,
  // washingtonpost.com, local papers, ...) — no single --domain covers them.
  outlet: getArg('outlet'),
  limit: parseInt(getArg('limit') || '20', 10),
  dryRun: args.includes('--dry-run'),
  showFilter: getArg('show') || null,
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  showsPath: path.join(__dirname, '..', 'data', 'shows.json'),
  exhaustedPath: path.join(__dirname, '..', 'data', 'audit', 'serp-text-exhausted.json'),
  minTextLength: 300,
  itemDelayMs: parseInt(process.env.ITEM_DELAY_MS || '2000', 10),
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  brightDataKey: process.env.BRIGHTDATA_TOKEN || '',
};

if (!CONFIG.domain && !CONFIG.outlet) {
  console.error('Usage: node scripts/recover-serp-text.js (--domain=newyorker.com | --outlet=ap) [--limit=N] [--dry-run] [--show=SLUG]');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Commit + push data/review-texts periodically DURING the run, not just at the
// end. A long local run (30-60 min for 100+ candidates) leaves every recovered
// file sitting uncommitted the whole time — this machine also runs scheduled
// local automation (launchd: autonomous-nightly, backfill-gather) against the
// SAME checkout, and a concurrent write to the same file is a filesystem race
// git can't protect against (no conflict is ever raised — whoever's write
// lands last on disk wins, and `git add` only ever sees the current state).
// 2026-07-19: a ~40min New Yorker run recovered 22 files; only 6 survived to
// the final commit because most were silently overwritten mid-run before this
// script ever got to `git add`. Committing every few recoveries shrinks that
// exposure window from ~40 min to a couple of minutes.
function checkpointReviewTexts(label) {
  try {
    execSync('git add -A', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
    try {
      execSync('git diff --staged --quiet', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
      return; // nothing to commit
    } catch { /* has staged changes */ }
    execSync(`git commit -m "data: ${label} checkpoint"`, { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execSync('git pull --rebase -X theirs origin main', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
        // -X theirs favors the LOCAL (this script's) commits on conflicting hunks
        // per rebase semantics, but this codebase has documented, incident-backed
        // evidence that concurrent writes to the same JSON file's fields still get
        // dropped in practice — restore-protected-fields.js is the established
        // safety net (same pattern as rediscover-review-urls.js's
        // pushReviewTextsCheckpoint). Re-applies fullText and other protected
        // fields from pre-rebase HEAD if the rebase silently lost them.
        try {
          const restoreScriptPath = path.resolve(__dirname, 'lib', 'restore-protected-fields.js');
          const restored = execSync(`node "${restoreScriptPath}" origin/main`, { cwd: CONFIG.reviewTextsDir, encoding: 'utf8', stdio: 'pipe' }).trim();
          if (parseInt(restored, 10) > 0) {
            console.log(`  [checkpoint] restored protected fields in ${restored} file(s) after rebase`);
            execSync('git add -A', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
            execSync('git commit --amend --no-edit', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
          }
        } catch (restoreErr) {
          console.log(`  [checkpoint] restore-protected-fields failed: ${restoreErr.message.slice(0, 200)}`);
        }
        execSync('git push origin main', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' });
        console.log(`  [checkpoint] pushed review-texts (attempt ${attempt})`);
        return;
      } catch (e) {
        try { execSync('git rebase --abort', { cwd: CONFIG.reviewTextsDir, stdio: 'pipe' }); } catch {}
        if (attempt === 3) console.log(`  [checkpoint] WARNING: failed to push after 3 attempts: ${e.message.slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.log(`  [checkpoint] error: ${e.message.slice(0, 200)}`);
  }
}

function loadExhausted() {
  try { return JSON.parse(fs.readFileSync(CONFIG.exhaustedPath, 'utf8')).urls || {}; }
  catch { return {}; }
}

// Merges with whatever is currently on disk (not just what this process started
// from) so a concurrent recovery run's exhausted entries survive — a flat
// overwrite from an in-memory snapshot would silently erase them.
function saveExhausted(newEntries) {
  const dir = path.dirname(CONFIG.exhaustedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const onDisk = loadExhausted();
  const merged = { ...onDisk, ...newEntries };
  fs.writeFileSync(CONFIG.exhaustedPath, JSON.stringify({ urls: merged, lastUpdated: new Date().toISOString(), totalCount: Object.keys(merged).length }, null, 2) + '\n');
}

function loadCandidates() {
  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) shows[s.id || s.slug] = s;
  } catch {}

  const exhausted = loadExhausted();
  const thinTiers = new Set(['truncated', 'excerpt', 'stub']);
  const candidates = [];
  let scanned = 0, skippedComplete = 0, skippedFlagged = 0, skippedNoUrl = 0, skippedExhausted = 0, skippedWrongDomain = 0;

  const showDirs = fs.readdirSync(CONFIG.reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const showDir of showDirs) {
    if (CONFIG.showFilter && showDir !== CONFIG.showFilter) continue;
    const showPath = path.join(CONFIG.reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      scanned++;
      const filePath = path.join(showPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (!data.url) { skippedNoUrl++; continue; }
      if (CONFIG.outlet) {
        if ((data.outletId || '') !== CONFIG.outlet) { skippedWrongDomain++; continue; }
      } else {
        let domain;
        try { domain = new URL(data.url).hostname.replace(/^www\./, ''); } catch { continue; }
        if (domain !== CONFIG.domain) { skippedWrongDomain++; continue; }
      }

      if (data.contentTier === 'complete') { skippedComplete++; continue; }
      if (!thinTiers.has(data.contentTier)) continue;
      if (data.wrongShow || data.wrongProduction || data.wrongAttribution || data.isRoundupArticle) { skippedFlagged++; continue; }
      if (exhausted[data.url]) { skippedExhausted++; continue; }

      const show = shows[data.showId] || {};
      candidates.push({
        filePath,
        reviewId: `${showDir}/${file}`,
        showId: data.showId,
        outletId: data.outletId || file.split('--')[0],
        outlet: data.outlet,
        criticName: data.criticName || 'Unknown',
        url: data.url,
        existingTextLength: (data.fullText || '').length,
        openingDate: show.openingDate || '2000-01-01',
      });
    }
  }

  candidates.sort((a, b) => b.openingDate.localeCompare(a.openingDate));

  console.log(`Scanned: ${scanned}`);
  console.log(`Skipped (complete): ${skippedComplete}, (flagged): ${skippedFlagged}, (no url): ${skippedNoUrl}, (wrong domain): ${skippedWrongDomain}, (exhausted): ${skippedExhausted}`);
  console.log(`Candidates for ${CONFIG.outlet ? `outlet=${CONFIG.outlet}` : CONFIG.domain}: ${candidates.length}`);

  return candidates.slice(0, CONFIG.limit);
}

/**
 * Fetch a URL and extract clean article text. Returns { text, html } or null.
 */
async function fetchAndExtract(url) {
  let result;
  try {
    result = await fetchPage(url, { skipVerify: true });
  } catch (e) {
    console.log(`    fetchPage error: ${e.message}`);
    return null;
  }
  if (!result || !result.content) return null;

  let host = '';
  try { host = new URL(url).hostname; } catch {}
  let text = extractArticleText(result.content, host);
  if (!text) return null;

  text = cleanText(text);
  return { text, html: result.content };
}

/**
 * Quality-gate + write recovered text into the candidate's file.
 * newUrl === candidate.url means no URL change (in-place text upgrade).
 */
async function processRecovered(candidate, text, html, newUrl, method) {
  let cleanedText = stripTrailingJunk(text, candidate.outletId);

  if (cleanedText.length < CONFIG.minTextLength) {
    console.log(`    Too short after cleaning: ${cleanedText.length} chars`);
    return { ok: false, reason: 'too_short' };
  }
  if (cleanedText.length <= candidate.existingTextLength) {
    console.log(`    Not longer than existing (${cleanedText.length} <= ${candidate.existingTextLength})`);
    return { ok: false, reason: 'not_longer' };
  }

  const garbageCheck = isGarbageContent(cleanedText);
  if (garbageCheck.isGarbage) {
    console.log(`    Garbage content: ${garbageCheck.reason}`);
    return { ok: false, reason: 'garbage' };
  }

  const showTitle = candidate.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const mentionResult = validateShowMentioned(cleanedText, showTitle, candidate.showId);
  if (!mentionResult.valid) {
    console.log(`    Show not mentioned: "${showTitle}"`);
    return { ok: false, reason: 'wrong_show' };
  }

  if (CONFIG.dryRun) {
    console.log(`    [DRY RUN] Would write ${cleanedText.length} chars (${method})`);
    return { ok: true, reason: 'dry_run' };
  }

  const metadata = {
    textFetchedAt: new Date().toISOString(),
    fetchMethod: `serp-text-recovery-${method}`,
  };

  let data;
  if (newUrl !== candidate.url) {
    // stampOnNoop: a canonical-equivalent rewrite (protocol/tracking-param-only
    // diff) makes updateFileUrlWithInvariant return null even though it's not a
    // refusal — without stampOnNoop that silently drops the recovery and
    // blacklists a perfectly good URL (mirrors rediscover-review-urls.js's
    // fallback branch, which hits the same ambiguity).
    const updated = updateFileUrlWithInvariant(candidate.filePath, newUrl, {
      ...metadata,
      urlDiscoveredAt: metadata.textFetchedAt,
      urlDiscoveryMethod: 'google-serp',
    }, { stampOnNoop: true });
    if (!updated) {
      console.log(`    URL-invariant write refused (cross-outlet or unreadable)`);
      return { ok: false, reason: 'invariant_refused' };
    }
    data = updated;
  } else {
    data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  }

  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = countWords(cleanedText);
  data.textFetchedAt = metadata.textFetchedAt;
  data.fetchMethod = metadata.fetchMethod;
  data.sourceMethod = 'serp-text-recovery';
  delete data.incompleteReason;
  delete data.incompleteDetail;

  const tierResult = classifyContentTier(data);
  data.contentTier = tierResult.contentTier || tierResult.tier;
  data.contentTierReason = tierResult.tierReason || tierResult.reason || 'Recovered via SERP text recovery';

  try {
    const scoreResult = await extractExplicitScore({ text: cleanedText, html: html || '', outletId: candidate.outletId });
    if (scoreResult) {
      const { field } = setExtractedScore(data, {
        value: scoreResult.originalScore,
        normalizedValue: scoreResult.normalizedScore,
        source: scoreResult.source,
      });
      console.log(`    Found ${field}: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100)`);
    }
  } catch {}

  if (data.llmScore && data.llmScore.score) {
    data.needsRescore = true;
    data.rescoreReason = 'fullText recovered via SERP text recovery';
  }

  fs.writeFileSync(candidate.filePath, JSON.stringify(data, null, 2) + '\n');
  return { ok: true, reason: method };
}

async function main() {
  console.log('SERP Text Recovery');
  console.log('===================');
  console.log(`  ${CONFIG.outlet ? `Outlet: ${CONFIG.outlet}` : `Domain: ${CONFIG.domain}`}`);
  console.log(`  Limit: ${CONFIG.limit}`);
  console.log(`  Dry run: ${CONFIG.dryRun}\n`);

  if (!CONFIG.scrapingBeeKey && !CONFIG.brightDataKey) {
    console.log('  Note: no SERP keys configured — will only retry existing URLs, no rediscovery.');
  }

  const candidates = loadCandidates();
  if (candidates.length === 0) {
    console.log('\nNo candidates to process.');
    return;
  }

  const exhausted = loadExhausted();
  const stats = { recovered: 0, sameUrl: 0, serpRediscovered: 0, notFound: 0, tooShort: 0, garbage: 0, wrongShow: 0, notLonger: 0, fetchFailed: 0 };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    console.log(`\n[${i + 1}/${candidates.length}] ${c.reviewId} (${c.criticName})`);
    console.log(`  URL: ${c.url}`);

    // Step 1: try re-fetching the existing URL directly.
    let recovered = false;
    const existingFetch = await fetchAndExtract(c.url);
    if (existingFetch) {
      const result = await processRecovered(c, existingFetch.text, existingFetch.html, c.url, 'same-url');
      if (result.ok) {
        console.log(`  ✓ RECOVERED via same-url re-fetch`);
        stats.recovered++;
        stats.sameUrl++;
        recovered = true;
      } else {
        stats[result.reason] = (stats[result.reason] || 0) + 1;
      }
    } else {
      console.log(`  → Existing URL fetch failed/empty`);
    }

    // Step 2: SERP rediscovery if same-url didn't work.
    if (!recovered && (CONFIG.scrapingBeeKey || CONFIG.brightDataKey)) {
      const newUrl = await discoverCorrectUrl(
        { showId: c.showId, outletId: c.outletId, outlet: c.outlet, url: c.url, criticName: c.criticName },
        CONFIG.scrapingBeeKey,
        { brightDataKey: CONFIG.brightDataKey }
      );

      if (newUrl === '__SERP_UNAVAILABLE__') {
        console.log(`  ⚠ SERP providers unavailable`);
      } else if (!newUrl) {
        console.log(`  → No SERP match found`);
        stats.notFound++;
      } else {
        // Defensive unwrap: a BD Web Unlocker HTML-regex result is normally
        // already unwrapped at discovery time, but this is the same guard
        // review-write-guard.js applies at its write chokepoint — cheap
        // insurance against ever persisting a google.com/url?q=... wrapper.
        const cleanUrl = unwrapRedirectUrl(newUrl);
        console.log(`  → SERP found: ${cleanUrl}`);
        const rediscoveredFetch = await fetchAndExtract(cleanUrl);
        if (rediscoveredFetch) {
          const result = await processRecovered(c, rediscoveredFetch.text, rediscoveredFetch.html, cleanUrl, 'serp-rediscovery');
          if (result.ok) {
            console.log(`  ✓ RECOVERED via SERP rediscovery`);
            stats.recovered++;
            stats.serpRediscovered++;
            recovered = true;
          } else {
            stats[result.reason] = (stats[result.reason] || 0) + 1;
          }
        } else {
          console.log(`  → Rediscovered URL fetch failed/empty`);
          stats.fetchFailed++;
        }
      }
    }

    if (!recovered && !CONFIG.dryRun) {
      exhausted[c.url] = { reason: 'recovery_exhausted', lastAttempt: new Date().toISOString() };
    }

    if (!CONFIG.dryRun && (i + 1) % 5 === 0) {
      saveExhausted(exhausted);
      checkpointReviewTexts(`SERP text recovery (${CONFIG.outlet || CONFIG.domain}, ${i + 1}/${candidates.length})`);
      console.log(`\n  [checkpoint] ${stats.recovered}/${i + 1} recovered so far`);
    }

    await sleep(CONFIG.itemDelayMs);
  }

  if (!CONFIG.dryRun) {
    saveExhausted(exhausted);
    checkpointReviewTexts(`SERP text recovery (${CONFIG.outlet || CONFIG.domain}, final)`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
