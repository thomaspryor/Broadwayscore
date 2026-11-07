'use strict';
// Pure decisions for the trade-press recoupment poller (BRO-6167).
// Kept out of poll-trade-press-rss.js so tests require() the real code.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

// Hourly cron, so 3 consecutive failures is ~3h of a dead feed. A single 429 or
// bot-block blip never reaches this.
const DEAD_FEED_ERROR_THRESHOLD = 3;

/**
 * Should a tracked feed's failure state raise the dead-source alert?
 * @param {{errorCount?: number}} feedState
 */
function shouldAlertDeadFeed(feedState) {
  return ((feedState && feedState.errorCount) || 0) >= DEAD_FEED_ERROR_THRESHOLD;
}

/** routeAlert opts for a dead tracked feed (disposition auto). */
function deadFeedAlertOpts(feed, feedState) {
  return {
    conditionKey: `commercial-feed-dead:${feed.outletId}`,
    title: `Commercial trade-press feed "${feed.name}" has failed ${feedState.errorCount} polls in a row`,
    description: `${feed.url} last error: ${feedState.lastError || 'unknown'}. The recoupment poller (scripts/poll-trade-press-rss.js) is blind to this outlet until the feed is fixed or its entry in scripts/lib/rss-discovery.js is updated.`,
    hint: 'Open the feed URL, find the new location (outlets move platforms), and update the entry in scripts/lib/rss-discovery.js.',
    disposition: 'auto',
    severity: 'warning',
  };
}

/**
 * What the poller does with a recoupment finding from `host` on `feed`.
 *  'auto'   - trusted host: write to pending (apply-commercial-pending may auto-apply)
 *  'review' - feed opted in to untrusted hosts: route to a human, never to pending
 *  'skip'   - untrusted host on a normal feed
 */
function hostGate(feed, host, trusted = TRUSTED_RECOUPMENT_HOSTS) {
  if (trusted.has(host)) return 'auto';
  return feed && feed.untrustedClaimsToReview === true ? 'review' : 'skip';
}

/** One aggregate routeAlert for the untrusted claims found in a poll run. */
function untrustedClaimAlertOpts(findings, nowIso = new Date().toISOString()) {
  const lines = findings.map(f => `- ${f.show.slug}: ${f.url} (${f.verdict.evidence ? String(f.verdict.evidence).slice(0, 160) : 'no quote'})`);
  const slugs = findings.map(f => f.show.slug).sort().join(',');
  return {
    conditionKey: `commercial-untrusted-recoup-claim:${slugs}`,
    title: `Review recoupment claim${findings.length > 1 ? 's' : ''} from a non-trusted outlet (${findings.map(f => f.show.slug).join(', ')})`,
    description: `The poller found high-confidence recoupment claims on hosts outside TRUSTED_RECOUPMENT_HOSTS. Nothing was written to commercial data.\n${lines.join('\n')}\nDetected ${nowIso}.`,
    hint: 'Verify each quote against the article. If it holds, add the citation to data/commercial.json by hand (recouped: true needs a citation).',
    disposition: 'auto',
    severity: 'warning',
  };
}

// routeAlert reports a failed card filing as dispatchOk:false / dispatchError
// (a cooldown-silenced result carries neither), so "landed" is the inverse.
function alertLanded(res) {
  return !!res && res.dispatchOk !== false && !res.dispatchError;
}

module.exports = {
  alertLanded,
  DEAD_FEED_ERROR_THRESHOLD,
  shouldAlertDeadFeed,
  deadFeedAlertOpts,
  hostGate,
  untrustedClaimAlertOpts,
};
