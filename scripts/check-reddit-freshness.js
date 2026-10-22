#!/usr/bin/env node
/**
 * check-reddit-freshness.js — one alert (not one per failed run) when Reddit
 * audience data has gone stale while the scraper keeps trying (BRO-5916).
 *
 * Stale = no show's audience-buzz sources.reddit.lastUpdated within 48h AND
 * the spend ledger shows Reddit calls inside that window. routeAlert notifies
 * once per open incident and resolveCondition() closes it on the first fresh
 * write. Advisory: always exits 0.
 *
 *   node scripts/check-reddit-freshness.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { redditStaleVerdict, readLedgerTail, REDDIT_STALE_HOURS } = require('./lib/reddit-dispatch-cooldown');

const CONDITION_KEY = 'reddit-sentiment:stale';

function newestRedditWriteMs(buzz) {
  let newest = null;
  for (const rec of Object.values((buzz && buzz.shows) || {})) {
    const t = Date.parse(rec && rec.sources && rec.sources.reddit && rec.sources.reddit.lastUpdated);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

function countRedditAttempts(rows, nowMs) {
  const since = nowMs - REDDIT_STALE_HOURS * 3600e3;
  return rows.filter((r) => r && r.host === 'reddit.com' && Date.parse(r.ts) >= since).length;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const nowMs = Date.now();
  const buzz = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'audience-buzz.json'), 'utf8'));
  const lastWriteMs = newestRedditWriteMs(buzz);
  const attemptsInWindow = countRedditAttempts(readLedgerTail(), nowMs);
  const v = redditStaleVerdict({ lastWriteMs, attemptsInWindow, nowMs });
  const last = lastWriteMs ? new Date(lastWriteMs).toISOString() : 'never';
  console.log(`[reddit-freshness] last Reddit write ${last}, ${attemptsInWindow} Reddit calls in ${REDDIT_STALE_HOURS}h, stale=${v.stale}`);
  if (dryRun) return;

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  // Idle (scraper made no Reddit calls) is neither stale nor fresh: leave any open
  // incident alone so a quiet window cannot close it and re-notify on the next probe.
  if (v.idle) return;
  if (!v.stale) {
    resolveCondition(CONDITION_KEY, { reason: 'reddit-freshness: fresh Reddit data written' });
    return;
  }
  await routeAlert({
    conditionKey: CONDITION_KEY,
    title: `Reddit audience data has had no successful write for ${Math.floor(v.ageHours)}h`,
    description:
      `No show's sources.reddit was written since ${last}, while the scraper kept trying (${attemptsInWindow} Reddit calls in ${REDDIT_STALE_HOURS}h). ` +
      'Find a working route (Reddit direct 403, ScrapingBee timeouts, Scrapingdog breaker) and backfill shows opened since the last good write. ' +
      'The ScrapingBee leg now cools down across runs (scripts/lib/reddit-dispatch-cooldown.js).',
    severity: 'warning',
    disposition: 'auto',
    category: 'reddit-sentiment',
    verify: 'node scripts/check-reddit-freshness.js --dry-run',
  });
}

if (require.main === module) {
  main().catch((e) => { console.error('[reddit-freshness] failed:', e.message); }).finally(() => process.exit(0));
}

module.exports = { newestRedditWriteMs, countRedditAttempts, CONDITION_KEY };
