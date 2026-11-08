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
 * INTENTIONALLY NOT SCHEDULED (audit #982): SERP rediscovery has a real
 * wrong-show contamination failure mode (task #947, P0 — validateShowMentioned
 * Check-2 generic idWords) — each --domain/--outlet sweep needs an operator
 * to pick the target and review the dry-run diff before --apply, not a cron
 * running unattended. Dispatched by hand per outlet/domain (see #914/#943).
 *
 * Usage:
 *   node scripts/recover-serp-text.js --domain=newyorker.com [options]
 *   node scripts/recover-serp-text.js --outlet=ap [options]
 *
 * Options:
 *   --domain=X       Outlet domain to target (newyorker.com). Matches data.url's hostname
 *                    or a registered domain alias.
 *   --outlet=X       Outlet ID to target (ap). Matches data.outletId directly — use for wire
 *                    services syndicated across many domains, where no single --domain covers
 *                    them (AP reviews live on apnews.com, hosted.ap.org, huffpost.com, local
 *                    papers, etc). One of --domain/--outlet is required.
 *   --limit=N        Max candidates to process (default: 20)
 *   --dry-run        Discovery + fetch only, no file writes
 *   --show=SLUG      Only process one show
 *   --force-exhausted  Override the proven-zero-sweep guard (see below)
 */

const fs = require('fs');
const path = require('path');

const { cleanText } = require('./lib/text-cleaning');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { setExtractedScore } = require('./lib/score-routing');
const { extractArticleText } = require('./lib/article-extractor');
const { discoverCorrectUrl, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('./lib/url-discovery');
const { evaluateCandidate, buildDomainOutletIds, isProvenZeroSweep } = require('./lib/serp-text-recovery-candidates');
const { fetchPage, unwrapRedirectUrl, cleanup } = require('./lib/scraper');
// One gate + one locked write for every recovery route (BRO-7171).
const { recoverReviewText, llmIdentityVerdict } = require('./lib/gap-acceptance');
const { checkpointReviewTexts: landReviewTexts, retryPendingPushes, createWriteTracker } = require('./lib/review-texts-checkpoint');

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
  reviewTextsDir: process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts'),
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

// Refuse a re-sweep of a pool already measured to a reproducible zero yield
// (see scripts/lib/serp-text-recovery-candidates.js's PROVEN_ZERO_SWEEP_*
// lists) — re-running these burns real SERP provider spend for no measured
// return. --force-exhausted overrides (e.g. the underlying registry/site
// changed since the 2026-08-16 measurement).
if (!args.includes('--force-exhausted') && isProvenZeroSweep({ domain: CONFIG.domain, outlet: CONFIG.outlet }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES)) {
  console.error(`  ⛔ ${CONFIG.outlet ? `--outlet=${CONFIG.outlet}` : `--domain=${CONFIG.domain}`} is a proven-zero sweep (Notion card 3b1637c5-416f-8163-a707-e156f5e1efc3, measured 2026-08-16) — re-running burns SERP spend for no yield. Pass --force-exhausted to override.`);
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Commit + push data/review-texts periodically DURING the run, not just at the
// end: a long local run left recovered files uncommitted for ~40 min while
// other local automation wrote the same checkout (2026-07-19: 22 recovered,
// 6 survived). BRO-7171: every write now happens under the shared
// review-texts lock, and this commits ONLY the files this run wrote (no
// `git add -A` sweeping up another writer's half-done edits). A failed push
// THROWS: the run stops, the commit is recorded as pending, and the next run
// pushes or restores it before doing anything new.
const RUN_WRITES = createWriteTracker();

function checkpointReviewTexts(label) {
  if (!RUN_WRITES.size) return null;
  const paths = [...RUN_WRITES];
  const res = landReviewTexts({ repoDir: CONFIG.reviewTextsDir, paths, message: `data: ${label} checkpoint` });
  for (const p of paths) RUN_WRITES.delete(p);
  console.log(`  [checkpoint] ${res.pushed ? 'pushed' : 'nothing new to push'}; ${res.landed.length} file(s) confirmed on origin/main`);
  for (const n of res.notLanded) console.log(`  [checkpoint] NOT on origin/main after push: ${n.rel}`);
  return res;
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
  const candidates = [];
  let scanned = 0, skippedComplete = 0, skippedFlagged = 0, skippedNoUrl = 0, skippedExhausted = 0, skippedWrongDomain = 0;

  const showDirs = fs.readdirSync(CONFIG.reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  // Which outletIds actually resolve to CONFIG.domain (or one of its
  // registered domain aliases, e.g. AP's apnews.com/abcnews.go.com pair) —
  // used to vet urlless candidates below. Built from the canonical
  // OUTLET_DOMAINS map (same one discoverCorrectUrl() reads) rather than
  // string-matching the outletId against the domain: outletIds are
  // frequently hyphenated in ways that don't literally contain the domain's
  // slug (hollywood-reporter vs hollywoodreporter.com), and a bare substring
  // match in the other direction produces false positives across unrelated
  // outlets (boston.com matching boston-globe, boston-herald, edge-boston,
  // ...). Alias-inclusive (ship-check finding, BRO-141): without it, an
  // urlless candidate for an outlet published on the alias TLD is invisible
  // to a --domain run targeting the primary domain, even though a
  // URL-bearing file for that same outlet would be recoverable.
  const domainOutletIds = CONFIG.outlet ? null : buildDomainOutletIds(CONFIG.domain, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES);

  for (const showDir of showDirs) {
    if (CONFIG.showFilter && showDir !== CONFIG.showFilter) continue;
    const showPath = path.join(CONFIG.reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      scanned++;
      const filePath = path.join(showPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // A missing url still qualifies in --domain mode when SERP keys are
      // configured: discoverCorrectUrl() resolves the target domain from
      // OUTLET_DOMAINS[outletId] (not from data.url), so it can find a fresh
      // URL from scratch. Without SERP keys there's nothing to anchor a
      // urlless file to, so it's correctly skipped. --outlet mode still
      // requires a url since there's no per-outlet domain to match against.
      // Generalized (BRO-141) beyond the original Telegraph-only backfill —
      // domainOutletIds resolves via OUTLET_DOMAINS for every outlet, so any
      // outlet's urlless thin-tier files are now eligible. Decision logic is
      // in scripts/lib/serp-text-recovery-candidates.js (unit-tested there).
      const hasSerpKeys = !!(CONFIG.scrapingBeeKey || CONFIG.brightDataKey);
      const { qualifies, skipReason } = evaluateCandidate(
        data,
        { domain: CONFIG.domain, outlet: CONFIG.outlet, hasSerpKeys, domainOutletIds, domainAliases: REGISTRY_DOMAIN_ALIASES },
        exhausted
      );
      if (!qualifies) {
        if (skipReason === 'no_url') skippedNoUrl++;
        else if (skipReason === 'wrong_domain') skippedWrongDomain++;
        else if (skipReason === 'complete') skippedComplete++;
        else if (skipReason === 'flagged') skippedFlagged++;
        else if (skipReason === 'exhausted') skippedExhausted++;
        continue;
      }

      const show = shows[data.showId] || {};
      candidates.push({
        show,
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
 * LLM identity verdict for a text found at a NEW url. Only asked when the
 * cheap proofs (aggregator excerpt overlap) did not settle identity.
 */
async function verifyMovedReview(candidate, cleanedText, newUrl) {
  const { verifyContent, resolveCvMarket } = require('./lib/content-verifier');
  const { isLongRunningProduction } = require('./lib/long-runner-registry');
  const review = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  const show = candidate.show || {};
  try {
    // venue-write-guard-ok: venue is prompt context for verifyContent, never written to data.
    const v = await verifyContent({
      scrapedText: cleanedText,
      excerpt: review.excerpt || null,
      showTitle: show.title || candidate.showId,
      criticName: review.criticName || null,
      outletName: review.outlet || review.outletId || null,
      url: newUrl,
      venue: show.venue || null,
      openingDate: show.openingDate || null,
      publishDate: review.publishDate || null,
      market: resolveCvMarket(show),
      isLongRunningProduction: isLongRunningProduction(show),
      show,
    });
    return llmIdentityVerdict(v);
  } catch (e) {
    console.log(`    LLM identity check failed: ${e.message.slice(0, 120)}`);
    return false;
  }
}

/**
 * Gate + write recovered text into the candidate's file through the shared
 * acceptRecoveredText gate (BRO-7171). newUrl === candidate.url means no URL
 * change (in-place text upgrade). Paid calls (LLM identity, score
 * extraction) run OUTSIDE the review-texts lock, between a decide-only pass
 * and the locked write, which re-reads the file and re-runs the gate.
 */
async function processRecovered(candidate, text, html, newUrl, method) {
  const labels = {
    fetchMethod: `serp-text-recovery-${method}`,
    sourceMethod: 'serp-text-recovery',
    contentTierReasonFallback: 'Recovered via SERP text recovery',
  };
  const url = newUrl || candidate.url;
  const ctxOpts = { reviewTextsDir: CONFIG.reviewTextsDir };
  let pre = recoverReviewText({ filePath: candidate.filePath, rawText: text, url, labels, dryRun: true, ctxOpts });
  // identity_unproven is the one refusal an LLM verdict can overturn.
  if (!pre.ok && pre.code === 'identity_unproven') {
    const cleaned = require('./lib/gap-acceptance').cleanCandidateText(text, { url, showId: candidate.showId });
    if (!cleaned.refused && !CONFIG.dryRun) {
      ctxOpts.llmIdentityVerified = await verifyMovedReview(candidate, cleaned.text, url);
      pre = recoverReviewText({ filePath: candidate.filePath, rawText: text, url, labels, dryRun: true, ctxOpts });
    }
  }
  if (!pre.ok) {
    console.log(`    Refused (${pre.code}): ${pre.reason}`);
    return { ok: false, reason: pre.code };
  }
  if (CONFIG.dryRun) {
    console.log(`    [DRY RUN] Would write ${pre.newLen} chars (${method})`);
    return { ok: true, reason: 'dry_run' };
  }

  let scoreResult = null;
  try {
    scoreResult = await extractExplicitScore({ text: pre.decision.cleanedText, html: html || '', outletId: candidate.outletId, showId: candidate.showId });
  } catch { /* score is optional */ }

  const r = recoverReviewText({
    filePath: candidate.filePath,
    rawText: text,
    url,
    labels,
    tracker: RUN_WRITES,
    ctxOpts,
    beforeWrite: (data) => {
      if (!scoreResult) return;
      const { field } = setExtractedScore(data, {
        value: scoreResult.originalScore,
        normalizedValue: scoreResult.normalizedScore,
        source: scoreResult.source,
      });
      console.log(`    Found ${field}: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100)`);
    },
  });
  if (!r.ok) {
    console.log(`    Refused at write (${r.code}): ${r.reason}`);
    return { ok: false, reason: r.code };
  }
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

  if (!CONFIG.dryRun) {
    // Push/restore what an earlier run committed but could not land
    // (BRO-7171). Throws on a still-failing push: no new work on a backlog.
    const pending = retryPendingPushes({ repoDir: CONFIG.reviewTextsDir });
    if (pending.entries) console.log(`  [pending] ${pending.entries} earlier checkpoint(s): ${pending.landed.length} landed, ${pending.restored.length} restored, ${pending.notLanded.length} not landed`);
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

    // Step 1: try re-fetching the existing URL directly (skipped when the
    // file has no url at all — nothing to re-fetch, go straight to SERP).
    let recovered = false;
    if (c.url) {
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
    } else {
      console.log(`  → No existing URL, going straight to SERP rediscovery`);
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

    if (!recovered && !CONFIG.dryRun && c.url) {
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

main()
  .catch(err => {
    console.error('FATAL ERROR:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // A successful Playwright fetch (fetchWithPlaywright's happy path) leaves
    // the Chromium browser process running for reuse and never closes it —
    // cleanup() closes it with a timeout guard. Without this, any run that
    // touches even one Playwright-fetched URL hangs forever after printing
    // its summary (same class as task #438's 45-min discover-new-shows.js hang).
    cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0));
  });
