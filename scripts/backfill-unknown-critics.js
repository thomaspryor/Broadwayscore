#!/usr/bin/env node
/**
 * Backfill unknown outlets and critics across ALL review sources.
 *
 * Phase A: Outlet resolution (local, no HTTP) — resolves "unknown" outletId from URL domain
 * Phase B: Critic enrichment (HTTP fetch) — extracts author from review page HTML
 *
 * Usage:
 *   node scripts/backfill-unknown-critics.js [options]
 *
 * Options:
 *   --dry-run         Show what would change without modifying files
 *   --limit=N         Process at most N files per phase
 *   --outlets-only    Run only Phase A (outlet resolution)
 *   --critics-only    Run only Phase B (critic enrichment)
 *   --skip-http       Skip HTTP fetches in Phase B (only use existing extractedByline)
 *   --source=X        Filter to specific source (e.g., playbill-verdict, showscore)
 *   --show=X          Filter to specific show directory
 *   --outlet-id=X,Y   Filter to specific outletId(s), comma-separated
 *   --time-budget-min=N  Wall-clock budget in minutes for Phase B's HTTP
 *                     fetch loop (0/omitted = unlimited)
 */

const fs = require('fs');
const path = require('path');

// Load .env if available (launchd/cron/worktree runs don't inherit a login shell)
require('./lib/load-env').loadEnv();

const { safeWriteReview, safeRenameReview, safeUnlinkReview, shouldSkipLockedEnrichment } = require('./lib/review-write-guard');
const { listShowDirs } = require('./lib/list-show-dirs');

let lockedSkipCount = 0;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outletsOnly = args.includes('--outlets-only');
const criticsOnly = args.includes('--critics-only');
const skipHttp = args.includes('--skip-http');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const sourceArg = args.find(a => a.startsWith('--source='));
const sourceFilter = sourceArg ? sourceArg.split('=')[1] : null;
const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;
const outletIdArg = args.find(a => a.startsWith('--outlet-id='));
const outletIdFilter = outletIdArg ? new Set(outletIdArg.split('=')[1].split(',')) : null;

const reviewsDir = 'data/review-texts';
const normalization = require('./lib/review-normalization');
const { extractAuthorFromHtml, isValidAuthorName, cleanAuthorName } = require('./lib/content-quality');
const { resolveOutletFromUrl, getOutletDisplayName } = require('./lib/review-normalization');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');
const { isJunkCriticName, nameFromJunkCriticName } = require('./lib/byline-recovery');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const USAGE = `backfill-unknown-critics.js — Backfill unknown outlets and critics across ALL review sources.

Usage:
  node scripts/backfill-unknown-critics.js [options]
  node scripts/backfill-unknown-critics.js --help, -h    print this usage and exit
`;
const timeBudget = createRunBudget(parseTimeBudgetMin(args));
// --- Names that are NOT theater critics (outlet names, wire service labels, etc.) ---
const REJECT_NAMES = new Set([
  'condé nast', 'conde nast', 'the associated press', 'associated press',
  'ap', 'reuters', 'staff', 'staff writer', 'editorial', 'editor',
  'admin', 'administrator', 'contributor', 'guest', 'anonymous',
  'broadway world', 'broadwayworld', 'broadway.com', 'playbill',
  'the new yorker', 'the guardian', 'variety', 'the wrap',
  'the hollywood reporter', 'the daily beast', 'entertainment weekly',
  'ny1', 'time out', 'timeout', 'new york times', 'the new york times',
  'bww news desk', 'broadway news desk', 'news desk',
  'financial times', 'the stage', 'the playlist', 'the reviews hub',
]);

function isRejectName(name) {
  if (!name || name.length < 4) return true;
  if (isJunkCriticName(name)) return true;
  if (REJECT_NAMES.has(name.toLowerCase())) return true;
  if (/^(the |a |an )/i.test(name) && !name.includes(' ')) return true;
  if (name.includes(',') && name.split(',').length > 2) return true;
  if (/\band\b/i.test(name) && name.split(/\band\b/i).length > 2) return true;
  if (name.includes('http') || name.includes('.com')) return true;
  if (name === name.toUpperCase() && name.length > 5) return true;
  if (name === name.toLowerCase()) return true;
  if (/^(reviewed by|written by|by |photo |image |credit)/i.test(name)) return true;
  if (/^(staff|desk|team|wire|bureau|press|agency|service)/i.test(name)) return true;
  if (/^(updated|originally|published|posted|modified|created)\s/i.test(name)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s/i.test(name)) return true;
  if (!name.includes(' ')) return true;
  return false;
}

// --- Scan all review files ---
function scanReviewFiles() {
  const dirs = listShowDirs(reviewsDir).filter(d => {
    if (showFilter && d !== showFilter) return false;
    return true;
  });

  const unknownOutlets = [];
  const unknownCritics = [];

  for (const d of dirs) {
    const files = fs.readdirSync(path.join(reviewsDir, d)).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );
    for (const f of files) {
      try {
        const filePath = path.join(reviewsDir, d, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (sourceFilter && data.source !== sourceFilter) continue;
        if (outletIdFilter && !outletIdFilter.has(data.outletId)) continue;

        const entry = { dir: d, file: f, filePath, outletId: data.outletId, url: data.url || '', data };

        if ((!data.outletId || data.outletId === 'unknown') && data.url) {
          unknownOutlets.push(entry);
        }

        // BRO-4502: a junk byline ("Read more articles by X", "Sam - Admin",
        // "nick730") is as unnamed as Unknown; Phase B re-reads it through the
        // same guarded applyPageByline path.
        if ((!data.criticName || data.criticName === 'Unknown' || isJunkCriticName(data.criticName)) && data.url) {
          unknownCritics.push(entry);
        }
      } catch {}
    }
  }

  return { unknownOutlets, unknownCritics };
}

// --- HTTP fetch via scraper infrastructure (Bright Data → ScrapingBee → Playwright) ---
async function fetchHtml(url) {
  try {
    const result = await fetchPage(url);
    if (result && result.content && result.content.length > 100) {
      return { html: result.content };
    }
    return { html: null };
  } catch (e) {
    return { html: null, error: e.message };
  }
}

// --- Update file and optionally rename ---
// Joe Turner postmortem P0 #2 (2026-04-26): criticName + outletId are
// non-PROTECTED — safeWriteReview's lockedOverride does not block them.
// shouldSkipLockedEnrichment short-circuits the whole update on locked files
// so a manually-canonical record can't have its byline silently rewritten by
// HTML extraction or domain re-aliasing.
function updateReviewFile(filePath, dir, oldFile, outletId, criticName, data) {
  const skip = shouldSkipLockedEnrichment(data);
  if (skip.skip) {
    lockedSkipCount++;
    return { renamed: false, lockedSkipped: true };
  }

  if (criticName) data.criticName = criticName;
  if (outletId && typeof outletId === 'string' && outletId !== data.outletId) {
    data.outletId = outletId;
    data.outlet = getOutletDisplayName(outletId) || outletId;
  }

  const crit = typeof data.criticName === 'string' ? data.criticName : 'unknown';
  const out = typeof data.outletId === 'string' ? data.outletId : 'unknown';
  const normalizedCritic = normalization.normalizeCritic(crit);
  const normalizedOutlet = normalization.normalizeOutlet(out);
  const newFile = `${normalizedOutlet}--${normalizedCritic}.json`;
  const newPath = path.join(reviewsDir, dir, newFile);

  if (oldFile === newFile) {
    if (!dryRun) {
      const r = safeWriteReview(filePath, data);
      if (r.lockedSkipped) lockedSkipCount++;
    }
    return { renamed: false, newFile };
  }

  if (fs.existsSync(newPath)) {
    return { renamed: false, duplicate: true, newFile };
  }

  if (!dryRun) {
    const renameResult = safeRenameReview(filePath, newPath, { newData: data });
    if (renameResult.skipped === 'locked') {
      lockedSkipCount++;
      return { renamed: false, lockedSkipped: true };
    }
    if (renameResult.skipped === 'conflict') {
      // TOCTOU: another writer created newPath between our existsSync check
      // above and the rename. Treat as duplicate.
      return { renamed: false, duplicate: true, newFile };
    }
    if (!renameResult.wrote) {
      return { renamed: false };
    }
  }

  return { renamed: true, newFile };
}


// --- Phase A: Outlet resolution (local, no HTTP) ---
function phaseA(unknownOutlets) {
  console.log('\n=== PHASE A: Outlet Resolution (local) ===');
  const toProcess = limit ? unknownOutlets.slice(0, limit) : unknownOutlets;
  console.log(`Found ${unknownOutlets.length} files with unknown outlet, processing ${toProcess.length}`);

  let resolved = 0;
  let duplicatesRemoved = 0;
  let renamed = 0;
  let noMatch = 0;
  const unresolvedDomains = new Map(); // domain → count

  for (let i = 0; i < toProcess.length; i++) {
    const u = toProcess[i];
    const urlResult = resolveOutletFromUrl(u.url);
    const newOutletId = urlResult ? urlResult.outletId : null;

    if (!newOutletId) {
      noMatch++;
      try {
        const hostname = new URL(u.url).hostname.replace(/^www\./, '');
        unresolvedDomains.set(hostname, (unresolvedDomains.get(hostname) || 0) + 1);
      } catch {}
      continue;
    }

    const fileResult = updateReviewFile(u.filePath, u.dir, u.file, newOutletId, null, u.data);
    resolved++;

    if (fileResult.duplicate) {
      duplicatesRemoved++;
      if (!dryRun) {
        // Honor _locked on the duplicate-delete path (ship-check P0 2026-04-29).
        // The rename path went through safeRenameReview; this delete path was a
        // raw fs.unlinkSync that bypassed _locked. Migrate it too.
        const u1 = safeUnlinkReview(u.filePath);
        if (u1.lockedSkipped) {
          lockedSkipCount++;
          console.log(`  [${i+1}] LOCKED-SKIP: ${u.dir}/${u.file} would be a duplicate of ${fileResult.newFile} but is _locked — kept`);
          continue;
        }
      }
      if (duplicatesRemoved <= 10) {
        console.log(`  [${i+1}] DUPE: ${u.dir}/${u.file} → ${fileResult.newFile} already exists`);
      }
      continue;
    }

    if (fileResult.renamed) renamed++;

    if (i < 20 || i % 100 === 0) {
      console.log(`  [${i+1}] ${fileResult.renamed ? 'RENAME' : 'UPDATE'}: ${u.dir}/${u.file} → ${newOutletId}`);
    }
  }

  console.log(`\nPhase A Results${dryRun ? ' (DRY RUN)' : ''}:`);
  console.log(`  Resolved: ${resolved}`);
  console.log(`  Renamed: ${renamed}`);
  console.log(`  Duplicates removed: ${duplicatesRemoved}`);
  console.log(`  No match: ${noMatch}`);

  if (unresolvedDomains.size > 0) {
    const sorted = Array.from(unresolvedDomains.entries()).sort((a, b) => b[1] - a[1]);
    console.log(`\n  Unresolved domains (add to outlet-registry.json):`);
    for (const [domain, count] of sorted.slice(0, 20)) {
      console.log(`    ${domain}: ${count} files`);
    }
  }

  return { resolved, renamed, duplicatesRemoved, noMatch, unresolvedDomains };
}

// --- Phase B: Critic enrichment (HTTP fetch) ---
//
// BRO-4485. Phase B used to take unknownCritics.slice(0, limit) in directory
// order with no memory of attempts, so each 4x-daily run re-fetched the same
// head of the list and ~1,155 Unknown reviews were never reached (the NYT
// Degenerates review sat Unknown with "By Helen Shaw" on the page). It also
// deleted the --unknown file whenever a named file existed, which can drop a
// scored review when the named sibling is flagged (the #27 pattern).
//
// Now: flagged/locked/manual files are skipped, open shows come first, every
// attempt is stamped (criticBackfillAttempt) and a file is not retried for
// CRITIC_RETRY_DAYS, and every write goes through review-file-writer's
// applyPageByline (plausible name, not an outlet name, not a credited
// creative, not an aggregator URL, no sibling with this URL/critic, rename at
// once). Nothing is ever deleted here.
const CRITIC_RETRY_DAYS = 14;
// A fetch error says nothing about the page (scraper outage, credits out),
// so it cools down for a day, not two weeks, and a run stops after this many
// in a row instead of stamping its whole batch.
const FETCH_ERROR_RETRY_DAYS = 1;
const MAX_CONSECUTIVE_FETCH_ERRORS = 10;

/**
 * Pure: which Unknown-critic entries to try this run, in order.
 * Verbatim-name junk bylines first (no fetch), then open/previews shows,
 * then never-attempted, then oldest attempt.
 */
function orderCriticCandidates(entries, { openShowIds = new Set(), now = Date.now(), retryDays = CRITIC_RETRY_DAYS } = {}) {
  const eligible = entries.filter(u => {
    const d = u.data || {};
    if (d.wrongProduction || d.duplicateOf || d._locked === true || d.criticNameManual) return false;
    const attempt = d.criticBackfillAttempt;
    const at = attempt && Date.parse(attempt.at);
    if (!at) return true;
    const days = attempt.result === 'fetch-error' ? FETCH_ERROR_RETRY_DAYS : retryDays;
    return at <= now - days * 24 * 3600 * 1000;
  });
  const lastAt = u => (u.data.criticBackfillAttempt && Date.parse(u.data.criticBackfillAttempt.at)) || 0;
  // BRO-4502: junk bylines that carry the real name verbatim cost no fetch,
  // so they go first; behind ~1,150 Unknowns at 150/run they waited days.
  const verbatim = u => (nameFromJunkCriticName(u.data.criticName) ? 0 : 1);
  return eligible.sort((a, b) => {
    if (verbatim(a) !== verbatim(b)) return verbatim(a) - verbatim(b);
    const ao = openShowIds.has(a.dir) ? 0 : 1;
    const bo = openShowIds.has(b.dir) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return lastAt(a) - lastAt(b);
  });
}

function loadOpenShowIds() {
  try {
    const raw = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    const shows = Array.isArray(raw) ? raw : (raw.shows || []);
    return new Set(shows.filter(x => x.status === 'open' || x.status === 'previews').map(x => x.id));
  } catch { return new Set(); }
}

function stampAttempt(u, result) {
  if (dryRun) return;
  u.data.criticBackfillAttempt = { at: new Date().toISOString(), result };
  const r = safeWriteReview(u.filePath, u.data);
  if (r && r.lockedSkipped) lockedSkipCount++;
}

async function phaseB(unknownCritics) {
  console.log('\n=== PHASE B: Critic Enrichment ===');
  const { applyPageByline } = require('./lib/review-file-writer');
  const { extractArticleTextFromUrl } = require('./lib/article-extractor');
  const ordered = orderCriticCandidates(unknownCritics, { openShowIds: loadOpenShowIds() });
  const toProcess = limit ? ordered.slice(0, limit) : ordered;
  console.log(`Found ${unknownCritics.length} files with unknown or junk critic, ${ordered.length} due (not flagged, not tried in ${CRITIC_RETRY_DAYS}d), processing ${toProcess.length}`);

  const counts = { applied: 0, refused: 0, noAuthor: 0, fetchError: 0, skippedHttp: 0 };
  const refusals = {};
  let consecutiveFetchErrors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    if (timeBudget.exceeded()) {
      console.log(`\n  ⏱ Time budget (${timeBudget.minutes} min) reached — ${toProcess.length - i} file(s) deferred to next run.`);
      break;
    }
    const u = toProcess[i];
    const tryName = (critic, method, pageText = null) => {
      try {
        return applyPageByline(u.filePath, u.data, { showId: u.dir, criticName: critic, source: method, pageText, dryRun });
      } catch (e) {
        return { applied: false, reason: `error:${e.message.slice(0, 60)}` };
      }
    };
    const report = (res, critic, method) => {
      if (res.applied) {
        counts.applied++;
        if (counts.applied <= 40 || i % 100 === 0) {
          console.log(`  [${i + 1}] ${dryRun ? 'WOULD NAME' : 'NAMED'} (${method}): ${u.dir}/${u.file} → ${critic}${res.newPath ? ` (${path.basename(res.newPath)})` : ''}`);
        }
        return;
      }
      counts.refused++;
      refusals[res.reason] = (refusals[res.reason] || 0) + 1;
      stampAttempt(u, `refused:${res.reason}`);
      if (counts.refused <= 20) console.log(`  [${i + 1}] REFUSED ${res.reason}: ${u.dir}/${u.file} ← "${critic}"`);
    };

    // Strategy 0 (BRO-4502): the junk byline carries the real name verbatim
    // ("Read more articles by Carol Rocamora"). No fetch: the page would only
    // repeat it, and a refusal here (e.g. a named sibling already exists)
    // would not change on a refetch.
    const fromJunk = nameFromJunkCriticName(u.data.criticName);
    if (fromJunk) { report(tryName(fromJunk, 'junk-byline'), fromJunk, 'junk-byline'); continue; }

    // Strategy 1: a byline the collector already read off this page.
    // Strategy 1b: re-run extraction against the stored fullText (BRO-171:
    // talkinbroadway prints "Theatre Review by <Name> - <date>" in the body).
    // A stored name the guards refuse falls through to a fresh page fetch.
    let stored = null;
    if (u.data.extractedByline && u.data.extractedByline !== 'Unknown' && !isRejectName(u.data.extractedByline)) {
      stored = { critic: u.data.extractedByline, method: 'extractedByline' };
    } else if (u.data.fullText) {
      const fromText = extractAuthorFromHtml(u.data.fullText, u.data.fullText, { url: u.url });
      if (fromText && !isRejectName(fromText)) stored = { critic: fromText, method: 'stored-text' };
    }
    if (stored) {
      const res = tryName(stored.critic, stored.method);
      if (res.applied || skipHttp) { report(res, stored.critic, stored.method); continue; }
    }

    // Strategy 2: fetch the page (Bright Data → ScrapingBee → Playwright).
    if (skipHttp) { counts.skippedHttp++; continue; }
    const result = await fetchHtml(u.url);
    await new Promise(r => setTimeout(r, 1000));
    if (!result.html) {
      counts.fetchError++;
      consecutiveFetchErrors++;
      stampAttempt(u, 'fetch-error');
      if (consecutiveFetchErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
        console.log(`\n  ⛔ ${consecutiveFetchErrors} fetch errors in a row — scraper likely down; stopping Phase B (${toProcess.length - i - 1} file(s) left for the next run).`);
        break;
      }
      continue;
    }
    consecutiveFetchErrors = 0;
    let text = null;
    try { text = extractArticleTextFromUrl(result.html, u.url) || null; } catch { text = null; }
    let critic = extractAuthorFromHtml(result.html, text || '', { url: u.url });
    if (critic && isRejectName(critic)) critic = null;

    if (!critic) {
      counts.noAuthor++;
      stampAttempt(u, 'no-author');
      if (i < 5 || i % 200 === 0) console.log(`  [${i + 1}/${toProcess.length}] no author: ${u.outletId} ${u.url.slice(0, 60)}`);
      continue;
    }
    report(tryName(critic, 'http-fetch', text), critic, 'http-fetch');
  }

  console.log(`\nPhase B Results${dryRun ? ' (DRY RUN)' : ''}:`);
  console.log(`  Named: ${counts.applied}`);
  console.log(`  Refused by guards: ${counts.refused} ${JSON.stringify(refusals)}`);
  console.log(`  No author on page: ${counts.noAuthor}`);
  console.log(`  Fetch errors: ${counts.fetchError}`);
  if (counts.skippedHttp) console.log(`  Skipped (--skip-http): ${counts.skippedHttp}`);
  return counts;
}

// --- Main ---
async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('Scanning review files...');
  const { unknownOutlets, unknownCritics } = scanReviewFiles();
  console.log(`Unknown outlets: ${unknownOutlets.length} files`);
  console.log(`Unknown critics: ${unknownCritics.length} files`);

  if (dryRun) console.log('DRY RUN — no files will be modified');
  if (sourceFilter) console.log(`Source filter: ${sourceFilter}`);
  if (showFilter) console.log(`Show filter: ${showFilter}`);

  if (!criticsOnly) {
    phaseA(unknownOutlets);
  }

  if (!outletsOnly) {
    await phaseB(unknownCritics);
  }

  await cleanupScraper();
  console.log('\nDone.');
}

module.exports = { updateReviewFile, orderCriticCandidates, CRITIC_RETRY_DAYS, FETCH_ERROR_RETRY_DAYS };

if (require.main === module) {
  main()
    .then(() => console.log(`[LOCKED-SKIP-COUNT] backfill-unknown-critics: ${lockedSkipCount}`))
    .catch(console.error);
}
