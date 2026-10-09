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
  classifyTourPage, loadTourPageClasses, overrideProblems, maxConcurrentCities, infoboxClass, similarTrackedShow, disambiguationConflict,
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
  // A UK production is never an automatic parent (BRO-4931): a London Woman in Black is not the North American tour.
  assert.equal(classifyTourPage({ slug: 'the-woman-in-black', pageTitle: 'The Woman in Black', shows: SHOWS }).class, 'unclassified');
  // A person can name it.
  const named = classifyTourPage({ slug: 'the-woman-in-black', pageTitle: 'The Woman in Black', shows: SHOWS, overrides: { 'the-woman-in-black': { class: 'production', parentId: 'the-woman-in-black-west-end-1989', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' } } });
  assert.deepEqual([named.class, named.parentId, named.source], ['production', 'the-woman-in-black-west-end-1989', 'override']);
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

test('five or more cities at once make an aggregator; a show with two or three companies on the road does not', () => {
  // Holiday Shows: many productions listed on one page, several cities at once.
  const aggregator = [
    eng('Boston, MA', '2026-11-20', '2026-11-22'),
    eng('Denver, CO', '2026-11-20', '2026-11-22'),
    eng('Austin, TX', '2026-11-21', '2026-11-23'),
    eng('Miami, FL', '2026-11-22', '2026-11-24'),
    eng('Seattle, WA', '2026-11-22'),
    eng('Reno, NV', '2026-12-30'),
  ];
  assert.equal(maxConcurrentCities(aggregator), 5);
  const c = classifyTourPage({ slug: 'holiday-shows', pageTitle: 'Holiday Shows', rows: aggregator, shows: SHOWS });
  assert.deepEqual([c.class, c.source], ['aggregator', 'structure']);
  assert.match(c.reason, /5 different cities have an engagement at the same moment/);
  // One company on the road: never two cities at once.
  assert.equal(maxConcurrentCities(SEQUENTIAL), 1);
  assert.equal(classifyTourPage({ slug: 'some-new-show', pageTitle: 'Some New Show', rows: SEQUENTIAL, shows: SHOWS }).class, 'unclassified');
  // Menopause The Musical, Rudolph, Potted Potter: a few companies of ONE show overlap in time and are not an aggregator
  // (the first rule, three overlapping engagements, wrongly called all of them lists of shows; measured 2026-10-09).
  const threeCompanies = [
    eng('Boston, MA', '2026-10-06', '2026-10-11'), eng('Denver, CO', '2026-10-06', '2026-10-11'), eng('Austin, TX', '2026-10-07', '2026-10-12'),
    eng('Hartford, CT', '2026-10-13', '2026-10-18'), eng('Reno, NV', '2026-10-13', '2026-10-18'), eng('Tulsa, OK', '2026-10-13', '2026-10-18'),
    eng('Albany, NY', '2026-10-20', '2026-10-25'), eng('Provo, UT', '2026-10-20', '2026-10-25'), eng('Selma, AL', '2026-10-21', '2026-10-26'),
  ];
  assert.equal(maxConcurrentCities(threeCompanies), 3);
  assert.equal(classifyTourPage({ slug: 'some-new-show', pageTitle: 'Some New Show', rows: threeCompanies, shows: SHOWS }).class, 'unclassified');
  // Back-to-back stops that share a changeover day are one company moving on; the next day is not concurrent.
  assert.equal(maxConcurrentCities([eng('A, MA', '2026-10-01', '2026-10-06'), eng('B, CT', '2026-10-07', '2026-10-11'), eng('C, NY', '2026-10-12', '2026-10-16')]), 1);
  assert.equal(maxConcurrentCities([eng('A, MA', '2026-10-01', '2026-10-06'), eng('B, CT', '2026-10-06', '2026-10-11')]), 2);
  // The same city twice at once is one house, not two cities.
  assert.equal(maxConcurrentCities([eng('Boston, MA', '2026-10-01', '2026-10-06'), eng('Boston, MA', '2026-10-02', '2026-10-07')]), 1);
  assert.equal(maxConcurrentCities([]), 0);
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

const TOURED = '\n\nA North American tour began in 2026.';

test('Wikipedia infobox: musical or play is a production with its type; concert, circus and dance are events', () => {
  const musical = classifyTourPage({ slug: 'the-bodyguard', pageTitle: 'The Bodyguard', shows: SHOWS, wikiText: `{{Infobox musical\n| name = The Bodyguard\n}}${TOURED}` });
  assert.deepEqual([musical.class, musical.type, musical.source, musical.title], ['production', 'musical', 'wikipedia', 'The Bodyguard']);
  assert.equal(classifyTourPage({ slug: 'a-play', pageTitle: 'A Play', shows: SHOWS, wikiText: `{{Infobox play |name=A Play}}${TOURED}` }).type, 'play');
  for (const box of ['{{Infobox concert tour\n|name=x}}', '{{Infobox circus\n|name=x}}', '{{Infobox dance\n|name=x}}']) {
    assert.equal(classifyTourPage({ slug: 'a-thing', pageTitle: 'A Thing', shows: SHOWS, wikiText: box + TOURED }).class, 'event', box);
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

test('P1-4: an infobox counts only if the article mentions a tour and its (musical)/(play) name fits the page', () => {
  const musicalBox = '{{Infobox musical\n| name = Clue\n}}\n\nThe musical played Off-Broadway in 1997.';
  // The clue fixture shape: the first article that exists is the 1997 musical, which never tours.
  const clue = classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows: SHOWS, wikiText: musicalBox, wikiTitle: 'Clue (musical)' });
  assert.equal(clue.class, 'unclassified');
  assert.match(clue.reason, /never mentions a tour/);
  // Mentioning a tour is not enough when the article name says musical and the page says play.
  const toured = `${musicalBox} A national tour followed.`;
  const conflict = classifyTourPage({ slug: 'clue-the-play', pageTitle: 'Clue: The Play', shows: SHOWS, wikiText: toured, wikiTitle: 'Clue (musical)' });
  assert.equal(conflict.class, 'unclassified');
  assert.match(conflict.reason, /does not fit the page/);
  // Fine: tours, and the qualifier agrees (or there is none).
  assert.equal(classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows: SHOWS, wikiText: toured, wikiTitle: 'Clue (musical)' }).class, 'production');
  assert.equal(classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows: SHOWS, wikiText: toured, wikiTitle: 'Clue' }).class, 'production');
  assert.equal(disambiguationConflict('Clue (play)', 'clue-the-musical', 'Clue the Musical') !== null, true);
  assert.equal(disambiguationConflict('Clue', 'clue-the-musical', 'Clue the Musical'), null);
  // A tour mentioned only in a citation title is not touring.
  assert.equal(classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows: SHOWS, wikiText: `${musicalBox}<ref>{{cite web|title=Clue tour announced}}</ref>`, wikiTitle: 'Clue (musical)' }).class, 'unclassified');
});

test('P1-3: a page whose title prefixes (or is prefixed by) a tracked show is never a duplicate standalone', () => {
  // The two real cases: Tina vs "Tina: The Tina Turner Musical", SpongeBob SquarePants vs "The SpongeBob Musical".
  const shows = [
    { id: 'tina-2019', title: 'Tina', category: 'broadway', openingDate: '2019-11-07' },
    { id: 'spongebob-squarepants-2017', title: 'SpongeBob SquarePants', category: 'broadway', openingDate: '2017-12-04' },
  ];
  const wiki = '{{Infobox musical\n| name = x\n}}\n\nA North American tour ran in 2026.';
  const tina = classifyTourPage({ slug: 'tina-the-tina-turner-musical', pageTitle: 'Tina: The Tina Turner Musical', shows, wikiText: wiki });
  assert.equal(tina.class, 'unclassified');
  assert.match(tina.reason, /resembles tracked show tina-2019/);
  const sponge = classifyTourPage({ slug: 'the-spongebob-musical', pageTitle: 'The SpongeBob Musical', shows, wikiText: wiki });
  assert.equal(sponge.class, 'unclassified');
  assert.match(sponge.reason, /resembles tracked show spongebob-squarepants-2017/);
  // Unrelated titles, and prefixes under 4 characters, still classify.
  assert.equal(classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows, wikiText: wiki }).class, 'production');
  const six = [{ id: 'six-degrees-1990', title: 'Six Degrees of Separation', category: 'broadway', openingDate: '1990-11-08' }];
  assert.equal(similarTrackedShow(six, 'six-the-musical-x', 'Six X'), null, '"six" is under 4 characters');
  assert.equal(similarTrackedShow(shows, 'tinag', 'Tinag'), null, 'whole words only');
  // A UK-only show of the same title also stops it (the-choir-of-man vs a London production).
  const uk = [{ id: 'the-choir-of-man-off-west-end-2026', title: 'The Choir of Man', category: 'off-west-end', openingDate: '2026-01-01' }];
  assert.equal(classifyTourPage({ slug: 'the-choir-of-man', pageTitle: 'The Choir of Man', shows: uk, wikiText: wiki }).class, 'unclassified');
  // An override is a person's answer and wins.
  const overrides = { 'tina-the-tina-turner-musical': { class: 'production', title: 'Tina: The Tina Turner Musical', type: 'musical', reason: 'x', issue: 'BRO-1', reviewedAt: '2026-10-09' } };
  assert.equal(classifyTourPage({ slug: 'tina-the-tina-turner-musical', pageTitle: 'Tina: The Tina Turner Musical', shows, wikiText: wiki, overrides }).class, 'production');
});

test('P2: event words are checked on the slug before a title match, as whole words', () => {
  const shows = [{ id: 'jesus-christ-superstar-2012', title: 'Jesus Christ Superstar', category: 'broadway', openingDate: '2012-03-22' }];
  const concert = classifyTourPage({ slug: 'jesus-christ-superstar-in-concert', pageTitle: 'Jesus Christ Superstar in Concert', shows });
  assert.deepEqual([concert.class, concert.source], ['event', 'keyword']);
  assert.equal(classifyTourPage({ slug: 'jesus-christ-superstar', pageTitle: 'Jesus Christ Superstar', shows }).parentId, 'jesus-christ-superstar-2012');
  for (const slug of ['contributed-musical', 'concerto-for-two', 'tributary', 'stompers', 'circuses-of-the-world']) assert.equal(EVENT_RE.test(slug), false, slug);
  for (const slug of ['rain-a-tribute-to-the-beatles', 'the-illusionists-1', 'disney-on-ice', 'the-hip-hop-nutcracker', 'stomp']) assert.equal(EVENT_RE.test(slug), true, slug);
});

test('P1-4: a hatnote naming a touring play is not a mention of a tour (the real Clue article)', () => {
  const { bodyProse } = require('../../scripts/lib/tour-page-class.js');
  const clue = "{{Short description|1997 musical}}\n{{About||the national touring play based on the 1985 film|Clue: On Stage}}\n{{Infobox Musical\n| name= Clue The Musical\n| tours = none\n}}\n'''Clue the Musical''' ran Off-Broadway in 1997.";
  assert.doesNotMatch(bodyProse(clue), /tour/i);
  assert.equal(classifyTourPage({ slug: 'clue', pageTitle: 'Clue', shows: SHOWS, wikiText: clue, wikiTitle: 'Clue (musical)' }).class, 'unclassified');
  assert.match(bodyProse("A national tour began in {{lang|en|Denver}} in 2026.<ref>x tour y</ref>"), /national tour began/);
});
