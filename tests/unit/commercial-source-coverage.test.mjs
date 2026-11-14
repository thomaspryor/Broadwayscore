// BRO-6211: business-news coverage. Tests require() the real modules.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const rss = require('../../scripts/lib/rss-discovery');
const cov = require('../../scripts/lib/commercial-source-coverage');
const cronCov = require('../../scripts/lib/cron-coverage');
const { TRUSTED_RECOUPMENT_HOSTS } = require('../../scripts/lib/trusted-recoupment-domains');

describe('feed registration', () => {
  it('Playbill and Broadway News are polled for recoupment, not in review discovery', () => {
    for (const id of ['playbill', 'broadway-news']) {
      assert.ok(rss.TRACK_RECOUPMENT_FEEDS.some(f => f.outletId === id), id);
      assert.ok(!rss.ALL_FEEDS.some(f => f.outletId === id), `${id} leaked into ALL_FEEDS`);
    }
  });
  it('Broadway News goes to human review; Playbill is a trusted host', () => {
    assert.ok(!TRUSTED_RECOUPMENT_HOSTS.has('broadwaynews.com'));
    assert.equal(rss.TRACK_RECOUPMENT_FEEDS.find(f => f.outletId === 'broadway-news').untrustedClaimsToReview, true);
    assert.ok(TRUSTED_RECOUPMENT_HOSTS.has('playbill.com'));
  });
  it('Broadway News uses the final /rss/ URL (the /feed/ 301 is relative)', () => {
    assert.equal(rss.TRACK_RECOUPMENT_FEEDS.find(f => f.outletId === 'broadway-news').url, 'https://www.broadwaynews.com/rss/');
  });
  it('every tracked feed host is trusted or opted in to human review', () => {
    for (const f of rss.TRACK_RECOUPMENT_FEEDS) {
      const host = cov.hostOf(f.url);
      assert.ok(TRUSTED_RECOUPMENT_HOSTS.has(host) || f.untrustedClaimsToReview === true, `${f.outletId} (${host})`);
    }
  });
});

describe('feed parsing', () => {
  it('uses dc:date when an item has no pubDate (Playbill)', () => {
    const xml = '<rss><channel><item><title>T</title><link>https://playbill.com/article/x</link><dc:date>2026-10-24T09:00:00</dc:date></item></channel></rss>';
    const [item] = rss.parseFeedItems(xml);
    assert.ok(item.pubDate instanceof Date && !isNaN(item.pubDate.getTime()));
    assert.equal(item.pubDate.getFullYear(), 2026);
  });
  it('still prefers pubDate when both exist', () => {
    const xml = '<rss><channel><item><title>T</title><link>https://a.com/x</link><pubDate>Mon, 05 Jan 2026 10:00:00 GMT</pubDate><dc:date>2020-01-01T00:00:00</dc:date></item></channel></rss>';
    assert.equal(rss.parseFeedItems(xml)[0].pubDate.getUTCFullYear(), 2026);
  });
  it('fetchUrl follows a relative redirect Location', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/feed/') { res.writeHead(301, { Location: '/rss/' }); res.end(); }
      else { res.writeHead(200); res.end('<rss/>'); }
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      assert.equal(await rss.fetchUrl(`http://127.0.0.1:${srv.address().port}/feed/`), '<rss/>');
    } finally { srv.close(); }
  });
});

describe('fetchUrl redirect cap', () => {
  it('rejects a redirect loop instead of recursing forever', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(rss.fetchUrl(`http://127.0.0.1:${srv.address().port}/x`), /Too many redirects/);
    } finally { srv.close(); }
  });
});

describe('coverage evaluation', () => {
  const shows = {
    a: { sources: [{ url: 'https://www.newsite.com/1' }, { url: 'https://newsite.com/2' }] },
    b: { sources: [{ url: 'https://newsite.com/3' }], analystRecoupUrl: 'https://tracked.com/x' },
    c: { sources: [{ url: 'bad url' }], costHistory: [{ sourceUrl: 'https://costonly.com/x' }], recoupedSource: 'https://tracked.com/y' },
  };
  it('counts distinct shows per host and ignores costHistory and junk', () => {
    const c = cov.countCitedHosts(shows);
    assert.equal(c.get('newsite.com'), 2);
    assert.equal(c.get('tracked.com'), 2);
    assert.ok(!c.has('costonly.com'));
  });
  it('flags an uncovered host at the threshold, warns below it', () => {
    const counts = new Map([['big.com', 10], ['mid.com', 5], ['small.com', 4], ['ok.com', 40]]);
    const r = cov.evaluateCoverage(counts, new Set(['ok.com']), {});
    assert.deepEqual(r.uncovered, [{ host: 'big.com', shows: 10 }]);
    assert.deepEqual(r.warnings, [{ host: 'mid.com', shows: 5 }]);
  });
  it('an exemption or a tracked feed covers a host', () => {
    const counts = new Map([['big.com', 30], ['ex.com', 30]]);
    const r = cov.evaluateCoverage(counts, new Set(['big.com']), { 'ex.com': 'no feed' });
    assert.equal(r.uncovered.length, 0);
  });
  it('reports stale exemptions (uncited or now tracked) and empty reasons', () => {
    const counts = new Map([['now-tracked.com', 20]]);
    const r = cov.evaluateCoverage(counts, new Set(['now-tracked.com']), { 'gone.com': 'x', 'now-tracked.com': 'x', 'blank.com': ' ' });
    assert.deepEqual(r.staleExemptions.sort(), ['blank.com', 'gone.com', 'now-tracked.com']);
    assert.deepEqual(r.emptyReasons, ['blank.com']);
  });
  it('every shipped exemption has a reason', () => {
    for (const [h, why] of Object.entries(cov.EXEMPT_HOSTS)) assert.ok(why.trim().length > 10, h);
  });
});

describe('Broadway Journal sweep cron watch (BRO-6211 item 3)', () => {
  it('stays on the liveness path (exempt entry has no [no-liveness] opt-out)', () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const entries = cronCov.parseExemptEntries(fs.readFileSync(path.join(root, '.cron-health-exempt.txt'), 'utf8'));
    const wf = 'commercial-broadway-journal-sweep.yml';
    assert.ok(entries.has(wf));
    const paths = cronCov.classifyAlertPaths([wf], new Set(), [], entries);
    assert.equal(paths.get(wf), 'liveness');
  });
  it('a missed weekly run goes stale after 192h, a recent one is alive', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    const crons = ['7 14 * * 1'];
    const old = [{ conclusion: 'success', created_at: '2026-10-12T14:07:00Z' }];
    const fresh = [{ conclusion: 'success', created_at: '2026-10-26T14:07:00Z' }];
    assert.equal(cronCov.livenessVerdict({ crons, runs: old, now }).status, 'stale');
    assert.equal(cronCov.livenessVerdict({ crons, runs: fresh, now }).status, 'alive');
  });
});
