// BRO-7414: a reveal plan names its show in plan.key (no plan.shows); videoLink must resolve it, never throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const { videoLink } = require('./channel-captions');

test('videoLink: reveal plan resolves its show from plan.key', () => {
  const lookup = id => (id === 'hamilton-2015' ? { slug: 'hamilton', category: 'broadway', openingDate: '2015-08-06' } : null);
  const r = videoLink({ fmt: 'reveal', key: 'hamilton-2015' }, lookup);
  assert.match(r.url, /^https:\/\//);
  assert.equal(r.key, 'hamilton-2015');
});

test('videoLink: reveal plan for an unknown show throws instead of shipping a dead link', () => {
  assert.throws(() => videoLink({ fmt: 'reveal', key: 'nope' }, () => null), /no site entry/);
});

test('channelCaption: voscript reveal caption ("Every review is at <domain>") gets the per-network link line', () => {
  const link = { domain: 'broadwayscorecard.com', key: 'k', url: 'https://broadwayscorecard.com/' };
  const caption = '20 critics weighed in on X. One score: 81, Recommended. Every review is at broadwayscorecard.com\n\n#Broadway';
  const { channelCaption } = require('./channel-captions');
  for (const n of ['tiktok', 'youtube']) {
    const out = channelCaption(caption, n, link);
    assert.match(out, /See every review at broadwayscorecard\.com/);
    assert.ok(!/Every review is at/.test(out));
  }
});
