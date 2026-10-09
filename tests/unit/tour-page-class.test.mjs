/**
 * tour-page-class (BRO-4931): what a Tours To You page is, before it can
 * become a tour entry. Synthetic shows and engagements only.
 *
 * Run: node --test tests/unit/tour-page-class.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const {
  classifyTourPage, loadTourPageClasses, overrideProblems, overlappingEngagements, infoboxClass,
  companyOfSlug, decodeTitle, pageTitleFromHtml, TEMPLATE_RE, EVENT_RE, OVERRIDES_PATH,
} = require('../../scripts/lib/tour-page-class.js');

const SHOWS = [
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06' },
  { id: 'hamilton-tour-2024', title: 'Hamilton', category: 'tour', tourOf: 'hamilton-2015', tourScheduleSlug: 'hamilton', openingDate: '2024-08-16' },
  { id: 'six-2021', title: 'SIX', category: 'broadway', openingDate: '2021-10-03' },
  { id: 'six-tour-2022', title: 'SIX', category: 'tour', tourOf: 'six-2021', tourScheduleSlug: 'six-the-musical', openingDate: '2022-09-20' },
  { id: 'heathers-the-musical-off-broadway-2025', title: 'Heathers The Musical', category: 'off-broadway', openingDate: '2025-06-30' },
  { id: 'mystic-pizza-regional-2025', title: 'Mystic Pizza', category: 'regional', openingDate: '2025-08-01' },
  { id: 'the-woman-in-black-west-end-1989', title: 'The Woman in Black', category: 'west-end', openingDate: '1989-06-07' },
];

const d = iso => new Date(`${iso}T00:00:00Z`);
const eng = (city, start, end = start) => ({ city, venue: 'V', start: d(start), end: d(end) });
// A tour: one city after another.
const SEQUENTIAL = [eng('Boston, MA', '2026-10-06', '2026-10-11'), eng('Hartford, CT', '2026-10-13', '2026-10-18'), eng('Albany, NY', '2026-10-20', '2026-10-25'), eng('Buffalo, NY', '2026-10-27', '2026-11-01')];

test('a human override always wins, even over a template slug or an event keyword', () => {
  const overrides = {
    'cirque-fake': { class: 'production', title: 'Cirque Fake', type: 'musical', reason: 'a book musical despite the name', issue: 'BRO-4931', reviewedAt: '2026-10-09' },
    'show-page-template': { class: 'production', title: 'Real Show', type: 'play', reason: 'x', issue: 'BRO-4931', reviewedAt: '2026-10-09' },
    'holiday-shows': { class: 'aggregator', reason: 'a list', issue: 'BRO-4931', reviewedAt: '2026-10-09' },
  };
  const a = classifyTourPage({ slug: 'cirque-fake', shows: SHOWS, overrides });
  assert.equal(a.class, 'production');
  assert.equal(a.source, 'override');
  assert.equal(a.title, 'Cirque Fake');
  assert.equal(a.type, 'musical');
  assert.equal(a.parentId, undefined, 'a standalone production has no parent');
  assert.equal(classifyTourPage({ slug: 'show-page-template', shows: SHOWS, overrides }).class, 'production');
  assert.equal(classifyTourPage({ slug: 'holiday-shows', shows: SHOWS, overrides, rows: SEQUENTIAL }).class, 'aggregator', 'the override beats the structure that would say production');
  // An override naming a parent borrows its title and type.
  const withParent = classifyTourPage({ slug: 'heathers', shows: SHOWS, overrides: { heathers: { class: 'production', parentId: 'heathers-the-musical-off-broadway-2025', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' } } });
  assert.deepEqual([withParent.parentId, withParent.title], ['heathers-the-musical-off-broadway-2025', 'Heathers The Musical']);
});

test('template pages are told by their slug', () => {
  for (const slug of ['show-page-template', 'dear-evan-hansen-tester', 'dear-evan-hansen-show-template', 'test-show', 'sample-page']) {
    assert.equal(classifyTourPage({ slug, shows: SHOWS }).class, 'template', slug);
  }
  // Words that merely contain the letters are not templates.
  for (const slug of ['contest-the-musical', 'attester', 'protest-song']) assert.equal(TEMPLATE_RE.test(slug), false, slug);
});

test('a page titled like a tracked production is that production, in any market', () => {
  const heathers = classifyTourPage({ slug: 'heathers-the-musical', pageTitle: 'Heathers: The Musical', shows: SHOWS });
  assert.deepEqual([heathers.class, heathers.parentId, heathers.source], ['production', 'heathers-the-musical-off-broadway-2025', 'title-match']);
  const mystic = classifyTourPage({ slug: 'mystic-pizza', pageTitle: 'Mystic Pizza', shows: SHOWS });
  assert.equal(mystic.parentId, 'mystic-pizza-regional-2025');
  assert.equal(mystic.title, 'Mystic Pizza');
  assert.equal(classifyTourPage({ slug: 'the-woman-in-black', pageTitle: 'The Woman in Black', shows: SHOWS }).parentId, 'the-woman-in-black-west-end-1989');
  // A title match beats an event keyword: the shows list decides what is a show.
  assert.equal(classifyTourPage({ slug: 'six-the-musical', pageTitle: 'SIX', shows: SHOWS }).parentId, 'six-2021');
});

test('hamilton-angelica and six-the-musical-boleyn are companies of tracked tours, not new productions', () => {
  for (const [slug, of] of [['hamilton-angelica', 'hamilton-tour-2024'], ['hamilton-peggy', 'hamilton-tour-2024'], ['six-the-musical-boleyn', 'six-tour-2022'], ['six-the-musical-aragon', 'six-tour-2022']]) {
    const c = classifyTourPage({ slug, shows: SHOWS });
    assert.deepEqual([c.class, c.companyOf, c.source], ['company', of, 'company-rule'], slug);
  }
  // A WordPress dedupe suffix is another page of the same show, not a company; so is "-tour".
  assert.equal(companyOfSlug('hamilton-1', SHOWS), null);
  assert.equal(companyOfSlug('hamilton-tour', SHOWS), null);
  // The base must be a TRACKED tour.
  assert.equal(companyOfSlug('wicked-elphaba', SHOWS), null);
});

test('overlapping engagements in different cities make an aggregator; a tour that runs in order does not', () => {
  // Holiday Shows: many productions listed on one page, several cities at once.
  const aggregator = [
    eng('Boston, MA', '2026-11-20', '2026-11-22'),
    eng('Denver, CO', '2026-11-20', '2026-11-22'),
    eng('Austin, TX', '2026-11-21', '2026-11-23'),
    eng('Miami, FL', '2026-11-22', '2026-11-24'),
    eng('Seattle, WA', '2026-11-30'),
  ];
  assert.equal(overlappingEngagements(aggregator), 4);
  const c = classifyTourPage({ slug: 'holiday-shows', pageTitle: 'Holiday Shows', rows: aggregator, shows: SHOWS });
  assert.deepEqual([c.class, c.source], ['aggregator', 'structure']);
  assert.match(c.reason, /one company cannot be in two cities/);
  assert.equal(overlappingEngagements(SEQUENTIAL), 0);
  assert.equal(classifyTourPage({ slug: 'some-new-show', pageTitle: 'Some New Show', rows: SEQUENTIAL, shows: SHOWS }).class, 'unclassified');
  // Back-to-back stops that share a changeover day are one company moving on.
  assert.equal(overlappingEngagements([eng('A, MA', '2026-10-01', '2026-10-06'), eng('B, CT', '2026-10-06', '2026-10-11'), eng('C, NY', '2026-10-11', '2026-10-16')]), 0);
  // Two overlaps are too few to call (a single double-booked date, a typo).
  assert.equal(classifyTourPage({ slug: 'some-new-show', rows: [eng('A, MA', '2026-10-01', '2026-10-06'), eng('B, CT', '2026-10-03', '2026-10-08'), eng('C, NY', '2026-10-20')], shows: SHOWS }).class, 'unclassified');
  // The same city twice at once is one house, not two cities.
  assert.equal(overlappingEngagements([eng('Boston, MA', '2026-10-01', '2026-10-06'), eng('Boston, MA', '2026-10-02', '2026-10-07')]), 0);
});

test('a title match is never an aggregator, whatever its table looks like (Hamilton runs several companies)', () => {
  const rows = [eng('Boston, MA', '2026-11-20', '2026-11-22'), eng('Denver, CO', '2026-11-20', '2026-11-22'), eng('Austin, TX', '2026-11-21', '2026-11-23'), eng('Miami, FL', '2026-11-22', '2026-11-24')];
  assert.equal(classifyTourPage({ slug: 'hamilton', pageTitle: 'Hamilton', rows, shows: SHOWS }).class, 'production');
});

test('event keywords deny; a production override is the way back in', () => {
  for (const [slug, title] of [
    ['cirque-musica-holiday-wonderland', 'Cirque Musica'], ['mannheim-steamroller-christmas', 'Mannheim Steamroller Christmas'],
    ['riverdance', 'Riverdance'], ['stomp', 'STOMP'], ['the-hip-hop-nutcracker', 'The Hip Hop Nutcracker'],
    ['rain-a-tribute-to-the-beatles', 'RAIN'], ['the-illusionists-1', 'The Illusionists'], ['disney-on-ice', 'Disney On Ice'], ['a-night-of-symphony', 'Symphony'],
  ]) {
    const c = classifyTourPage({ slug, pageTitle: title, shows: SHOWS });
    assert.deepEqual([c.class, c.source], ['event', 'keyword'], slug);
  }
  assert.equal(EVENT_RE.test('hamilton'), false);
  assert.equal(classifyTourPage({ slug: 'the-cat-in-the-hat', pageTitle: 'The Cat in the Hat', shows: SHOWS }).class, 'unclassified', 'no keyword, no tracked title, no infobox');
  // The title decides too, not only the slug.
  assert.equal(classifyTourPage({ slug: 'holiday-spectacular', pageTitle: 'Cirque Holiday Spectacular', shows: SHOWS }).class, 'event');
});

test('Wikipedia infobox: musical or play is a production with its type; concert, circus and dance are events', () => {
  const musical = classifyTourPage({ slug: 'the-bodyguard', pageTitle: 'The Bodyguard', shows: SHOWS, wikiText: '{{Infobox musical\n| name = The Bodyguard\n}}' });
  assert.deepEqual([musical.class, musical.type, musical.source, musical.title], ['production', 'musical', 'wikipedia', 'The Bodyguard']);
  assert.equal(classifyTourPage({ slug: 'a-play', pageTitle: 'A Play', shows: SHOWS, wikiText: '{{Infobox play |name=A Play}}' }).type, 'play');
  for (const box of ['{{Infobox concert tour\n|name=x}}', '{{Infobox circus\n|name=x}}', '{{Infobox dance\n|name=x}}']) {
    assert.equal(classifyTourPage({ slug: 'a-thing', pageTitle: 'A Thing', shows: SHOWS, wikiText: box }).class, 'event', box);
  }
  // A book, film or album infobox says nothing about the stage show.
  assert.equal(infoboxClass('{{Infobox book\n| name = The Cat in the Hat}}'), null);
  assert.equal(classifyTourPage({ slug: 'the-cat-in-the-hat', pageTitle: 'The Cat in the Hat', shows: SHOWS, wikiText: '{{Infobox book\n| name = x}}' }).class, 'unclassified');
});

test('unclassified is the answer when nothing decides, with the page title kept for the digest', () => {
  const c = classifyTourPage({ slug: 'hallmarkish', pageTitle: 'Hallmarkish', rows: SEQUENTIAL, shows: SHOWS });
  assert.deepEqual([c.class, c.source, c.title], ['unclassified', 'none', 'Hallmarkish']);
});

test('page titles come from the page, with entities decoded and the site suffix removed', () => {
  assert.equal(decodeTitle('Dolly Parton&#8217;s Smoky Mountain Christmas Carol'), 'Dolly Parton’s Smoky Mountain Christmas Carol');
  assert.equal(decodeTitle('&#8216;Twas the Night Before&#8230;'), '‘Twas the Night Before…');
  assert.equal(decodeTitle('Q &amp; A'), 'Q & A');
  assert.equal(pageTitleFromHtml('<html><head><title>Mystic Pizza &#8211; Tours To You</title></head>'), 'Mystic Pizza');
  assert.equal(pageTitleFromHtml('<title>Plain</title>'), 'Plain');
  assert.equal(pageTitleFromHtml('<p>no title</p>'), null);
});

test('overrides load from a file, skip documentation keys, and are validated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-'));
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify({
      _doc: 'ignored',
      'holiday-shows': { class: 'aggregator', reason: 'list', issue: 'BRO-4931', reviewedAt: '2026-10-09' },
    }));
    assert.deepEqual(Object.keys(loadTourPageClasses(file)), ['holiday-shows']);
    assert.deepEqual(loadTourPageClasses(path.join(dir, 'missing.json')), {});
    assert.deepEqual(overrideProblems(loadTourPageClasses(file)), []);
    const bad = overrideProblems({
      a: { class: 'banana', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' },
      b: { class: 'production', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' },
      c: { class: 'company', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' },
      d: { class: 'event', issue: 'nope', reviewedAt: 'today' },
    });
    assert.equal(bad.length, 6, bad.join(' | '));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the committed data/tour-page-classes.json is valid and every row says who reviewed what and why', () => {
  const overrides = loadTourPageClasses(OVERRIDES_PATH);
  assert.ok(Object.keys(overrides).length > 0, 'the seed file is present');
  assert.deepEqual(overrideProblems(overrides), []);
  // The owner's product answers (BRO-4931): these are never tracked.
  for (const slug of ['riverdance', 'stomp', 'the-hip-hop-nutcracker', 'mannheim-steamroller-christmas', 'the-simon-and-garfunkel-story']) {
    assert.equal(classifyTourPage({ slug, shows: SHOWS, overrides }).class, 'event', slug);
  }
  // Family and holiday stage shows and parodies are.
  for (const slug of ['the-cat-in-the-hat', 'hallmarkish', 'dolly-partons-smoky-mountain-christmas-carol']) {
    assert.equal(classifyTourPage({ slug, shows: SHOWS, overrides }).class, 'production', slug);
  }
});
