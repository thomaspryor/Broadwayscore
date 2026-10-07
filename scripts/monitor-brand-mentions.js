#!/usr/bin/env node
/**
 * monitor-brand-mentions.js
 *
 * Fetches new mentions of "broadwayscorecard" from all configured sources
 * (Reddit, HN, Bluesky, X via SERP, Google web SERP, Google News SERP),
 * filters owner self-posts, dedups against state, drafts responses via
 * Claude Sonnet, and persists.
 *
 * A separate /schedule remote Claude agent reads the state file and
 * dispatches to Buffer / Notion / Discord via MCP. This script itself
 * runs pure Node + HTTP, so it can be called from any context (CI,
 * remote agent, local CLI).
 *
 * Usage:
 *   node scripts/monitor-brand-mentions.js --dry-run            # fetch, print, no writes
 *   node scripts/monitor-brand-mentions.js --dry-run --verbose  # extra logging
 *   node scripts/monitor-brand-mentions.js                      # fetch + draft + write state
 *   node scripts/monitor-brand-mentions.js --free-only          # skip paid SERP sources
 *   node scripts/monitor-brand-mentions.js --no-draft           # skip drafter (fetch/dedup only)
 *
 * Exit codes:
 *   0 - success (0+ new mentions)
 *   1 - fatal error
 *
 * IMPORTANT: per MEMORY.md `feedback_process_exit_scrapers`, scripts using
 * fetchPage-family helpers must call process.exit(0) or Playwright leaves
 * a hanging browser and node never exits.
 */

const fs = require('fs');
const path = require('path');

const { fetchFreeSources, DEFAULT_KEYWORDS } = require('./lib/brand-mention-sources');
const { fetchPaidSources, _internal: serpInternal } = require('./lib/brand-mention-serp');
const { filterOwnerAccounts } = require('./lib/owner-accounts');
const { draftMentions } = require('./lib/brand-mention-drafter');
const { sendBrandMentionDigest } = require('./lib/brand-mention-email');

const { canonicalizeUrl, normalizeExcerpt } = serpInternal;

// SERP sources recycle snippets across URLs (see normalizeExcerpt); free
// sources carry genuine per-post text, so excerpt dedup applies to SERP only.
const SERP_SOURCES = new Set(['google', 'news']);

// ── Config ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const FREE_ONLY = process.argv.includes('--free-only');
const NO_DRAFT = process.argv.includes('--no-draft');
const NO_DISPATCH = process.argv.includes('--no-dispatch');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'brand-mentions.json');
const MAX_MENTIONS = 500;

// ── State helpers ─────────────────────────────────────────────────────────

function loadState() {
  let state;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    state = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[state] could not read ${STATE_PATH}: ${e.message}`);
    }
    state = {
      lastRunAt: null,
      seenIds: {},
      seenUrls: {},
      mentions: [],
      seenExcerpts: {},
      stats: { totalSeen: 0, totalDispatched: 0, lastCalibration: null },
    };
  }
  // Migration: older state files may lack seenExcerpts — backfill from existing
  // SERP mentions so the recycled-snippet dedup works on the first run after
  // upgrade (otherwise a blurb already alerted on would re-alert once more).
  if (!state.seenExcerpts) {
    state.seenExcerpts = {};
    for (const m of state.mentions) {
      if (m && SERP_SOURCES.has(m.source)) {
        const norm = normalizeExcerpt(m.excerpt);
        if (norm) state.seenExcerpts[norm] = true;
      }
    }
    console.log(`[state] migration: built seenExcerpts with ${Object.keys(state.seenExcerpts).length} SERP snippets`);
  }
  // Migration: older state files may lack seenUrls — backfill from existing
  // mentions so cross-source dedup works immediately on the first run after
  // upgrade. Also deduplicates mentions that share a canonical URL but were
  // stored under different source prefixes (google: vs news: vs forum:).
  if (!state.seenUrls) state.seenUrls = {};
  const urlKeyCount = Object.keys(state.seenUrls).length;
  if (urlKeyCount === 0 && state.mentions.length > 0) {
    const dedupedMentions = [];
    for (const m of state.mentions) {
      if (!m || !m.url) {
        dedupedMentions.push(m);
        continue;
      }
      const canonical = canonicalizeUrl(m.url);
      if (state.seenUrls[canonical]) {
        // Duplicate across sources — drop
        console.log(`[state] migration: dropping cross-source duplicate ${m.id} (${canonical})`);
        continue;
      }
      state.seenUrls[canonical] = true;
      dedupedMentions.push(m);
    }
    state.mentions = dedupedMentions;
    console.log(`[state] migration: built seenUrls with ${Object.keys(state.seenUrls).length} canonical URLs`);
  }
  // Normalization rules evolve (Threads slug stripping, absolute-date prefixes).
  // Re-key stored dedup sets through the CURRENT canonicalize/normalize so old
  // entries keep matching new fetches; idempotent, runs every load.
  const rekeyedUrls = {};
  for (const k of Object.keys(state.seenUrls)) rekeyedUrls[canonicalizeUrl(k)] = true;
  state.seenUrls = rekeyedUrls;
  const rekeyedExcerpts = {};
  for (const k of Object.keys(state.seenExcerpts)) {
    const norm = normalizeExcerpt(k);
    if (norm) rekeyedExcerpts[norm] = true;
  }
  state.seenExcerpts = rekeyedExcerpts;
  // Also seed excerpt keys from stored SERP mentions: entries that predate a
  // fingerprint/normalization fix may exist in mentions[] without a current-form
  // excerpt key.
  for (const m of state.mentions) {
    if (m && SERP_SOURCES.has(m.source)) {
      const norm = normalizeExcerpt(m.excerpt);
      if (norm) state.seenExcerpts[norm] = true;
    }
  }
  // Retroactive owner filter: owner-account/fingerprint rules also evolve. Drop
  // stored mentions that today's rules classify as owner content (their seenIds/
  // seenUrls/seenExcerpts keys stay, so nothing re-alerts as "new").
  const { kept: organicStored, dropped: ownerStored } = filterOwnerAccounts(state.mentions);
  if (ownerStored.length > 0) {
    state.mentions = organicStored;
    console.log(`[state] migration: dropped ${ownerStored.length} stored owner-content mentions`);
  }
  return state;
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[monitor] brand-mention-monitor starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`[monitor] keywords: ${DEFAULT_KEYWORDS.join(', ')}`);

  const state = loadState();
  const beforeCount = state.mentions.length;
  console.log(`[monitor] loaded state: ${beforeCount} mentions, ${Object.keys(state.seenIds).length} seen IDs, lastRun=${state.lastRunAt || 'never'}`);

  // 1. Fetch from all sources (free + paid in parallel)
  const fetchStart = Date.now();
  const [freeRes, paidRes] = await Promise.all([
    fetchFreeSources(DEFAULT_KEYWORDS),
    FREE_ONLY
      ? Promise.resolve({ mentions: [], counts: { x: 0, google: 0, news: 0 } })
      : fetchPaidSources(DEFAULT_KEYWORDS, { verbose: VERBOSE }),
  ]);
  const fetched = [...freeRes.mentions, ...paidRes.mentions];
  const counts = { ...freeRes.counts, ...paidRes.counts };
  const fetchMs = Date.now() - fetchStart;
  console.log(`[monitor] fetched ${fetched.length} candidates in ${fetchMs}ms`);
  console.log(`[monitor]   by source: ${JSON.stringify(counts)}`);

  if (VERBOSE) {
    fetched.forEach((m) =>
      console.log(`  [${m.source}] ${m.id} /u/${m.author || '?'} — ${(m.title || '').slice(0, 80)}`)
    );
  }

  // 2. Filter owner accounts (self-posts should never enter state)
  const { kept: organic, dropped } = filterOwnerAccounts(fetched);
  console.log(`[monitor] filter: ${dropped.length} owner self-posts dropped, ${organic.length} organic candidates`);

  if (dropped.length > 0 && VERBOSE) {
    dropped.forEach((m) => console.log(`  [owner-filtered] ${m.source} /u/${m.author} — ${(m.title || '').slice(0, 60)}`));
  }

  // 3. Dedup against state — THREE checks:
  //    (a) source:id — catches same-source duplicates (Reddit post seen before)
  //    (b) canonical URL — catches CROSS-source duplicates (same URL surfacing
  //        under both google: and news: prefixes on different SERP calls)
  //    (c) normalized title — catches same content from different aggregator URLs
  //        (e.g. Broadway Breakdown podcast on Apple Podcasts vs podscan.fm vs
  //        Google redirect). Only applies within the current run to avoid
  //        blocking legitimately different content with similar titles across days.
  //
  // Within the current run, also dedup by canonical URL so two SERP adapters
  // (e.g. fetchGoogleWebMentions + fetchGoogleNewsMentions) that both surface
  // the same URL don't produce two entries.
  const newMentions = [];
  const seenThisRun = new Set();        // canonical URLs
  const seenTitlesThisRun = new Set();  // normalized titles (within-run dedup only)
  const seenExcerptsThisRun = new Set(); // normalized SERP snippets (this run)
  for (const m of organic) {
    if (state.seenIds[m.id]) {
      if (VERBOSE) console.log(`  [seen-id] ${m.id}`);
      continue;
    }
    const canonical = m.url ? canonicalizeUrl(m.url) : null;
    if (canonical && state.seenUrls[canonical]) {
      if (VERBOSE) console.log(`  [seen-url] ${m.id} (canonical: ${canonical})`);
      continue;
    }
    if (canonical && seenThisRun.has(canonical)) {
      if (VERBOSE) console.log(`  [dup-this-run] ${m.id} (canonical: ${canonical})`);
      continue;
    }
    // Title-based dedup: collapse "Broadway Breakdown - Podcast" appearing
    // 3x from different aggregator URLs into a single mention per run.
    // Only dedup Google/news sources (free sources have reliable URLs).
    const normTitle = (m.title || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[…\u2026]+$/, '').trim();
    if (normTitle && ['google', 'news'].includes(m.source) && seenTitlesThisRun.has(normTitle)) {
      if (VERBOSE) console.log(`  [dup-title] ${m.id} (title: "${normTitle}")`);
      continue;
    }
    // Excerpt-based dedup (SERP only): a recycled snippet that surfaces under a
    // new URL+title each day (e.g. a Threads account's sticky brand blurb)
    // should alert once, not every run. Spans runs via state.seenExcerpts.
    const normExcerpt = SERP_SOURCES.has(m.source) ? normalizeExcerpt(m.excerpt) : '';
    if (normExcerpt && (state.seenExcerpts[normExcerpt] || seenExcerptsThisRun.has(normExcerpt))) {
      if (VERBOSE) console.log(`  [dup-excerpt] ${m.id} (excerpt: "${normExcerpt.slice(0, 60)}")`);
      continue;
    }
    if (canonical) seenThisRun.add(canonical);
    if (normTitle) seenTitlesThisRun.add(normTitle);
    if (normExcerpt) seenExcerptsThisRun.add(normExcerpt);
    newMentions.push(m);
  }
  console.log(`[monitor] dedup: ${newMentions.length} NEW mentions (${organic.length - newMentions.length} already seen or cross-source duplicates)`);

  // 4. Draft responses for each new mention (skippable via --no-draft)
  let draftedPairs = [];
  if (newMentions.length === 0) {
    console.log('[monitor] ✓ no new third-party mentions this run');
  } else if (NO_DRAFT || !process.env.ANTHROPIC_API_KEY) {
    console.log(`[monitor] 🔔 ${newMentions.length} new mention(s) — drafter skipped (${NO_DRAFT ? '--no-draft' : 'no ANTHROPIC_API_KEY'}):`);
    for (const m of newMentions) {
      console.log(`  [${m.source}] ${m.author ? '/u/' + m.author + ' | ' : ''}${(m.title || '').slice(0, 100)}`);
      console.log(`         ${m.url}`);
    }
    draftedPairs = newMentions.map((m) => ({ mention: m, verdict: null }));
  } else {
    console.log(`[monitor] 🔔 ${newMentions.length} new mention(s) — drafting responses via Claude Sonnet...`);
    const draftStart = Date.now();
    draftedPairs = await draftMentions(newMentions, { verbose: VERBOSE });
    console.log(`[monitor] drafter done in ${Date.now() - draftStart}ms`);

    for (const { mention: m, verdict } of draftedPairs) {
      const icon = verdict.shouldRespond ? '✏️' : '·';
      console.log(`  ${icon} [${m.source}] ${m.author ? '/u/' + m.author + ' | ' : ''}${(m.title || '').slice(0, 80)}`);
      console.log(`         ${m.url}`);
      console.log(`         sentiment=${verdict.sentiment} respond=${verdict.shouldRespond} confidence=${verdict.confidence}`);
      if (verdict.reason) console.log(`         reason: ${verdict.reason}`);
      if (verdict.draftResponse) {
        const preview = verdict.draftResponse.length > 200
          ? verdict.draftResponse.slice(0, 200) + '...'
          : verdict.draftResponse;
        console.log(`         draft: ${preview}`);
      }
    }
  }

  // 5. Persist (unless dry-run)
  if (DRY_RUN) {
    console.log('[monitor] DRY RUN — not writing state');
    console.log(`[monitor] would add ${newMentions.length} mentions, update lastRunAt to ${new Date().toISOString()}`);
    return {
      newCount: newMentions.length,
      dropped: dropped.length,
      totalFetched: fetched.length,
      drafted: draftedPairs.filter((p) => p.verdict && p.verdict.shouldRespond).length,
    };
  }

  // 6. Send digest email (single email per run, only if there are new mentions)
  let emailResult = { sent: false, reason: 'not attempted' };
  if (NO_DISPATCH) {
    console.log('[monitor] --no-dispatch set, skipping email');
    emailResult = { sent: false, reason: '--no-dispatch' };
  } else if (draftedPairs.length === 0) {
    console.log('[monitor] no new mentions, skipping email');
    emailResult = { sent: false, reason: 'no new mentions' };
  } else {
    console.log(`[monitor] sending digest email (${draftedPairs.length} mentions)...`);
    emailResult = await sendBrandMentionDigest({
      pairs: draftedPairs,
      totalFetched: fetched.length,
      dropped: dropped.length,
      dryRun: DRY_RUN,
    });
    if (emailResult.sent) {
      console.log(`[monitor] ✉️  email sent: "${emailResult.subject}"`);
    } else {
      console.log(`[monitor] email not sent: ${emailResult.reason}`);
    }
  }

  // 7. Persist
  const dispatchTs = emailResult.sent ? new Date().toISOString() : null;
  for (const { mention: m, verdict } of draftedPairs) {
    state.seenIds[m.id] = true;
    if (m.url) {
      state.seenUrls[canonicalizeUrl(m.url)] = true;
    }
    if (SERP_SOURCES.has(m.source)) {
      const norm = normalizeExcerpt(m.excerpt);
      if (norm) state.seenExcerpts[norm] = true;
    }
    state.mentions.push({
      ...m,
      status: 'new',
      sentiment: verdict ? verdict.sentiment : 'neutral',
      shouldRespond: verdict ? verdict.shouldRespond : false,
      confidence: verdict ? verdict.confidence : null,
      draftReason: verdict ? verdict.reason : null,
      draftResponse: verdict ? verdict.draftResponse : null,
      dispatched: dispatchTs,
    });
  }

  // Cap rolling window
  if (state.mentions.length > MAX_MENTIONS) {
    const toRemove = state.mentions.length - MAX_MENTIONS;
    state.mentions.splice(0, toRemove);
    console.log(`[monitor] trimmed ${toRemove} oldest mentions (cap=${MAX_MENTIONS})`);
  }

  state.lastRunAt = new Date().toISOString();
  state.stats.totalSeen = Object.keys(state.seenIds).length;

  saveState(state);
  console.log(`[monitor] wrote state: ${state.mentions.length} mentions, ${state.stats.totalSeen} seen IDs`);

  return { newCount: newMentions.length, dropped: dropped.length, totalFetched: fetched.length };
}

main()
  .then((result) => {
    console.log(`[monitor] done: ${JSON.stringify(result)}`);
    // Explicit exit per MEMORY.md scraper-exit rule
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[monitor] FATAL: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
