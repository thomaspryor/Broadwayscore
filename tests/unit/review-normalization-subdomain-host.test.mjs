/**
 * BRO-4502: resolveOutletFromUrl must not resolve a subdomain host through its
 * first label. newyork.timeout.com used to resolve to Edge New York because
 * hostname.split('.')[0] = "newyork" and buildDomainToOutletIndex registered
 * that bare base from newyork.edgemedianetwork.com (22 Time Out NY reviews in
 * the corpus). The same index keyed news.abs-cbn.com under "news", so every
 * news.yahoo.com URL resolved to ABS-CBN.
 *
 * Fix: *.timeout.com city subdomains map to the Time Out editions, parent
 * hosts are tried before any bare-base guess, the bare base is only consulted
 * for a host with no subdomain, and the index keys bare bases by the
 * registrable domain's identity label rather than the first label.
 *
 * Run: node --test tests/unit/review-normalization-subdomain-host.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');
const { publisherDomainCorrection } = require('../../scripts/lib/outlet-mismatch-heal.js');

const quiet = (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = w; }
};
const outletOf = (url) => (quiet(() => resolveOutletFromUrl(url)) || {}).outletId || null;

describe('Time Out city subdomains', () => {
  test('newyork.timeout.com is Time Out New York, not Edge New York', () => {
    assert.equal(outletOf('https://newyork.timeout.com/arts-culture/theater/123/review'), 'timeout');
  });
  test('london.timeout.com is Time Out London', () => {
    assert.equal(outletOf('https://london.timeout.com/theatre/some-play-review'), 'timeout-london');
  });
  test('another city or non-edition subdomain resolves to neither registered edition', () => {
    assert.equal(outletOf('https://chicago.timeout.com/theater/some-play-review'), null);
    assert.equal(outletOf('https://losangeles.timeout.com/theater/x'), null);
    assert.equal(outletOf('https://hongkong.timeout.com/theater/x'), null);
    assert.equal(outletOf('https://media.timeout.com/images/x'), null);
  });
  test('www.timeout.com path split is unchanged', () => {
    assert.equal(outletOf('https://www.timeout.com/newyork/theater/some-review'), 'timeout');
    assert.equal(outletOf('https://www.timeout.com/london/theatre/some-review'), 'timeout-london');
  });
});

describe('subdomain hosts never fall to the first-label bare base', () => {
  test('Edge Media Network city hosts still resolve to their own outlets', () => {
    assert.equal(outletOf('https://newyork.edgemedianetwork.com/story.php?ch=entertainment&id=1'), 'edge-new-york');
    assert.equal(outletOf('https://boston.edgemedianetwork.com/story.php?id=1'), 'edge-boston');
  });
  test('news.yahoo.com no longer resolves to ABS-CBN via the "news" base', () => {
    assert.notEqual(outletOf('https://news.yahoo.com/review-something-010858771.html'), 'abscbnnewscom');
  });
  test('an unknown subdomain on a registered parent host resolves to the parent', () => {
    assert.equal(outletOf('https://online.wsj.com/article/SB100.html'), 'wsj');
    assert.equal(outletOf('https://blogs.villagevoice.com/runninscared/2010/01/x.php'), 'village-voice');
  });
  test('a subdomain whose first label is another outlet\'s bare base does not match it', () => {
    // "preview" is preview.ph's bare base; preview.ew.com is Entertainment Weekly.
    assert.equal(outletOf('https://preview.ew.com/article/2014/1/1/x'), 'ew');
  });
  test('an unlisted country suffix (mb.com.ph) does not register the bare base "com"', () => {
    assert.equal(outletOf('https://mb.com.ph/2024/1/1/review'), outletOf('https://www.mb.com.ph/x'));
    assert.equal(outletOf('https://com.au/x'), null);
  });
  test('a subdomain outlet does not claim its parent domain as a brand', () => {
    // abcnews.go.com (ABC News, an AP alias) and *.typepad.com blogs.
    assert.equal(outletOf('https://go.com/'), null);
    assert.equal(outletOf('https://typepad.com/'), null);
  });
  test('news portals never name the publisher', () => {
    for (const u of ['https://news.yahoo.com/s/ap/20110420/x', 'https://www.yahoo.com/entertainment/x.html',
      'https://www.msn.com/en-us/entertainment/news/x/ar-AA1', 'https://www.aol.com/x']) {
      assert.equal(outletOf(u), null, u);
    }
  });
  test('a trailing root dot is ignored', () => {
    assert.equal(outletOf('https://nytimes.com./2024/x.html'), 'nytimes');
  });
  test('unrelated subdomain on an unregistered parent resolves to nothing', () => {
    assert.equal(outletOf('https://newyork.example-unregistered-site.com/review'), null);
  });
});

describe('bare-base fallback still works for hosts with no subdomain', () => {
  test('exact host', () => {
    assert.equal(outletOf('https://www.nytimes.com/2024/01/01/theater/x.html'), 'nytimes');
  });
  test('other TLD of a registered brand', () => {
    assert.equal(outletOf('https://nytimes.net/x'), 'nytimes');
  });
  test('generic blog. subdomain of a registered brand on another TLD', () => {
    assert.equal(outletOf('https://blog.nytimes.net/x'), 'nytimes');
  });
});

describe('gather-reviews no-match fallback (cousin: hostname.split(".")[0] minting)', () => {
  const { fallbackOutletIdFromHost } = require('../../scripts/gather-reviews.js');
  test('mints from the registrable label, not the subdomain', () => {
    assert.equal(fallbackOutletIdFromHost('someblog.substack.com'), 'someblog');
    assert.equal(fallbackOutletIdFromHost('zzq-unregistered-blog.com'), 'zzq-unregistered-blog');
  });
  test('never mints a registered outlet id the resolver declined', () => {
    assert.equal(fallbackOutletIdFromHost('losangeles.timeout.com'), 'unknown');
    assert.equal(fallbackOutletIdFromHost('news.yahoo.com'), 'unknown');
  });
});

describe('outlet-mismatch heal never relabels onto a syndication portal', () => {
  test('AP review on news.yahoo.com is not moved to Yahoo', () => {
    const data = {
      outletId: 'abscbnnewscom',
      outlet: 'ABS-CBN News',
      criticName: 'Mark Kennedy',
      url: 'https://news.yahoo.com/review-holland-taylors-ann-sweet-valentine-010858771.html',
    };
    assert.equal(quiet(() => publisherDomainCorrection(data)), null);
  });
});
