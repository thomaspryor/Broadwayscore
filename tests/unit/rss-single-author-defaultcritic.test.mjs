/**
 * Enforcement test for single-author RSS feeds:
 *   - every entry in SUBSTACK_CRITIC_FEEDS must have `defaultCritic`
 *   - every RSS feed with `defaultCritic` must have a matching
 *     outlet-registry.json entry that ALSO has `defaultCritic`
 *     (belt-and-suspenders: rebuild-all-reviews resolves Unknown → registry.defaultCritic)
 *   - Any OTHER feed in ALL_FEEDS that sets `defaultCritic` must also pass the registry check
 *
 * The whole point of this test is to prevent the RSS → _pending → lost-forever
 * class of bug documented in memory/feedback_rss_discovery_pending_strand.md.
 * Adding a new single-author Substack critic? The test makes the invariant
 * self-enforcing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { SUBSTACK_CRITIC_FEEDS, ALL_FEEDS } = require('../../scripts/lib/rss-discovery.js');

const registryPath = resolve(__dirname, '../../data/outlet-registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

describe('SUBSTACK_CRITIC_FEEDS invariant — every single-author feed must have defaultCritic', () => {
  test('SUBSTACK_CRITIC_FEEDS is non-empty (sanity)', () => {
    assert.ok(SUBSTACK_CRITIC_FEEDS.length > 0,
      'SUBSTACK_CRITIC_FEEDS should have at least one entry (cote-notices is the seed)');
  });

  for (const feed of SUBSTACK_CRITIC_FEEDS) {
    test(`${feed.outletId} has defaultCritic`, () => {
      assert.ok(feed.defaultCritic && typeof feed.defaultCritic === 'string',
        `SUBSTACK_CRITIC_FEEDS entry ${feed.outletId} MUST have a non-empty defaultCritic string. ` +
        `Without it, RSS hits land in _pending/ with criticName='Unknown' and rebuild never reads _pending/.`);
    });

    test(`${feed.outletId} is registered in outlet-registry.json`, () => {
      assert.ok(registry.outlets[feed.outletId],
        `${feed.outletId} must have a matching outlet-registry.json entry so outlet resolution works`);
    });

    test(`outlet-registry ${feed.outletId} has defaultCritic matching the feed`, () => {
      const entry = registry.outlets[feed.outletId];
      assert.strictEqual(
        entry.defaultCritic,
        feed.defaultCritic,
        `outlet-registry.json ${feed.outletId}.defaultCritic must equal the RSS feed config's defaultCritic ` +
        `(belt-and-suspenders for rebuild-all-reviews:2745 fallback). ` +
        `Feed says "${feed.defaultCritic}", registry says "${entry.defaultCritic || '<missing>'}".`
      );
    });
  }
});

describe('All RSS feeds — defaultCritic consistency', () => {
  // Any feed (not just SUBSTACK_CRITIC_FEEDS) that sets defaultCritic must also be
  // consistent with the outlet-registry. Catches drift when a new single-author
  // outlet is added to THEATER_FEEDS or WE_THEATER_FEEDS.
  const feedsWithDefaultCritic = ALL_FEEDS.filter(f => f.defaultCritic);

  for (const feed of feedsWithDefaultCritic) {
    test(`${feed.outletId} registry defaultCritic matches RSS feed`, () => {
      const entry = registry.outlets[feed.outletId];
      assert.ok(entry,
        `Feed ${feed.outletId} has defaultCritic but is not in outlet-registry.json`);
      assert.strictEqual(
        entry.defaultCritic,
        feed.defaultCritic,
        `outlet-registry.json ${feed.outletId}.defaultCritic ("${entry.defaultCritic}") ` +
        `must equal RSS feed defaultCritic ("${feed.defaultCritic}"). ` +
        `These get out of sync when only one is edited.`
      );
    });
  }
});

describe('RSS emit behavior — defaultCritic stamps hit.criticName', () => {
  // Smoke test the emit path at rss-discovery.js:305:
  //   if (feed.defaultCritic) hit.criticName = feed.defaultCritic;
  // We don't want to call checkRSSFeeds (requires live network), so we assert on
  // the module surface instead — every SUBSTACK_CRITIC_FEEDS entry has the
  // property that the emit loop depends on.
  for (const feed of SUBSTACK_CRITIC_FEEDS) {
    test(`${feed.outletId} feed config has defaultCritic property the emit loop reads`, () => {
      assert.ok('defaultCritic' in feed,
        `rss-discovery.js:305 does "if (feed.defaultCritic) hit.criticName = feed.defaultCritic" — ` +
        `the property must exist`);
    });
  }
});
