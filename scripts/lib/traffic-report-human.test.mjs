import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildHumanSummary, pageName, sourceName, isSearch, isOwnTooling, mergeSeries, utmName } = require('./traffic-report-human.js');
const { allWeeks } = require('../analyze-traffic-sources.js');

test('pageName turns paths into names a person would say, using shows.json titles when present', () => {
  const shows = new Map([['electra-persona-west-end', { slug: 'electra-persona-west-end', title: 'Electra / Persona', market: 'west-end' }]]);
  assert.equal(pageName('/', shows), 'the homepage');
  assert.equal(pageName('/west-end', shows), 'the West End page');
  assert.equal(pageName('/show/electra-persona-west-end', shows), 'Electra / Persona (West End) page');
  assert.equal(pageName('/show/trainspotting-the-musical-west-end', shows), 'Trainspotting the Musical (West End) page'); // slug fallback
  assert.equal(pageName('/show/the-dead-1904', shows), 'The Dead page'); // year stripped
  assert.equal(pageName('/show/after-all-these-years-off-broadway'), 'After All These Years (Off-Broadway) page');
  assert.equal(pageName('/guides/best-broadway-musicals'), 'the "Best Broadway Musicals" guide');
  assert.equal(pageName('/browse/broadway-age-guide'), 'the "Broadway Age Guide" list');
  assert.equal(pageName('/compare/hadestown-vs-moulin-rouge'), 'the Hadestown vs Moulin Rouge comparison');
  assert.equal(pageName('/cast/cole-escola'), "Cole Escola's cast page");
});

test('sourceName merges variants into one human name and classifies search / own tooling', () => {
  assert.equal(sourceName('www.reddit.com'), 'Reddit');
  assert.equal(sourceName('com.reddit.frontpage'), 'Reddit');
  assert.equal(sourceName('l.facebook.com'), 'Facebook');
  assert.equal(sourceName('chatgpt.com'), 'ChatGPT');
  assert.equal(sourceName('$direct'), 'Direct');
  assert.equal(sourceName('awardsworthy.org'), 'awardsworthy.org');
  assert.equal(sourceName('www.google.com'), 'Google');
  assert.ok(isSearch('search.lilo.org') && isSearch('oceanhero.today') && isSearch('www.google.co.uk') && !isSearch('awardsworthy.org'));
  assert.ok(isOwnTooling('resend.com') && isOwnTooling('broadwayscorecard.com') && !isOwnTooling('protopage.com'));
  assert.equal(utmName('newsletter / email'), 'Newsletter');
  assert.equal(utmName('chatgpt.com / '), 'ChatGPT');
  const merged = mergeSeries({ 'www.reddit.com': { w1: 10 }, 'com.reddit.frontpage': { w1: 5, w2: 1 } }, sourceName);
  assert.deepEqual(merged, { Reddit: { w1: 15, w2: 1 } });
});

test('buildHumanSummary writes the owner-facing sections in plain language from real-shaped rows', () => {
  const weeks = allWeeks('2026-06-15', '2026-09-15');
  const currentWeek = '2026-09-14';
  const full = weeks.filter((w) => w !== currentWeek);
  const rows = (key, f, extra = {}) => full.map((w, i) => ({ date: w, key, sessions: f(i, w), users: Math.round(f(i, w) * 0.8), ...extra })).filter((r) => r.sessions);
  const ph = {
    channelType: [...rows('Organic Search', () => 2000), ...rows('Direct', () => 900), ...rows('Organic Social', (i) => (i < 9 ? 70 : 30)), ...rows('Email', (i) => (i === 12 ? 20 : 45))],
    referringDomain: [
      ...rows('www.google.com', () => 1500),
      ...rows('www.reddit.com', (i) => (i === 5 ? 300 : i < 9 ? 45 : 20)),
      ...rows('com.reddit.frontpage', (i) => (i === 5 ? 25 : 5)),
      ...rows('awardsworthy.org', (i) => (i >= 11 ? 7 : 0)),
      ...rows('search.lilo.org', (i) => (i >= 11 ? 6 : 0)),
      ...rows('resend.com', (i) => (i >= 11 ? 6 : 0)),
    ],
    landing: [
      ...rows('/', () => 500),
      ...rows('/show/trainspotting-the-musical-west-end', (i) => (i === 5 ? 610 : 2)),
      ...rows('/show/electra-persona-west-end', (i) => (i >= 9 ? 72 : 18)),
      ...rows('/show/wicked', (i) => (i < 9 ? 70 : 2)),
    ],
    referralLanding: [
      ...rows('www.reddit.com → /show/trainspotting-the-musical-west-end', (i) => (i === 5 ? 287 : 0)),
      ...rows('www.reddit.com → /', () => 15),
      ...rows('awardsworthy.org → /show/electra-persona-west-end', (i) => (i >= 11 ? 7 : 0)),
      ...rows('search.lilo.org → /lotteries', (i) => (i >= 11 ? 6 : 0)),
      ...rows('resend.com → /box-office', (i) => (i >= 11 ? 6 : 0)),
    ],
    country: [...rows('United States', () => 2500), ...rows('Hong Kong', (i) => (i >= 9 ? 300 : 0)).map((r) => ({ ...r, users: r.sessions }))],
    utmSource: [...rows('newsletter / email', () => 40)],
    errors: {},
  };
  const ga = { channel: [{ date: '20260914', key: 'Unassigned', sessions: 272, engagedSessions: 1 }, { date: '20260915', key: 'Unassigned', sessions: 111, engagedSessions: 0 }], errors: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trh-'));
  const showsPath = path.join(dir, 'shows.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: [
    { slug: 'electra-persona-west-end', title: 'Electra / Persona', market: 'west-end', status: 'open', openingDate: '2026-09-01' },
    { slug: 'wicked', title: 'Wicked', market: 'broadway', status: 'open' },
    { slug: 'annie-off-broadway', title: 'Annie', market: 'broadway', category: 'off-broadway', status: 'open' },
  ] }));
  assert.equal(pageName('/show/annie-off-broadway', require('./traffic-report-human.js').loadShows(showsPath)), 'Annie (Off-Broadway) page'); // category beats market

  const md = buildHumanSummary({ ph, ga, weeks, currentWeek, showsPath });
  assert.match(md, /^# Your traffic, week of Sep 7/m);
  assert.match(md, /\*\*In short\.\*\* Last week 2,950 people visited \(real visitors, bots excluded\), about the same as a typical week/);
  assert.match(md, /## What's working[\s\S]*\*\*Electra \/ Persona \(West End\) page\*\*: about 72 visits a week, up from 18 \(\+300%\)\.[^\n]*14 from awardsworthy\.org[^\n]*opened Sep 1/);
  assert.match(md, /Biggest single weeks[\s\S]*Week of Jul 20: \*\*Trainspotting the Musical \(West End\) page\*\* got 610 visits \(usually 2\)\. 287 of them came from Reddit\./);
  assert.match(md, /## What's fading[\s\S]*\*\*Reddit\*\* is sending less: 25 visits a week, down from 50 \(-50%\)/);
  assert.match(md, /## Keep an eye on[\s\S]*\*\*Wicked \(Broadway\) page\*\* went from 70 visits a week to 2 while the show is still open\. That is a collapse/);
  assert.match(md, /## New sites sending you visitors[\s\S]*\*\*awardsworthy\.org\*\*: 14 visits since Aug 31, all to Electra \/ Persona \(West End\) page/);
  assert.ok(!/lilo|resend\.com/.test(md.split('## Reddit and social')[0])); // search engine + own tooling never listed as new sites
  assert.match(md, /## Reddit and social[\s\S]*\*\*Reddit\*\*: 100 visits in the last 4 weeks \(a typical week is 25, it was 50 a month earlier\), mostly to the homepage \(60\)\. Your best Reddit week was Jul 20: 325 visits, 287 of them to Trainspotting the Musical \(West End\) page\. That is what one good post does/);
  assert.match(md, /Traffic from \*\*Hong Kong\*\* looks automated: 1,200 visits/);
  assert.match(md, /Google Analytics logged 383 untagged visits/);
  assert.match(md, /Email brought 20 visits last week, 56% below/);
  assert.match(md, /\| Search \(Google, Bing, etc\.\) \| 2,000 \| 2,000 \| 0% \|/);
  assert.ok(!/Week of Aug 17: \*\*Electra/.test(md), 'a rising page is not also listed as a one-off big week');
  assert.ok(!/\/show\//.test(md), 'no raw URL slugs anywhere in the summary');
});
