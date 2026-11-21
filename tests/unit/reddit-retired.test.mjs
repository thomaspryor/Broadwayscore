// BRO-7337: Reddit retired. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { isRedditRetired, RedditRetiredError } = require('../../scripts/lib/reddit-status.js');

function tmpCfg(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-')), 'retired.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('isRedditRetired reads the single switch file', () => {
  assert.equal(isRedditRetired({ file: tmpCfg({ reddit: { retiredAt: '2026-11-11' } }), env: {} }), true);
  assert.equal(isRedditRetired({ file: tmpCfg({}), env: {} }), false);
  assert.equal(isRedditRetired({ file: '/nonexistent/x.json', env: {} }), true);
});

test('REDDIT_FORCE_ENABLED=1 overrides the switch', () => {
  assert.equal(isRedditRetired({ file: tmpCfg({ reddit: {} }), env: { REDDIT_FORCE_ENABLED: '1' } }), false);
});

test('the shipped config has Reddit retired', () => {
  assert.equal(isRedditRetired({ env: {} }), true);
});

test('fetchWithFallback refuses before any network call while retired', async () => {
  const saved = process.env.REDDIT_FORCE_ENABLED;
  delete process.env.REDDIT_FORCE_ENABLED;
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be touched'); };
  try {
    const api = require('../../scripts/lib/reddit-api.js');
    await assert.rejects(() => api.fetchWithFallback('https://www.reddit.com/r/broadway/search.json?q=x'), (e) => {
      assert.ok(e instanceof RedditRetiredError);
      assert.equal(e.code, 'REDDIT_RETIRED');
      assert.equal(e.retryable, false);
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = origFetch;
    if (saved !== undefined) process.env.REDDIT_FORCE_ENABLED = saved;
  }
});

test('class guard: every watcher listed in retired-sources.json exists and the dispatch-only workflows stay gated', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'retired-sources.json'), 'utf8'));
  for (const w of cfg.reddit.watchers) {
    const f = typeof w === 'string' ? w : w.file;
    assert.ok(fs.existsSync(path.join(root, f)) || fs.existsSync(path.join(root, '.github', 'workflows', path.basename(f))), `listed watcher missing: ${f}`);
  }
  const sentiment = fs.readFileSync(path.join(root, '.github', 'workflows', 'update-reddit-sentiment.yml'), 'utf8');
  assert.ok(!/^\s*schedule:/m.test(sentiment), 'update-reddit-sentiment.yml must have no schedule while retired');
  assert.match(sentiment, /needs\.gate\.outputs\.retired != 'true'/);
  const digest = fs.readFileSync(path.join(root, '.github', 'workflows', 'reddit-engagement-digest.yml'), 'utf8');
  assert.ok(!digest.includes("cron: '45 1 * * *'"), 'daily digest cron must stay removed while retired');
});

test('class guard: each script importing reddit-api handles REDDIT_RETIRED or only calls it through a handled path', () => {
  const dir = path.join(root, 'scripts');
  const users = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .filter((f) => /require\(['"]\.\/lib\/reddit-api['"]\)|from ['"]\.\/lib\/reddit-api(\.js)?['"]/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(users.length > 0);
  // Known callers reviewed in BRO-7337. A new caller must be added here after deciding how it handles the refusal.
  const reviewed = new Set(['scrape-reddit-sentiment.js', 'scrape-cast-changes.js', 'scrape-boring-waltz-costs.js', 'fetch-social-pulse.js',
    'record-review-forecast-pilot.mjs', 'check-reddit-freshness.js', 'reddit-engagement-digest.js', 'test-reddit-buzz.js']);
  const unreviewed = users.filter((f) => !reviewed.has(f));
  assert.deepEqual(unreviewed, [], `new reddit-api caller(s) need a REDDIT_RETIRED decision: ${unreviewed.join(', ')}`);
});
