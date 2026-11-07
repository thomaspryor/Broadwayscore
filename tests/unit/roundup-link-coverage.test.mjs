// BRO-5557: coverage check for the review links named on archived roundup pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractReviewLinks, classifyLinks, siteOf } = require('../../scripts/lib/roundup-link-coverage.js');

const BWW = `<a href="https://www.broadwayworld.com/reviews/">Reviews</a>
<a href="https://www.vulture.com/article/a.html">Vulture :</a>
<a href="https://nystagereview.com/2026/10/14/one/">New York Stage Review:</a>
<a href="https://nystagereview.com/2026/10/14/two/">New York Stage Review:</a>
<a href="https://www.wisdomdigital.com">Wisdom Digital Media</a>`;
const PV = `<p><a href="https://www.theatermania.com/news/review-x_1/" target="_blank">TheaterMania (Zachary Stewart)</a></p>
<a href="https://audibletheater.com/" target="_blank">Official site</a>`;

test('extracts review links from a BWW roundup and a Playbill Verdict page, skipping chrome', () => {
  assert.deepEqual(extractReviewLinks(BWW, 'bww-roundups').map((l) => l.site), ['vulture.com', 'nystagereview.com', 'nystagereview.com']);
  assert.deepEqual(extractReviewLinks(PV, 'playbill-verdict').map((l) => l.site), ['theatermania.com']);
});

test('classifies covered / excluded / missing', () => {
  const links = extractReviewLinks(BWW, 'bww-roundups');
  const rows = [{ url: 'https://www.vulture.com/article/a.html' }];
  const files = [{ url: 'https://nystagereview.com/2026/10/14/one/', contentTier: 'invalid', rejectionReason: 'not_a_review', __file: 'nysr--a.json' }];
  const r = classifyLinks(links, rows, files);
  assert.equal(r[0].status, 'covered');
  assert.equal(r[1].status, 'excluded');
  assert.match(r[1].reason, /not_a_review/);
  assert.equal(r[2].status, 'missing');
});

test('two links to one site are covered only when we hold two rows there', () => {
  const links = extractReviewLinks(BWW, 'bww-roundups').filter((l) => l.site === 'nystagereview.com');
  const one = classifyLinks(links, [{ url: 'https://nystagereview.com/2026/10/14/one/' }], []);
  assert.equal(one[0].status, 'covered');
  assert.equal(one[1].status, 'missing');
  const two = classifyLinks(links, [{ url: 'https://nystagereview.com/x' }, { url: 'https://nystagereview.com/y' }], []);
  assert.deepEqual(two.map((r) => r.status), ['covered', 'covered']);
});

test('siteOf keeps co.uk registrable domains and separates substack publishers', () => {
  assert.equal(siteOf('https://www.thestage.co.uk/reviews/x'), 'thestage.co.uk');
  assert.equal(siteOf('https://stephenkearley.substack.com/p/x'), 'stephenkearley.substack.com');
  assert.equal(siteOf('https://www.nytimes.com/2026/a.html'), 'nytimes.com');
  assert.equal(siteOf('https://www.abc.net.au/a'), 'abc.net.au');
});

const { isPlausibleForShow, urlDate } = require('../../scripts/lib/roundup-link-coverage.js');
test('urlDate reads dated paths', () => {
  assert.equal(urlDate('https://nystagereview.com/2026/10/14/a-ghost/'), '2026-10-14');
  assert.equal(urlDate('https://www.broadwayworld.com/article/Review-X-20261016'), '2026-10-16');
  assert.equal(urlDate('https://www.newyorktheatreguide.com/reviews/x'), null);
  assert.equal(urlDate('https://chicago.suntimes.com/2019/6/4/18652634/ms-blakk-review'), '2019-06-04');
  assert.equal(urlDate('https://variety.com/2022/legit/reviews/potus-review-play-broadway-1235253436/'), '2022-07-01');
});
test('links to another production or another show are not gaps', () => {
  const show = { title: 'A Christmas Carol', openingDate: '2026-11-20' };
  assert.equal(isPlausibleForShow({ url: 'http://nystagereview.com/2019/11/20/a-christmas-carol-god-blast/' }, show), false);
  assert.equal(isPlausibleForShow({ url: 'https://nystagereview.com/2026/11/21/a-christmas-carol-review/' }, show), true);
  assert.equal(isPlausibleForShow({ url: 'https://www.newyorktheatreguide.com/reviews/some-other-show-review' }, show), false);
  assert.equal(isPlausibleForShow({ url: 'https://variety.com/2019/legit/reviews/a-christmas-carol-review/' }, show), false);
  // whole words only: 'our' is not in 'your'
  assert.equal(isPlausibleForShow({ url: 'https://x.com/2026/11/your-night-review/' }, { title: 'Our Town', openingDate: '2026-11-20' }), false);
});
