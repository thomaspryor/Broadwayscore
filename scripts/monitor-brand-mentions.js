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
const { fetchPaidSources } = require('./lib/brand-mention-serp');
const { filterOwnerAccounts } = require('./lib/owner-accounts');
const { draftMentions } = require('./lib/brand-mention-drafter');

// Discord notifier is lazy-loaded because it pulls in https/http
// and we want the module to work in environments without it.
let _sendAlert = null;
function getSendAlert() {
  if (_sendAlert === null) {
    try {
      _sendAlert = require('./lib/discord-notify').sendAlert;
    } catch (e) {
      _sendAlert = false;
      console.warn(`[monitor] discord-notify unavailable: ${e.message}`);
    }
  }
  return _sendAlert || null;
}

// ── Config ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const FREE_ONLY = process.argv.includes('--free-only');
const NO_DRAFT = process.argv.includes('--no-draft');
const NO_DISPATCH = process.argv.includes('--no-dispatch');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'brand-mentions.json');
const MAX_MENTIONS = 500;

// ── Discord dispatch ──────────────────────────────────────────────────────

const SENTIMENT_EMOJI = {
  positive: '👍',
  neutral: '🔍',
  negative: '⚠️',
  hostile: '🚨',
};

const SENTIMENT_SEVERITY = {
  positive: 'info',
  neutral: 'info',
  negative: 'warning',
  hostile: 'error',
};

async function dispatchToDiscord(mention, verdict) {
  const sendAlert = getSendAlert();
  if (!sendAlert) return { dispatched: false, reason: 'discord-notify unavailable' };
  if (!process.env.DISCORD_WEBHOOK_ALERTS) {
    return { dispatched: false, reason: 'DISCORD_WEBHOOK_ALERTS not set' };
  }

  const sentiment = (verdict && verdict.sentiment) || 'neutral';
  const severity = SENTIMENT_SEVERITY[sentiment] || 'info';
  const emoji = SENTIMENT_EMOJI[sentiment] || '🔍';

  const title = `${emoji} ${mention.source.toUpperCase()} — ${mention.author || 'unknown'}`;
  const description = (mention.title || '').slice(0, 200) || '(no title)';

  const fields = [
    { name: 'Sentiment', value: sentiment, inline: true },
    { name: 'Respond?', value: verdict && verdict.shouldRespond ? '✏️ yes' : '· no', inline: true },
    { name: 'Confidence', value: (verdict && verdict.confidence) || '—', inline: true },
  ];

  if (verdict && verdict.reason) {
    fields.push({ name: 'Reason', value: verdict.reason.slice(0, 500), inline: false });
  }
  if (verdict && verdict.draftResponse) {
    fields.push({ name: 'Draft', value: verdict.draftResponse.slice(0, 1000), inline: false });
  }
  if (mention.excerpt) {
    fields.push({ name: 'Excerpt', value: mention.excerpt.slice(0, 500), inline: false });
  }

  try {
    await sendAlert({
      title,
      description,
      severity,
      fields,
      url: mention.url,
      email: false,
    });
    return { dispatched: true };
  } catch (e) {
    console.warn(`[monitor] Discord dispatch failed: ${e.message}`);
    return { dispatched: false, reason: e.message };
  }
}

// ── State helpers ─────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[state] could not read ${STATE_PATH}: ${e.message}`);
    }
    return {
      lastRunAt: null,
      seenIds: {},
      mentions: [],
      stats: { totalSeen: 0, totalDispatched: 0, lastCalibration: null },
    };
  }
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

  // 3. Dedup against state
  const newMentions = [];
  for (const m of organic) {
    if (state.seenIds[m.id]) {
      if (VERBOSE) console.log(`  [seen] ${m.id}`);
      continue;
    }
    newMentions.push(m);
  }
  console.log(`[monitor] dedup: ${newMentions.length} NEW mentions (${organic.length - newMentions.length} already seen)`);

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

  // 6. Dispatch to Discord (unless --no-dispatch or no webhook)
  let dispatchedCount = 0;
  if (NO_DISPATCH) {
    console.log('[monitor] --no-dispatch set, skipping Discord');
  } else if (!process.env.DISCORD_WEBHOOK_ALERTS) {
    console.log('[monitor] DISCORD_WEBHOOK_ALERTS not set, skipping Discord dispatch');
  } else {
    console.log('[monitor] dispatching new mentions to Discord...');
    for (const { mention: m, verdict } of draftedPairs) {
      const result = await dispatchToDiscord(m, verdict);
      if (result.dispatched) dispatchedCount++;
      else if (VERBOSE) console.log(`  [discord] skipped ${m.id}: ${result.reason}`);
    }
    console.log(`[monitor] dispatched ${dispatchedCount}/${draftedPairs.length} to Discord`);
  }

  // 7. Persist
  for (const { mention: m, verdict } of draftedPairs) {
    state.seenIds[m.id] = true;
    state.mentions.push({
      ...m,
      status: 'new',
      sentiment: verdict ? verdict.sentiment : 'neutral',
      shouldRespond: verdict ? verdict.shouldRespond : false,
      confidence: verdict ? verdict.confidence : null,
      draftReason: verdict ? verdict.reason : null,
      draftResponse: verdict ? verdict.draftResponse : null,
      dispatched: dispatchedCount > 0 ? new Date().toISOString() : null,
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
