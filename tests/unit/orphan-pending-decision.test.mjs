/**
 * Unit tests for scripts/lib/orphan-pending-decision.js — the decision logic
 * underlying scripts/clean-orphan-pending.js.
 *
 * Run: node --test tests/unit/orphan-pending-decision.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  decide,
  tierRank,
  normalizeUrlFragment,
  looksLikeSameArticle,
  MULTI_CRITIC_OUTLETS,
  FUZZY_SOURCES,
} = require('../../scripts/lib/orphan-pending-decision.js');

const showsWith = (ids) => ({ has: (id) => new Set(ids).has(id) });
const mk = (over = {}) => ({ filename: over.filename || 'x.json', data: { contentTier: 'complete', ...over } });

describe('tierRank', () => {
  it('ranks complete > truncated > excerpt > stub > invalid', () => {
    assert.ok(tierRank('complete') > tierRank('truncated'));
    assert.ok(tierRank('truncated') > tierRank('excerpt'));
    assert.ok(tierRank('excerpt') > tierRank('stub'));
    assert.ok(tierRank('stub') > tierRank('invalid'));
    assert.strictEqual(tierRank('unknown-tier'), 0);
    assert.strictEqual(tierRank(undefined), 0);
  });
});

describe('normalizeUrlFragment', () => {
  it('strips query / hash / trailing slash / case', () => {
    assert.strictEqual(normalizeUrlFragment('HTTPS://Example.Com/Path/?q=1#x'), 'https://example.com/path');
    assert.strictEqual(normalizeUrlFragment('https://x.com/a/b/'), 'https://x.com/a/b');
  });
  it('handles null / non-string', () => {
    assert.strictEqual(normalizeUrlFragment(null), null);
    assert.strictEqual(normalizeUrlFragment(undefined), null);
    assert.strictEqual(normalizeUrlFragment(42), null);
  });
  it('does NOT strip differing path segments (/reviews/ vs /news/)', () => {
    const a = normalizeUrlFragment('https://variety.com/2026/legit/reviews/x-1234567/');
    const b = normalizeUrlFragment('https://variety.com/2026/legit/news/x-1234567/');
    assert.notStrictEqual(a, b, 'URL fragments with different path segments must stay distinct');
  });
});

describe('looksLikeSameArticle', () => {
  it('matches by trailing numeric article ID (Variety/THR pattern)', () => {
    const p = { url: 'https://variety.com/2026/legit/reviews/show-1236726809/' };
    const c = { url: 'https://variety.com/2026/legit/news/show-1236726809/' };
    assert.strictEqual(looksLikeSameArticle(p, c), true);
  });
  it('does NOT match when article IDs differ', () => {
    const p = { url: 'https://variety.com/2026/legit/reviews/show-1111111/' };
    const c = { url: 'https://variety.com/2026/legit/reviews/show-2222222/' };
    assert.strictEqual(looksLikeSameArticle(p, c), false);
  });
  it('matches by identical pullQuote when both non-empty', () => {
    assert.strictEqual(looksLikeSameArticle(
      { pullQuote: 'A genuine triumph.' },
      { pullQuote: 'A genuine triumph.' },
    ), true);
  });
  it('matches by first 200 chars of fullText', () => {
    const t = 'Lorem ipsum dolor sit amet '.repeat(20);
    assert.strictEqual(looksLikeSameArticle({ fullText: t }, { fullText: t }), true);
  });
  it('does not match when nothing is identifiable', () => {
    assert.strictEqual(looksLikeSameArticle({}, {}), false);
    assert.strictEqual(looksLikeSameArticle({ url: 'https://a.com/x' }, { url: 'https://b.com/y' }), false);
  });
});

describe('decide — Rule 1: synthetic shows', () => {
  it('deletes files from shows not in shows.json', () => {
    const d = decide('proof-express-test-2026', { source: 'serp-discovery' }, [], showsWith(['real-show']));
    assert.strictEqual(d.action, 'delete');
    assert.match(d.reason, /synthetic/);
  });
  it('keeps real-show files (--only-synthetic mode)', () => {
    const d = decide('real-show', { source: 'rss-discovery', outletId: 'x', criticName: 'Unknown', url: 'https://x' }, [], showsWith(['real-show']), { onlySynthetic: true });
    assert.strictEqual(d.action, 'keep');
    assert.match(d.reason, /only-synthetic/);
  });
});

describe('decide — Rule 2: URL collision', () => {
  it('deletes pending when main has same URL and same/better tier', () => {
    const pending = { url: 'https://nyt.com/x', contentTier: 'stub', source: 'rss-discovery', outletId: 'nyt', criticName: 'Unknown' };
    const main = [mk({ filename: 'nyt--x.json', url: 'https://nyt.com/x', contentTier: 'complete' })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'delete');
    assert.match(d.reason, /url-match/);
  });
  it('keeps pending (needs --allow-promote) when main tier is LOWER', () => {
    const pending = { url: 'https://nyt.com/x', contentTier: 'complete', source: 'rss-discovery', outletId: 'nyt', criticName: 'Unknown' };
    const main = [mk({ filename: 'nyt--x.json', url: 'https://nyt.com/x', contentTier: 'invalid' })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'keep');
    assert.match(d.reason, /allow-promote/);
  });
  it('promotes when --allow-promote is on and pending is richer', () => {
    const pending = { url: 'https://nyt.com/x', contentTier: 'complete', source: 'rss-discovery', outletId: 'nyt', criticName: 'Unknown' };
    const main = [mk({ filename: 'nyt--x.json', url: 'https://nyt.com/x', contentTier: 'invalid' })];
    const d = decide('show', pending, main, showsWith(['show']), { allowPromote: true });
    assert.strictEqual(d.action, 'promote');
    assert.strictEqual(d.target.filename, 'nyt--x.json');
  });
});

describe('decide — Rule 3: outlet-dup for fuzzy sources (multi-critic safety)', () => {
  it('REGRESSION: multi-critic outlet (Variety) with DIFFERENT article keeps pending', () => {
    const pending = {
      outletId: 'variety',
      criticName: 'Unknown',
      source: 'rss-discovery',
      url: 'https://variety.com/2026/legit/reviews/second-critic-article-9999999/',
      contentTier: 'stub',
    };
    const main = [mk({
      filename: 'variety--brent-lang.json',
      outletId: 'variety',
      criticName: 'Brent Lang',
      url: 'https://variety.com/2026/legit/news/primary-critic-article-1234567/',
      contentTier: 'complete',
    })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'keep', 'multi-critic outlet + different article fingerprint must not delete');
    assert.match(d.reason, /possible second critic/);
  });

  it('multi-critic outlet (Variety) with SAME article ID deletes pending', () => {
    const pending = {
      outletId: 'variety',
      criticName: 'Unknown',
      source: 'rss-discovery',
      url: 'https://variety.com/2026/legit/reviews/show-1236726809/',
      contentTier: 'stub',
    };
    const main = [mk({
      filename: 'variety--brent-lang.json',
      outletId: 'variety',
      criticName: 'Brent Lang',
      url: 'https://variety.com/2026/legit/news/show-1236726809/', // same article ID, different path
      contentTier: 'complete',
    })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'delete');
    assert.match(d.reason, /fingerprint matches/);
  });

  it('single-critic outlet (not in MULTI_CRITIC list) always deletes outlet-dup', () => {
    const pending = {
      outletId: 'frontmezzjunkies',
      criticName: 'Unknown',
      source: 'rss-discovery',
      url: 'https://frontmezzjunkies.com/some-article',
      contentTier: 'stub',
    };
    const main = [mk({
      filename: 'frontmezzjunkies--ross.json',
      outletId: 'frontmezzjunkies',
      criticName: 'Ross',
      url: 'https://frontmezzjunkies.com/different-article',
      contentTier: 'complete',
    })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'delete');
    assert.match(d.reason, /outlet-dup/);
  });

  it('does NOT fire on source=serp-discovery (those reach AUTHOR ENRICHMENT)', () => {
    const pending = {
      outletId: 'nytimes',
      criticName: 'Unknown',
      source: 'serp-discovery',
      url: 'https://nyt.com/x',
      contentTier: 'stub',
    };
    const main = [mk({ filename: 'nyt--zinoman.json', outletId: 'nytimes', criticName: 'Jason Zinoman', contentTier: 'complete' })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'keep');
  });

  it('preserves pending if it has fullText that the named file lacks', () => {
    const pending = {
      outletId: 'somesingleoutlet', // not in MULTI_CRITIC, so we reach fullText branch
      criticName: 'Unknown',
      source: 'rss-discovery',
      url: 'https://x.com/y',
      contentTier: 'complete',
      fullText: 'A real review starts here and continues for many paragraphs...',
    };
    const main = [mk({
      filename: 'somesingleoutlet--named.json',
      outletId: 'somesingleoutlet',
      criticName: 'Named Critic',
      url: 'https://x.com/z',
      contentTier: 'stub',
      fullText: null,
    })];
    const d = decide('show', pending, main, showsWith(['show']));
    assert.strictEqual(d.action, 'keep');
    assert.match(d.reason, /preserve for manual review/);
  });
});

describe('decide — keep defaults', () => {
  it('keeps pending when no main duplicate exists', () => {
    const pending = { outletId: 'x', criticName: 'Unknown', source: 'rss-discovery', url: 'https://x.com/y', contentTier: 'stub' };
    const d = decide('show', pending, [], showsWith(['show']));
    assert.strictEqual(d.action, 'keep');
    assert.match(d.reason, /legitimate unenriched/);
  });
});
