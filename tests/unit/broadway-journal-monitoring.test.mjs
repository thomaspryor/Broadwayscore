// BRO-6167: Broadway Journal monitoring. Tests require() the real modules.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const rss = require('../../scripts/lib/rss-discovery');
const health = require('../../scripts/lib/commercial-feed-health');
const bj = require('../../scripts/lib/broadway-journal');
const poller = require('../../scripts/poll-trade-press-rss');
const { TRUSTED_RECOUPMENT_HOSTS } = require('../../scripts/lib/trusted-recoupment-domains');
const gate = require('../../scripts/lib/commercial-apply-gate');

describe('feed registration', () => {
  it('Broadway Journal is polled for recoupment but not in review discovery', () => {
    assert.ok(rss.TRACK_RECOUPMENT_FEEDS.some(f => f.outletId === 'broadway-journal'));
    assert.ok(!rss.ALL_FEEDS.some(f => f.outletId === 'broadway-journal'));
    assert.ok(!rss.ALL_FEEDS.some(f => /broadwayjournal/.test(f.url)));
  });
  it('existing recoupment feeds are still tracked', () => {
    for (const id of ['variety', 'deadline', 'hollywood-reporter']) {
      assert.ok(rss.TRACK_RECOUPMENT_FEEDS.some(f => f.outletId === id), id);
    }
  });
  it('broadwayjournal.com stays outside the auto-apply trust list', () => {
    assert.ok(!TRUSTED_RECOUPMENT_HOSTS.has('broadwayjournal.com'));
  });
});

describe('hostGate', () => {
  const bjFeed = rss.BROADWAY_BUSINESS_FEEDS[0];
  it('trusted host auto-applies', () => assert.equal(health.hostGate({ outletId: 'variety' }, 'variety.com'), 'auto'));
  it('opted-in feed on an untrusted host goes to human review', () => assert.equal(health.hostGate(bjFeed, 'broadwayjournal.com'), 'review'));
  it('normal feed on an untrusted host is skipped', () => assert.equal(health.hostGate({ outletId: 'x' }, 'example.com'), 'skip'));
});

describe('dead-source alert', () => {
  it('fires at 3 consecutive failures, not before', () => {
    assert.equal(health.shouldAlertDeadFeed({ errorCount: 2 }), false);
    assert.equal(health.shouldAlertDeadFeed({ errorCount: 3 }), true);
    assert.equal(health.shouldAlertDeadFeed(undefined), false);
  });
  it('builds an auto-disposition routeAlert payload keyed per feed', () => {
    const o = health.deadFeedAlertOpts({ outletId: 'broadway-journal', name: 'Broadway Journal', url: 'u' }, { errorCount: 4, lastError: 'HTTP 404 for u' });
    assert.equal(o.disposition, 'auto');
    assert.equal(o.conditionKey, 'commercial-feed-dead:broadway-journal');
    assert.match(o.title, /4 polls in a row/);
    assert.match(o.description, /HTTP 404/);
  });
  it('routeAlert accepts the payload shape (required fields present)', () => {
    const o = health.deadFeedAlertOpts({ outletId: 'a', name: 'A', url: 'u' }, { errorCount: 3 });
    assert.ok(o.conditionKey && o.title && ['auto', 'digest', 'human'].includes(o.disposition));
  });
});

describe('poller error path', () => {
  it('processFeed returns a findings-bearing result on fetch failure', async () => {
    const state = { feeds: {} };
    const realLog = console.log;
    console.log = () => {}; // the poller's progress lines would corrupt the test runner's stdout stream
    let res;
    try {
      res = await poller.processFeed(
        { outletId: 'dead', name: 'Dead', url: 'http://127.0.0.1:9/feed' }, state, [], { llmCalls: 0, perFeed: {} });
    } finally { console.log = realLog; }
    assert.deepEqual(res.findings, []);
    assert.ok(res.error);
    assert.equal(state.feeds.dead.errorCount, 1);
  });
});

describe('untrusted claim never auto-applies', () => {
  it('apply gate refuses a high-confidence rss-poller claim from broadwayjournal.com', () => {
    const show = { title: 'X', previewDate: '2020-01-01', openingDate: '2020-02-01' };
    const claim = (host) => ({ detectedBy: 'rss-poller', confidence: 'high', sourceHost: host, recoupedDate: '2026-10', recoupedSource: `https://${host}/p/x` });
    assert.equal(gate.isAutoApplyableClaim(claim('broadwayjournal.com'), ['rss-poller'], show), false);
    // control: the same claim from a trusted host passes the host check (it may still fail later checks)
    assert.ok(TRUSTED_RECOUPMENT_HOSTS.has('variety.com'));
  });
  it('aggregate alert lists every slug and never claims a write', () => {
    const o = health.untrustedClaimAlertOpts([
      { show: { slug: 'a' }, url: 'https://www.broadwayjournal.com/p/a', verdict: { evidence: 'recouped' } },
      { show: { slug: 'b' }, url: 'https://www.broadwayjournal.com/p/b', verdict: {} },
    ]);
    assert.match(o.description, /Nothing was written/);
    assert.match(o.title, /a, b/);
  });
});

describe('slug normalization', () => {
  it('maps Substack, www-less and legacy WordPress URLs to one slug', () => {
    for (const u of ['https://www.broadwayjournal.com/p/hells-kitchens-broadway-buyout', 'https://broadwayjournal.com/hells-kitchens-broadway-buyout/', 'http://www.broadwayjournal.com/p/hells-kitchens-broadway-buyout?utm=1']) {
      assert.equal(bj.slugFromUrl(u), 'hells-kitchens-broadway-buyout', u);
    }
    assert.equal(bj.slugFromUrl('https://www.broadwayjournal.com/feed'), null);
    assert.equal(bj.slugFromUrl('https://example.com/p/x'), null);
  });
  it('citedSlugs finds both URL forms inside JSON text', () => {
    const text = JSON.stringify({ a: { src: 'https://www.broadwayjournal.com/p/one' }, b: ['https://broadwayjournal.com/two/'] });
    assert.deepEqual([...bj.citedSlugs(text)].sort(), ['one', 'two']);
  });
});

describe('financial scan', () => {
  it('flags AG-filing language that headlines hide', () => {
    const r = bj.scanFinancialTerms("The show's filing with the New York Attorney General lists capitalization of $20 million.");
    assert.ok(r.hit);
    assert.ok(r.terms.includes('attorney general') && r.terms.includes('capitalization'));
  });
  it('ignores unrelated posts', () => assert.equal(bj.scanFinancialTerms('A profile of a costume designer.').hit, false));
});

describe('archive walk', () => {
  it('pages by what came back, not by the requested limit, and stops on empty', async () => {
    const calls = [];
    const pages = [[{ slug: 'a' }, { slug: 'b' }], [{ slug: 'c' }], []];
    const fetchJson = async (url) => { calls.push(url); return pages[calls.length - 1]; };
    const { posts, complete } = await bj.fetchArchive(fetchJson, { limit: 50 });
    assert.equal(posts.length, 3);
    assert.ok(complete);
    assert.match(calls[1], /offset=2/);
    assert.match(calls[2], /offset=3/);
  });
  it('reports incomplete when the page cap is hit', async () => {
    const { complete } = await bj.fetchArchive(async () => [{ slug: 'x' }], { maxPages: 3 });
    assert.equal(complete, false);
  });
});

describe('selectUncited', () => {
  const mk = (slug, date, terms = ['recoup']) => ({ slug, title: slug, url: `u/${slug}`, postDate: date, terms });
  it('drops cited posts and splits pre-cutoff backlog from fresh', () => {
    const r = bj.selectUncited([mk('cited', '2026-11-01T00:00:00Z'), mk('old', '2026-01-01T00:00:00Z'), mk('new', '2026-11-02T00:00:00Z'), mk('nothing', '2026-11-03T00:00:00Z', [])], new Set(['cited']), { before: '2026-10-24' });
    assert.deepEqual(r.fresh.map(a => a.slug), ['new']);
    assert.deepEqual(r.backlog.map(a => a.slug), ['old']);
  });
  it('sweep alert is one aggregate auto card', () => {
    const o = bj.sweepAlertOpts([mk('a', '2026-11-02T00:00:00Z'), mk('b', '2026-11-03T00:00:00Z')]);
    assert.equal(o.conditionKey, 'commercial-broadway-journal-uncited-posts');
    assert.equal(o.disposition, 'auto');
    assert.match(o.title, /2 posts/);
  });
});

describe('review fixes', () => {
  it('sweep alert uses a short cooldown so a weekly cron is not muted', () => {
    const o = bj.sweepAlertOpts([{ slug: 'a', title: 'a', url: 'u/a', postDate: '2026-11-02T00:00:00Z', terms: ['recoup'] }]);
    assert.ok(o.cooldownHours <= 24);
    assert.equal(bj.SWEEP_CONDITION_KEY, o.conditionKey);
  });
});


describe('alertLanded', () => {
  it('treats a failed card dispatch as not landed', () => {
    assert.equal(health.alertLanded({ action: 'auto', dispatchOk: false, dispatchError: 'linear down' }), false);
    assert.equal(health.alertLanded({ action: 'auto', dispatchError: 'no key' }), false);
    assert.equal(health.alertLanded(null), false);
  });
  it('treats a filed or cooldown-silenced alert as landed', () => {
    assert.equal(health.alertLanded({ action: 'auto', dispatchOk: true, cardId: 'BRO-1' }), true);
    assert.equal(health.alertLanded({ action: 'silent' }), true);
  });
});
