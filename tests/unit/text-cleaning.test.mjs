import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeHtmlEntities } = require('../../scripts/lib/text-cleaning');
const reverse = require('../../scripts/lib/reverse-discovery');
const { parseRssItems } = require('../../scripts/lib/omc-discovery');
const { parsePlaybillBroadwaySchedule } = require('../../scripts/lib/playbill-broadway-schedule');
const lou = require('../../scripts/lib/loureviews-match');

test('canonical decoder covers named punctuation and accents', () => {
  assert.equal(
    decodeHtmlEntities('&lsquo;King&rsquo;s&rdquo; &ldquo;Speech&rdquo; &mdash; &ndash; &hellip; &eacute;'),
    '\'King\'s" "Speech" \u2014 \u2013 ... é',
  );
  assert.equal(decodeHtmlEntities('&amp; &quot; &apos; &lt; &gt; &nbsp;'), '& " \' < >  ');
});

test('canonical decoder preserves numeric Unicode, invalid entities and empty inputs', () => {
  assert.equal(decodeHtmlEntities('&#8217; &#x2014; &#128512;'), '\u2019 \u2014 \u{1F600}');
  assert.equal(decodeHtmlEntities('&#99999999; &#x110000; &unknown;'), '&#99999999; &#x110000; &unknown;');
  assert.equal(decodeHtmlEntities(null), null);
  assert.equal(decodeHtmlEntities(undefined), undefined);
  assert.equal(decodeHtmlEntities(''), '');
});

test('canonical decoder retains the migrated parsers case-insensitive punctuation coverage', () => {
  assert.equal(decodeHtmlEntities('&NBSP;&RSQUO;&MDASH;&QUOT;&#X2019;'), ' \'\u2014"\u2019');
});

test('reverse discovery decodes named quotes and dash separators in actual parser paths', () => {
  assert.equal(reverse.extractShowTitleFromWetRoundup('The King&rsquo;s Speech Reviews: acclaim'), "The King's Speech");
  assert.equal(
    reverse.extractShowTitleFromBwwRoundup('Review Roundup: The King&rsquo;s Speech &mdash; Critics react'),
    "The King's Speech \u2014 Critics react",
  );
  assert.deepEqual(reverse.extractGuardianReview({
    title: 'The King&rsquo;s Speech review &ndash; acclaim', categories: ['London'],
  }), { title: "The King's Speech", market: 'west-end' });
});

test('reverse discovery retains double decoding and the exported venue-validator API', () => {
  assert.equal(reverse.decodeEntities('King&amp;rsquo;s &amp;amp; Queen'), "King's & Queen");
  assert.equal(reverse.decodeEntities(null), '');
  assert.equal(
    reverse.extractShowTitleFromBwwRoundup('Review Roundup: Richard E. Grant &amp;amp; Christine Baranski in HAY FEVER'),
    'HAY FEVER',
  );
});

test('OMC decodes every RSS display field and preserves punctuation and tracking cleanup', () => {
  const [item] = parseRssItems(`<item>
    <title>The King&rsquo;s Speech &mdash; &ldquo;review&rdquo;</title>
    <link>https://example.test/review?keep=1&#038;utm_source=rss&#038;utm_medium=feed</link>
    <dc:creator>Ren&eacute; O&rsquo;Connor</dc:creator>
    <category>Th&eacute;&acirc;tre</category>
  </item>`);
  assert.equal(item.title, 'The King\'s Speech - "review"');
  assert.equal(item.creator, "René O'Connor");
  assert.deepEqual(item.categories, ['théâtre']);
  assert.equal(item.link, 'https://example.test/review?keep=1');
  const [numeric] = parseRssItems('<item><title>&#8220;King&#8217;s&#8221; &#8212; review</title><link>https://example.test/</link></item>');
  assert.equal(numeric.title, '"King\'s" - review');
});

test('Playbill decodes hex and named entities in titles and venue fields', () => {
  const [show] = parsePlaybillBroadwaySchedule(`<title>Schedule of Upcoming Broadway Shows</title>
    <p><a target="_blank" href="https://example.test/show">THE KING&#x2019;S SPEECH</a>
    <br>Theatre: King&rsquo;s &amp; Queen&rsquo;s Theatre
    <br>First Preview: October 20, 2026<br>Opening: November 8, 2026</p>`);
  assert.ok(show);
  assert.equal(show.title, 'THE KING\u2019S SPEECH');
  assert.equal(show.venue, "King's & Queen's Theatre");
  assert.equal(show.opening, '2026-11-08');
});

test('LouReviews retains tag stripping, trimming and venue removal with wider decoding', () => {
  assert.equal(lou.decodeEntities(null), '');
  assert.equal(lou.decodeEntities(' <b>King&rsquo;s</b> '), "King's");
  assert.deepEqual(lou.parseReviewPost(' Play review: <em>&lsquo;The King&rsquo;s Speech&rsquo;</em> at Park Theatre '), {
    showTitle: "'The King's Speech'",
  });
  assert.equal(lou.normalizeTitle('Les Mis&eacute;rables'), 'les miserables');
});

test('byline and Theater Life compatibility exports retain empty-input handling', () => {
  for (const name of ['byline-extraction', 'theater-life-stars']) {
    const { decodeEntities } = require(`../../scripts/lib/${name}`);
    assert.equal(decodeEntities(null), '');
    assert.equal(decodeEntities('&lsquo;King&rsquo;s&mdash;'), "'King's\u2014");
  }
  const { resolveTheaterLifeStars } = require('../../scripts/lib/theater-life-stars');
  assert.equal(resolveTheaterLifeStars({ title: 'Cats ***', text: 'x\nCats ***Venue', showTitles: [null, 'Cats'] }).rating, '3/5 stars');
});

test('RSS and YouTube parsers also decode the widened entity set', () => {
  const { parseRSSItems } = require('../../scripts/lib/rss-discovery');
  const [item] = parseRSSItems('<item><title>King&rsquo;s Speech &mdash; review</title><link>https://example.test/</link></item>');
  assert.equal(item.title, "King's Speech \u2014 review");
  const { sdTranscriptToText } = require('../../scripts/lib/youtube-captions');
  assert.equal(sdTranscriptToText({ transcripts: [{ text: '&ldquo;King&rsquo;s Speech&rdquo; &hellip;' }] }), '"King\'s Speech" ...');
});

test('WOS retains tag and whitespace cleanup while sharing entity coverage', () => {
  const { decodeEntities } = require('../../scripts/lib/wos-rest-listings');
  assert.equal(decodeEntities(' <b>King&rsquo;s</b>\n &amp; Queen&#x2019;s '), "King's & Queen\u2019s");
});
