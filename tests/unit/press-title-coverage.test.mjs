// BRO-7778: every show opening in the next 90 days must have its short title (the part before a subtitle) matched by
// the lane and the old poller, or at least raise the near-miss alert. Generated from data/shows.json, plus fixed cases
// that run without core data. Red with the matcher fix reverted: "Review: It's a Wonderful Life" matched nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { shortTitleCoverage, subtitleLead } = require(path.join(ROOT, 'scripts/lib/press-title-coverage.js'));
const { setPressNameShows } = require(path.join(ROOT, 'scripts/lib/show-names.js'));
const { titleMatchesShow } = require(path.join(ROOT, 'scripts/lib/rss-discovery.js'));

const FIXTURE = [
  { id: 'iawl', title: 'It’s A Wonderful Life: A Live Radio Play', akaTitles: ["It's a Wonderful Life"] },
  { id: 'eno', title: 'Adriana Mater - English National Opera', akaTitles: ['Adriana Mater'] },
  { id: 'bailey', title: 'Bill Bailey: Vaudevillean' },
  { id: 'st', title: 'Stranger Things: The First Shadow' },
  { id: 'dolly', title: 'Dolly: A True Original Musical' },
  { id: 'hello-dolly', title: 'Hello, Dolly!' },
  { id: 'diana', title: 'Diana: The Untold and Untrue Story' },
  { id: 'diana-musical', title: 'Diana, The Musical' },
  { id: 'aoc', title: 'August: Osage County' },
  { id: 'carol', title: 'Charles Dickens’ “A Christmas Carol”' },
];

test('fixed cases: subtitle shows are matched or near-missed', () => {
  setPressNameShows(FIXTURE);
  try {
    const cov = Object.fromEntries(FIXTURE.map((s) => [s.id, shortTitleCoverage(s, FIXTURE)]));
    const status = Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, v.status]));
    assert.equal(status.iawl, 'matched');
    assert.equal(status.eno, 'matched');
    assert.equal(status.dolly, 'near-miss'); // shared with Hello, Dolly!: alert only
    assert.equal(status.diana, 'near-miss');
    assert.equal(status.aoc, 'near-miss'); // "August" alone is never a title
    assert.equal(status['hello-dolly'], 'no-subtitle');
    // a colon main with no akaTitles is only near-missed, and the readiness check asks for an aka
    assert.equal(status.bailey, 'near-miss');
    assert.equal(cov.bailey.akaPossible, true);
    assert.equal(cov.dolly.akaPossible, false); // one word
    assert.equal(subtitleLead(FIXTURE.find((x) => x.id === 'carol').title), null); // author credit, not a short title
  } finally { setPressNameShows(null); }
});

test('acceptance: tonight\u2019s headline matches on the lane and the poller paths through its akaTitles', () => {
  setPressNameShows(FIXTURE);
  try {
    const titles = FIXTURE.map((s) => s.title);
    const t = FIXTURE[0].title;
    // akaTitles come from the loaded show list (registry), as in production where callers pass only show.title
    assert.ok(titleMatchesShow("Review: It's a Wonderful Life", t, { fuzzy: true, mainTitle: true, allShowTitles: titles }));
    assert.ok(titleMatchesShow("Review: It's a Wonderful Life", t, { mainTitle: true, allShowTitles: titles }));
    // ship-check: a colon main title alone admits nothing (TV, film, a comedian's other tour)
    assert.ok(!titleMatchesShow('Stranger Things season 5 review', 'Stranger Things: The First Shadow', { mainTitle: true, allShowTitles: titles }));
    assert.ok(!titleMatchesShow('Bill Bailey review: Thoughtifier tour', 'Bill Bailey: Vaudevillean', { mainTitle: true, allShowTitles: titles }));
  } finally { setPressNameShows(null); }
});

const SHOWS_PATH = path.join(ROOT, 'data/shows.json');
const shows = fs.existsSync(SHOWS_PATH) ? (JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || []) : null;

test('every show opening in the next 90 days: short title matched or near-missed', { skip: !shows && 'no data/shows.json' }, () => {
  setPressNameShows(null);
  const now = Date.now();
  const upcoming = shows.filter((s) => s.title && s.openingDate
    && Date.parse(s.openingDate) >= now - 86400000 && Date.parse(s.openingDate) <= now + 90 * 86400000);
  const gaps = [];
  let checked = 0;
  for (const s of upcoming) {
    const c = shortTitleCoverage(s, shows);
    if (c.status === 'no-subtitle') continue;
    checked++;
    if (c.status === 'gap') gaps.push(`${s.id} ("${c.lead}"): ${c.missed.slice(0, 2).join('; ')}`);
  }
  assert.deepEqual(gaps, [], `short titles nothing catches:\n${gaps.join('\n')}`);
  console.log(`# ${checked} subtitle shows of ${upcoming.length} opening in 90 days: none uncaught`);
});

test('a press-title match pointing at another production or the film is rejected, the near-miss alert still fires', () => {
  const cast = [{ name: 'Lisa Rinna' }, { name: 'Andrew Rannells' }, { name: 'Tituss Burgess' }, { name: 'Megan Hilty' }];
  const creativeTeam = [{ name: 'Joe Landry', role: 'Playwright' }];
  setPressNameShows([{ ...FIXTURE[0], venue: 'Broadhurst Theatre', cast, creativeTeam }, ...FIXTURE.slice(1)]);
  try {
    const { nearMissSignals } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/near-miss.js'));
    const { headlineNamesShow } = require(path.join(ROOT, 'scripts/lib/google-news-rss.js'));
    const show = { ...FIXTURE[0], venue: 'Broadhurst Theatre' };
    const opts = { fuzzy: true, mainTitle: true, allShowTitles: FIXTURE.map((s) => s.title) };
    // Real Google News headlines for the title, 2026-11-18 (other stagings and the film).
    const other = [
      "Review: Rosebud's It's A Wonderful Life a perfect holiday show bursting with nostalgia",
      "Review: 'It's A Wonderful Life' is a Wonderful Time at Hope Repertory",
      'It’s a Wonderful Life movie review',
      '‘It’s a Wonderful Life’ (1946) Review (Published 2018)',
      'REVIEW | It’s A Wonderful Life, Reading Rep Theatre',
      'Review: Lovely "It’s a Wonderful Life" by American Blues Theater',
      'It’s A Wonderful Life: The Musical at Toby’s Dinner Theatre (review)',
      "Review: Studio Tenn's Emotional and Heartfelt IT'S A WONDERFUL LIFE Brings Magic to the Holiday Season",
    ];
    for (const h of other) {
      assert.ok(!titleMatchesShow(h, show.title, opts), `lane admitted: ${h}`);
      assert.ok(!headlineNamesShow(h, show), `google news admitted: ${h}`);
    }
    assert.ok(nearMissSignals({ title: other[0], url: 'https://calgaryherald.com/x' }, show).length > 0);
    // ship-check: a cast member's possessive is the show's own, not another company's
    for (const h of ["Review: It's a Wonderful Life", "Review: 'It's a Wonderful Life' at the Broadhurst", "Broadway's It's a Wonderful Life is a warm radio play",
      "Lisa Rinna's Broadway debut in 'It's a Wonderful Life', reviewed", "Review: Andrew Rannells' It's a Wonderful Life rings true",
      "Review: It's a Wonderful Life at the Broadhurst Theatre",
      // ship-check reviewer: real Broadway headline shapes that must not read as another production
      "Megan Hilty's It's a Wonderful Life review", "Review: Joe Landry's It's a Wonderful Life lands on Broadway",
      "Review: It's a Wonderful Life Is Wonderful At Every Turn", "Review: It's a Wonderful Life Rings True At The Holidays",
      "Review: 'It's a Wonderful Life' brings the beloved film to Broadway", "Review: 'It's a Wonderful Life' is no Capra, and Broadway is better for it",
      "Review: 'It's a Wonderful Life' - Feldman shines", "It's a Wonderful Life (radio play) review",
      "Review: It's a Wonderful Life, a radio play staged with care"]) {
      assert.ok(titleMatchesShow(h, show.title, opts), `lane missed: ${h}`);
      assert.ok(headlineNamesShow(h, show), `google news missed: ${h}`);
    }
  } finally { setPressNameShows(null); }
});
