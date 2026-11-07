import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasUsableText, isPlausibleArticleRedirect, redirectRepairDecision } = require('./rediscovery-candidate.js');

test('repair: bad redirect with junk text is repaired back to the original URL', () => {
  const d = redirectRepairDecision({
    urlDiscoveryMethod: 'http-redirect',
    previousUrl: 'https://variety.com/2012/legit/reviews/dead-accounts-1118061665/',
    url: 'https://variety.com/2012/film/news/better-days-for-indie-financing-1118061665/',
    fullText: 'Better days for indie financing. Plus Icon Film ...',
  }, 'Dead Accounts');
  assert.equal(d.repair, true);
  assert.equal(d.from, 'https://variety.com/2012/legit/reviews/dead-accounts-1118061665/');
});

test('repair: opaque-slug move whose text names the show is kept', () => {
  const d = redirectRepairDecision({
    urlDiscoveryMethod: 'http-redirect',
    previousUrl: 'https://www.nydailynews.com/entertainment/broadway/ny-20221202-varbwx6ldnapvoyrn57ns2ruwi-story.html',
    url: 'https://www.nydailynews.com/2022/12/02/in-aint-no-mo-black-americans-are-offered-the-chance/',
    fullText: 'Jordan E. Cooper’s “Ain’t No Mo’,” a blast of a Black Broadway show',
  }, "Ain't No Mo'");
  assert.equal(d.repair, false);
});

test('repair: redirect to a section front is repaired even when the section lists the show', () => {
  const d = redirectRepairDecision({
    urlDiscoveryMethod: 'http-redirect',
    previousUrl: 'https://www.amny.com/entertainment/elf-the-musical-broadway-review-2024/',
    url: 'https://www.amny.com/entertainment/',
    fullText: 'NYC Entertainment News ... Elf returns to Broadway ...',
  }, 'Elf');
  assert.equal(d.repair, true);
});

test('repair: plausible redirects and non-redirect files are untouched', () => {
  assert.equal(redirectRepairDecision({ urlDiscoveryMethod: 'google-serp', url: 'https://x.com/a' }, 'X').repair, false);
  assert.equal(redirectRepairDecision({
    urlDiscoveryMethod: 'http-redirect', previousUrl: 'http://x.com/hadestown-review', url: 'https://x.com/hadestown-review',
  }, 'Hadestown').repair, false);
});

test('redirect to an unrelated attachment page is refused (variety cyrano -> luisa fernanda photo)', () => {
  const r = isPlausibleArticleRedirect(
    'https://variety.com/2007/legit/reviews/cyrano-de-bergerac-1200558847/',
    'https://variety.com/2007/legit/reviews/luisa-fernanda-1200558845/attachment/photos-reviewl-rluisa-jpg/',
  );
  assert.equal(r.ok, false);
});

test('opaque-id and query-string moves follow (nydailynews story id, youtu.be)', () => {
  assert.equal(isPlausibleArticleRedirect(
    'https://www.nydailynews.com/entertainment/broadway/ny-20221202-varbwx6ldnapvoyrn57ns2ruwi-story.html',
    'https://www.nydailynews.com/2022/12/02/in-aint-no-mo-black-americans-are-offered-the-chance/').ok, true);
  assert.equal(isPlausibleArticleRedirect('https://youtu.be/mQagN3VgD-s', 'https://www.youtube.com/watch?v=mQagN3VgD-s&feature=youtu.be').ok, true);
});

test('repair skips admin/login junk records', () => {
  assert.equal(redirectRepairDecision({
    urlDiscoveryMethod: 'http-redirect',
    previousUrl: 'https://didtheylikeit.com/wp-admin/post-new.php?post_type=shows',
    url: 'https://didtheylikeit.com/wp-login.php?redirect_to=x',
  }, "Bob Fosse's Dancin'").repair, false);
});

test('redirect to the site root is refused', () => {
  assert.equal(isPlausibleArticleRedirect('https://example.com/2019/05/hadestown-review/', 'https://example.com/').ok, false);
});

test('same-article moves follow: case change, host rebrand, protocol, opaque ids', () => {
  assert.equal(isPlausibleArticleRedirect(
    'https://www.sfgate.com/entertainment/article/Arthur-Miller-wrote-All-My-Sons-in-1947-The-2783345.php',
    'https://www.sfgate.com/entertainment/article/arthur-miller-wrote-all-my-sons-in-1947-the-2783345.php').ok, true);
  assert.equal(isPlausibleArticleRedirect(
    'https://www.culturalweekly.com/making-missing-connections-frankie-johnny-long-lost-happy-talk/',
    'https://culturaldaily.com/making-missing-connections-frankie-johnny-long-lost-happy-talk/').ok, true);
  assert.equal(isPlausibleArticleRedirect(
    'http://online.wsj.com/article/SB10001424052748704187204575101443623615472.html',
    'https://online.wsj.com/article/SB10001424052748704187204575101443623615472.html').ok, true);
  assert.equal(isPlausibleArticleRedirect('http://almeida.co.uk', 'https://almeida.co.uk/').ok, true);
});

const excerpt = 'The show has a sweetness that is hard to resist, even when the score blurs together into one long wistful sigh.';

test('dead-URL file holding only an aggregator excerpt is a rediscovery candidate', () => {
  assert.equal(hasUsableText({ fullText: excerpt, incompleteReason: 'url_content_mismatch', contentTier: 'truncated' }), false);
  assert.equal(hasUsableText({ fullText: excerpt, incompleteReason: 'url_dead' }), false);
});

test('excerpt with a non-URL failure (paywall, garbage) still counts as text', () => {
  assert.equal(hasUsableText({ fullText: excerpt, incompleteReason: 'paywall' }), true);
  assert.equal(hasUsableText({ fullText: excerpt }), true);
});

test('long text on a URL failure is left alone (may be the real article)', () => {
  assert.equal(hasUsableText({ fullText: 'x'.repeat(4000), incompleteReason: 'url_content_mismatch' }), true);
});

test('no or tiny text is never usable', () => {
  assert.equal(hasUsableText({}), false);
  assert.equal(hasUsableText({ fullText: 'short' }), false);
  assert.equal(hasUsableText(null), false);
});
