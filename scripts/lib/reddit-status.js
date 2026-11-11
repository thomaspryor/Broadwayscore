'use strict';
/**
 * reddit-status.js — the single off-switch for Reddit (BRO-7337, owner decision 2026-11-11).
 *
 * Reddit is retired while config/retired-sources.json has a `reddit` entry. Delete the entry to
 * turn it back on. REDDIT_FORCE_ENABLED=1 overrides for tests and one-off manual runs.
 * Enforced inside scripts/lib/reddit-api.js (before any network call), so no caller can spend.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'config', 'retired-sources.json');

class RedditRetiredError extends Error {
  constructor(message = 'Reddit is retired (config/retired-sources.json); no fetch attempted') {
    super(message);
    this.name = 'RedditRetiredError';
    this.code = 'REDDIT_RETIRED';
    this.retryable = false;
  }
}

function isRedditRetired({ file = DEFAULT_FILE, env = process.env } = {}) {
  if (env.REDDIT_FORCE_ENABLED === '1') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(cfg && cfg.reddit);
  } catch {
    return false; // missing or unreadable file: not retired (fail open to the old behaviour)
  }
}

function isRedditRetiredError(e) {
  return Boolean(e && e.code === 'REDDIT_RETIRED');
}

module.exports = { isRedditRetired, RedditRetiredError, isRedditRetiredError, DEFAULT_FILE };

if (require.main === module) {
  process.stdout.write(isRedditRetired() ? 'true\n' : 'false\n');
}
