/**
 * Regression guard for the Cheryl Markoski/Markosky class of defect (BRO-4156).
 *
 * INCIDENT: how-the-other-half-loves-west-end-2026 had TWO london-theatre
 * review files for the same critic's same review —
 * london-theatre--cheryl-markoski.json (misspelled; the outlet's own byline
 * reads "Cheryl Markosky") and london-theatre--cheryl-markosky.json (correct
 * spelling, sourced from Theatre Record) — silently double-counting that
 * one critic's verdict in the show's composite score. Fixed by merging into
 * a single london-theatre--cheryl-markosky.json.
 *
 * PART 1 (static, always runs): a synthetic-fixture unit test proving
 * findSpellingDuplicates() actually catches this shape of defect (same show
 * + same outlet, near-duplicate criticName spelling) without needing the
 * corpus checked out.
 *
 * PART 2 (dynamic, skips if data/review-texts isn't checked out — see
 * aggregator-domain-tld-parity.test.mjs for the same pattern and why): scans
 * the REAL corpus and asserts no same-show/same-outlet near-duplicate pair
 * exists OUTSIDE the pinned KNOWN_BACKLOG below. KNOWN_BACKLOG is the
 * pre-existing sweep result (82 pairs, measured 2026-09-25 while working
 * BRO-4156) — a corpus-wide backlog tracked separately, NOT yet cleaned up
 * (each pair needs per-file verification before merging, same as the
 * Markoski/Markosky case did). This guard's job is to stop the count from
 * growing, and to prove the Markoski/Markosky pair specifically is gone.
 *
 * Run: node --test scripts/lib/critic-spelling-duplicates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  isNearDuplicateCriticName,
  findSpellingDuplicates,
  scanReviewTextsForCriticDuplicates,
} = require('./critic-spelling-duplicates.js');

// --------------------------------------------------------- Part 1: unit tests

test('isNearDuplicateCriticName catches the Markoski/Markosky shape', () => {
  assert.equal(isNearDuplicateCriticName('Cheryl Markoski', 'Cheryl Markosky'), true);
});

test('isNearDuplicateCriticName rejects identical names', () => {
  assert.equal(isNearDuplicateCriticName('Cheryl Markosky', 'Cheryl Markosky'), false);
});

test('isNearDuplicateCriticName rejects different critics who share a surname', () => {
  assert.equal(isNearDuplicateCriticName('Markos Papadatos', 'Cheryl Markosky'), false);
  assert.equal(isNearDuplicateCriticName('Sara Holdren', 'Sara Holdren-Jones'), false);
});

test('isNearDuplicateCriticName rejects short names below the edit-distance floor', () => {
  assert.equal(isNearDuplicateCriticName('Al Ng', 'Ed Ng'), false);
});

test('findSpellingDuplicates flags a same-show/same-outlet pair but not a cross-show or cross-outlet one', () => {
  const records = [
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markoski', file: 'london-theatre--cheryl-markoski.json' },
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markosky', file: 'london-theatre--cheryl-markosky.json' },
    // Same near-duplicate spelling, but a DIFFERENT show — not a duplicate file, must not be flagged.
    { showId: 'some-other-show-west-end-2026', outletId: 'london-theatre', criticName: 'Cheryl Markosky', file: 'london-theatre--cheryl-markosky.json' },
    // Same near-duplicate spelling, same show, but a DIFFERENT outlet — must not be flagged.
    { showId: 'how-the-other-half-loves-west-end-2026', outletId: 'standard', criticName: 'Cheryl Markoski', file: 'standard--cheryl-markoski.json' },
  ];
  const findings = findSpellingDuplicates(records);
  assert.deepEqual(
    findings.map((f) => [f.showId, f.outletId, f.nameA, f.nameB]),
    [['how-the-other-half-loves-west-end-2026', 'london-theatre', 'Cheryl Markoski', 'Cheryl Markosky']],
  );
});

test('findSpellingDuplicates honors the allow list', () => {
  const records = [
    { showId: 'show-a', outletId: 'ew', criticName: 'Dave Quinn', file: 'ew--dave-quinn.json' },
    { showId: 'show-a', outletId: 'ew', criticName: 'David Quinn', file: 'ew--david-quinn.json' },
  ];
  assert.equal(findSpellingDuplicates(records).length, 1);
  const allow = new Set(['show-a::ew::Dave Quinn::David Quinn']);
  assert.equal(findSpellingDuplicates(records, { allow }).length, 0);
});

// ------------------------------------------------------- Part 2: live corpus scan

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.join(__dirname, '..', '..');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(REPO_ROOT, 'data', 'review-texts');
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

// Pre-existing corpus-wide backlog (82 pairs), measured 2026-09-25 while
// working BRO-4156. Each pair needs per-file verification (same URL/fullText
// fingerprint? genuinely the same critic?) before a safe merge — tracked as
// its own follow-up card, not fixed inline here. Do NOT add a new pair to
// this list to make a fresh failure pass; either fix it (like Markoski/
// Markosky) or file it as a new backlog item with its own justification.
const KNOWN_BACKLOG = [
  ['1536-west-end-2026', 'timeout-london', 'Andrjez Lukowski', 'Andrzej Lukowski'],
  ['1984-2017', 'ew', 'Isabella Biedenahrn', 'Isabella Biedenharn'],
  ['a-beautiful-noise-the-neil-diamond-musical-2022', 'nytimes', 'Elisabeth Vincentelli', 'Elizabeth Vincentelli'],
  ['a-strange-loop-2022', 'ew', 'Dave Quinn', 'David Quinn'],
  ['aint-too-proud-2019', 'ew', 'Leah Greenblat', 'Leah Greenblatt'],
  ['allegiance-2015', 'san-diego-union-tribune', 'James Hebert', 'James Herbert'],
  ['anastasia-2017', 'nbcny', 'Dave Quinn', 'David Quinn'],
  ['beautiful-little-fool-west-end-2026', 'broadwayworld', 'Aliya Al-Hassan', 'Aliya Al-Hussain'],
  ['betrayal-2019', 'ew', 'Alison Adato', 'Allison Adato'],
  ['casa-valentina-2014', 'ew', 'Adam Markovitz', 'Adam Markowitz'],
  ['city-of-angels-1989', 'daily-mail', 'Quentin Letts', 'Quentln Letts'],
  ['come-fly-away-2010', 'hollywood-reporter', 'Franck Scheck', 'Frank Scheck'],
  ['constellations-2015', 'nbcny', 'Robert Kahn', 'Roberth Kahn'],
  ['dear-england-new-wimbledon-theatre-west-end-2026', 'independent', 'Jessie Thompson', 'Jessie Thomspon'],
  ['dear-evan-hansen-2016', 'dailybeast', 'Tim Teeman', 'Tom Teeman'],
  ['equus-west-end-2026', 'broadwayworld', 'Aliya Al-Hassan', 'Aliyah Al-Hassan'],
  ['evening-all-afternoon-west-end-2026', 'standard', 'Nick Curits', 'Nick Curtis'],
  ['falsettos-2016', 'amny', 'Matt Windham', 'Matt Windman'],
  ['first-date-2013', 'ew', 'Thom Geier', 'Tom Geier'],
  ['grace-pervades-west-end-2026', 'broadwayworld', 'Aliya Al-Hassan', 'Aliya Al-Hussain'],
  ['groundhog-day-2017', 'ew', 'Chris Nashawaty', 'Chris Nashawty'],
  ['hamilton-west-end-2021', 'timeout-london', 'Andrzej Lukowski', 'Andrzej Lukowsksi'],
  ['hands-on-a-hardbody-2013', 'ew', 'Clark Collins', 'Clark Collis'],
  ['harry-potter-2021', 'telegraph', 'Diana Snyder', 'Diane Snyder'],
  ['heisenberg-2016', 'amny', 'Matt Windham', 'Matt Windman'],
  ['heisenberg-2016', 'wnyc', 'Jennifer Vanasco', 'Jennifer Vavasco'],
  ['hells-kitchen-2024', 'nytimes', 'Elisabeth Vincentelli', 'Elizabeth Vincentelli'],
  ['hercules-west-end-2025', 'timeout-london', 'Andrzej Lukowksi', 'Andrzej Lukowski'],
  ['high-noon-west-end-2025', 'independent', 'Alice Saville', 'Alive Saville'],
  ['high-noon-west-end-2025', 'timeout-london', 'Andrjez Lukowski', 'Andrzej Lukowski'],
  ['in-transit-2016', 'thewrap', 'Robert Hoffler', 'Robert Hofler'],
  ['left-on-tenth-2024', 'nysr', 'Frank Scheck', 'Frank Sheck'],
  ['leopoldstadt-2022', 'variety', 'Marilyn Stasio', 'Marylin Stasio'],
  ['les-liaisons-dangereuses-2016', 'chicagotribune', 'Chris Jone', 'Chris Jones'],
  ['love-letters-2014', 'ew', 'Thom Geier', 'Thom Geir'],
  ['m-butterfly-2017', 'vulture', 'Sara Holdren', 'Sarah Holdren'],
  ['magicbird-2012', 'timeout', 'David Cote', 'Davide Cote'],
  ['mamma-mia-2025', 'nytimes', 'Elisabeth Vincentelli', 'Elizabeth Vincentelli'],
  ['mike-birbiglia-the-old-man-and-the-pool-2022', 'nytimes', 'Elisabeth Vincentelli', 'Elizabeth Vincentelli'],
  ['misery-2015', 'huffpost', 'Michael Giltz', 'Michael Glitz'],
  ['mj-2022', 'hollywood-reporter', 'Love Gyarkye', 'Lovia Gyarkye'],
  ['mj-2022', 'hollywood-reporter', 'Lovia Gayarkye', 'Lovia Gyarkye'],
  ['moulin-rouge-2019', 'vulture', 'Sara Holdren', 'Sarah Holdren'],
  ['oedipus-2025', 'cititour', 'Brian Scott Lipon', 'Brian Scott Lipton'],
  ['on-the-twentieth-century-2015', 'thewrap', 'Robert Hofler', 'Robert Holfer'],
  ['once-on-this-island-2017', 'newsday', 'Barbara Schuler', 'Barbra Schuler'],
  ['other-desert-cities-2011', 'usatoday', 'Elysa Garder', 'Elysa Gardner'],
  ['paddington-the-musical-west-end-2025', 'musical-theatre-review', 'Lisa Martland', 'Lisa Martland<br>'],
  ['present-laughter-2017', 'guardian', 'Alex Soloski', 'Alexis Soloski'],
  ['purpose-2025', 'hollywood-reporter', 'Lovia Gayarkye', 'Lovia Gyarkye'],
  ['real-women-have-curves-2025', 'new-york-sun', 'Elysa Gardner', 'Elyssa Garner'],
  ['red-2010', 'hollywood-reporter', 'Franck Scheck', 'Frank Scheck'],
  ['redwood-2025', 'lighting-and-sound-america', 'Davd Barbour', 'David Barbour'],
  ['saint-joan-2018', 'hollywood-reporter', 'Frank Scheck', 'Frank Sheck'],
  ['school-of-rock-the-musical-2015', 'guardian', 'Alexis Soloski', 'Alexsis Soloski'],
  ['sea-wall-a-life-2019', 'ew', 'Kerenssa Cadenas', 'Kerensa Cardenas'],
  ['shadowlands-west-end-2026', 'broadwayworld', 'Aliya Al-Hassan', 'Aliya Al-Hussan'],
  ['smash-2025', 'cititour', 'Brian Scot Lipton', 'Brian Scott Lipton'],
  ['soul-doctor-2013', 'staten-island-advance', 'Micael J. Fressola', 'Michael J. Fressola'],
  ['spamalot-off-broadway-2026', 'the-moderate-voice', 'Doug Bursch', 'Dough Bursch'],
  ['spongebob-squarepants-2017', 'guardian', 'Alex Soloski', 'Alexis Soloski'],
  ['sweat-2017', 'nydailynews', 'Jeo Dziemianowicz', 'Joe Dziemianowicz'],
  ['sylvia-2015', 'huffpost', 'Rob Taub', 'Ron Taub'],
  ['the-collaboration-2022', 'variety', 'Marilyn Stasio', 'Marylin Stasio'],
  ['the-comedy-about-spies-west-end-2026', 'london-theatre', 'Aliya Al-Hassan', 'Aliya Al-Hussan'],
  ['the-cottage-2023', 'theatermania', 'Pete Hempstead', 'Peter Hempstead'],
  ['the-country-house-2014', 'nbcny', 'Dave Quinn', 'David Quinn'],
  ['the-heidi-chronicles-2015', 'njcom', 'Ronni Reich', 'Ronnie Reich'],
  ['the-kite-runner-2022', 'variety', 'Marilyn Stasio', 'Marylin Stasio'],
  ['the-lifespan-of-a-fact-2018', 'thewrap', 'Robert Hoffler', 'Robert Hofler'],
  ['the-lifespan-of-a-fact-2018', 'vulture', 'Sara Holden', 'Sara Holdren'],
  ['the-lifespan-of-a-fact-2018', 'vulture', 'Sara Holden', 'Sarah Holdren'],
  ['the-lifespan-of-a-fact-2018', 'vulture', 'Sara Holdren', 'Sarah Holdren'],
  ['the-oresteia-west-end-2026', 'everything-theatre', 'Raffaella Sero', 'Raffaello Sero'],
  ['the-parisian-woman-2017', 'vulture', 'Sara Holdren', 'Sarah Holdren'],
  ['the-play-that-goes-wrong-west-end-2021', 'timeout-london', 'Anya Ryan', 'Anna Ryan'],
  ['the-realistic-joneses-2014', 'vulture', 'Jesse Green', 'Jessie Green'],
  ['the-terms-of-my-surrender-2017', 'latimes', 'Chales McNulty', 'Charles McNulty'],
  ['the-terms-of-my-surrender-2017', 'thestage', 'Mark Shenton', 'Mark Sheton'],
  ['the-thanksgiving-play-2023', 'theatermania', 'Haley Levitt', 'Hayley Levitt'],
  ['thoughts-of-a-colored-man-2021', 'broadwaynews', 'Charles Isherwood', 'Charles Ishwerwood'],
  ['thoughts-of-a-colored-man-2021', 'hollywood-reporter', 'Lovia Gayarkye', 'Lovia Gyarkye'],
];

function buildAllowSet() {
  const allow = new Set();
  for (const [showId, outletId, a, b] of KNOWN_BACKLOG) {
    allow.add(`${showId}::${outletId}::${a}::${b}`);
    allow.add(`${showId}::${outletId}::${b}::${a}`);
  }
  return allow;
}

test('live corpus scan: no NEW same-show/same-outlet critic-name near-duplicate beyond the known backlog', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so this scan would have silently skipped. Fix the checkout rather than unsetting the flag.`,
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }

  const { findings, scanned } = scanReviewTextsForCriticDuplicates(REVIEW_TEXTS_DIR, { allow: buildAllowSet() });

  if (scanned < 100) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but only ${scanned} review files found at ${REVIEW_TEXTS_DIR} — the checkout looks empty or truncated, so this scan would have been vacuous. Fix the checkout rather than unsetting the flag.`,
    );
    t.skip(`only ${scanned} review files found at ${REVIEW_TEXTS_DIR} — checkout looks empty/truncated`);
    return;
  }

  assert.deepEqual(
    findings.map((f) => [f.showId, f.outletId, f.nameA, f.nameB]),
    [],
    'new same-show/same-outlet critic-name near-duplicate(s) found — this is the Markoski/Markosky double-count shape (BRO-4156). '
    + 'Either merge the duplicate files (keep the richer/real-URL record, dedupe criticName to the outlet\'s own byline spelling), '
    + 'or if this is a genuine two-different-critics collision, add it to KNOWN_BACKLOG/allow-list with a note why.',
  );
});

test('the Markoski/Markosky pair itself is gone from the live corpus (directed regression check)', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR}`);
    return;
  }
  const showDir = path.join(REVIEW_TEXTS_DIR, 'how-the-other-half-loves-west-end-2026');
  if (!fs.existsSync(showDir)) {
    t.skip(`show dir not present at ${showDir}`);
    return;
  }
  const files = fs.readdirSync(showDir);
  assert.ok(!files.includes('london-theatre--cheryl-markoski.json'), 'the misspelled duplicate file must be deleted, not just re-merged alongside the correct one');
  assert.ok(files.includes('london-theatre--cheryl-markosky.json'), 'the correctly-spelled file must exist');
  const data = JSON.parse(fs.readFileSync(path.join(showDir, 'london-theatre--cheryl-markosky.json'), 'utf8'));
  assert.equal(data.criticName, 'Cheryl Markosky');
});
