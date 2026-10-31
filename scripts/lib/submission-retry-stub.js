'use strict';

/**
 * submission-retry-stub.js — a reader-submitted review whose page could not
 * be read is saved as a stub that the pipeline keeps retrying, instead of
 * being dropped (BRO-4431).
 *
 * Before: ingest-review-from-url.js exited 1 on any fetch/extraction failure,
 * process-review-submission.yml labelled the issue `scraping-failed`, and
 * nothing looked at it again (Golden Boy: Sunday Times #907, Daily Mail #908;
 * Thelma & Louise: The Stage #919). A stub with the URL is what every
 * recovery path works from: the collector's retry cadence, the T1/T2
 * silent-gap audit, the paywall rating salvage and the aggregator star relay.
 */

const RETRY_FLAG = 'submissionRetryQueued';

function buildRetryStubFields(reason, { publishDate = null, now = new Date().toISOString() } = {}) {
  const fields = {
    contentTier: 'stub',
    contentTierReason: 'Reader submission: page could not be read yet, queued for automatic retry',
    [RETRY_FLAG]: true,
    submissionRetryReason: String(reason || 'unknown').slice(0, 300),
    submissionRetryQueuedAt: now,
  };
  if (publishDate) fields.publishDate = publishDate;
  return fields;
}

/** A queued-retry stub that no recovery path has filled yet. */
function isQueuedRetryStub(data) {
  if (!data || data[RETRY_FLAG] !== true) return false;
  const hasText = typeof data.fullText === 'string' && data.fullText.trim().length >= 200;
  return !hasText;
}

module.exports = { buildRetryStubFields, isQueuedRetryStub, RETRY_FLAG };
