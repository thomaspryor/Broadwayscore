const assert = require('assert');
const { normalizeUrl } = require('./lib/review-normalization');
const { urlCanonicallyChanged } = require('./lib/url-change-invariant');
const same = [
  ['https://www.nytimes.com/2019/a.html?smtyp=cur', 'https://www.nytimes.com/2019/a.html'],
  ['https://x.com/a?mc_cid=1&mc_eid=2', 'https://x.com/a'],
  ['https://x.com/a?via=tw&cmp=1&ocid=2&mod=3&igshid=4', 'https://x.com/a'],
  ['https://www.ft.com/intl/content/abc-123', 'https://www.ft.com/content/abc-123'],
];
for (const [a, b] of same) {
  assert.strictEqual(normalizeUrl(a), normalizeUrl(b), `normalize ${a}`);
  assert.strictEqual(urlCanonicallyChanged(a, b), false, `changed ${a}`);
}
assert.strictEqual(urlCanonicallyChanged('https://x.com/a', 'https://x.com/b'), true);
assert.strictEqual(urlCanonicallyChanged('https://x.com/a', 'https://x.com/a b'), false);
assert.strictEqual(urlCanonicallyChanged('https://x.com/a?id=1', 'https://x.com/a?id=2'), true);
console.log('url-hygiene-bro7304: all assertions passed');
