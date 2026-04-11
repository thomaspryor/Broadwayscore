#!/usr/bin/env node
/**
 * monitor-brand-mentions.js
 *
 * Fetches new mentions of "broadwayscorecard" from free sources (Reddit,
 * HN, Bluesky), filters owner self-posts, dedups against state, and
 * persists. In dry-run mode, prints what would happen without writing.
 *
 * This is the "fetch + filter + dedup" half of the brand mention monitor.
 * A separate /schedule remote Claude agent (see memory/plan-brand-mention-monitor.md)
 * will read the state file and handle drafting + Buffer/Notion/Discord
 * dispatch using MCP tools.
 *
 * Usage:
 *   node scripts/monitor-brand-mentions.js --dry-run    # fetch, print, no writes
 *   node scripts/monitor-brand-mentions.js              # fetch + write state
 *   node scripts/monitor-brand-mentions.js --verbose    # extra logging
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
const { filterOwnerAccounts } = require('./lib/owner-accounts');

// ── Config ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'brand-mentions.json');
const MAX_MENTIONS = 500;

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

  // 1. Fetch from free sources
  const fetchStart = Date.now();
  const { mentions: fetched, counts } = await fetchFreeSources(DEFAULT_KEYWORDS);
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

  // 4. Report
  if (newMentions.length === 0) {
    console.log('[monitor] ✓ no new third-party mentions this run');
  } else {
    console.log(`[monitor] 🔔 ${newMentions.length} new mention(s):`);
    for (const m of newMentions) {
      console.log(`  [${m.source}] ${m.author ? '/u/' + m.author + ' | ' : ''}${(m.title || '').slice(0, 100)}`);
      console.log(`         ${m.url}`);
    }
  }

  // 5. Persist (unless dry-run)
  if (DRY_RUN) {
    console.log('[monitor] DRY RUN — not writing state');
    console.log(`[monitor] would add ${newMentions.length} mentions, update lastRunAt to ${new Date().toISOString()}`);
    return { newCount: newMentions.length, dropped: dropped.length, totalFetched: fetched.length };
  }

  for (const m of newMentions) {
    state.seenIds[m.id] = true;
    state.mentions.push({ ...m, status: 'new' });
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
