// Tests for scripts/validate-show-venue.js's pure decision functions (card
// #590, Bronco Billy: The Musical). Guards against stub entries where the
// venue/year are wrong by exercising the actual comparison logic against a
// real fixture (the Charing Cross Theatre / Bronco Billy production added
// by this card) rather than re-implementing the checks in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const {
  isProvisional, shortTitleSlug, scorePlaybillUrl,
  parseTitleVenueYear, parseFactDates, urlYear, daysBetween, compareShow,
} = require('../../scripts/validate-show-venue.js');

const broncoBilly = {
  id: 'bronco-billy-the-musical-west-end-2024',
  title: 'Bronco Billy – The Musical',
  venue: 'Charing Cross Theatre',
  category: 'off-west-end',
  openingDate: '2024-01-31',
  closingDate: '2024-04-07',
};
const broncoBillyPlaybillUrl = 'https://playbill.com/production/bronco-billy-the-musical-london-charing-cross-theatre-2024';

test('shortTitleSlug normalizes punctuation and dashes like Playbill URL slugs', () => {
  assert.equal(shortTitleSlug('Bronco Billy – The Musical'), 'bronco-billy-the-musical');
  assert.equal(shortTitleSlug("Schmigadoon!"), 'schmigadoon');
});

test('scorePlaybillUrl accepts the real Bronco Billy Playbill URL for the show', () => {
  const score = scorePlaybillUrl(broncoBillyPlaybillUrl, broncoBilly);
  assert.ok(score !== null, 'expected a non-null score for a matching URL');
  assert.ok(score > 0);
});

test('scorePlaybillUrl hard-rejects a same-titled London URL for a Broadway show (cross-market guard)', () => {
  // Regression for a P0 the adversarial review caught: adding "london" as a
  // recognized market segment must not let a same-titled London production
  // pass as a match for a Broadway/Off-Broadway show via the soft -5 penalty
  // (+10 title match - 5 = net positive, which findPlaybillUrl's `score > 0`
  // filter would have accepted).
  const broadwayShow = { id: 'bronco-billy-broadway-2030', title: 'Bronco Billy – The Musical', venue: 'Some Broadway House', category: 'broadway' };
  const score = scorePlaybillUrl(broncoBillyPlaybillUrl, broadwayShow);
  assert.equal(score, null);
});

test('scorePlaybillUrl hard-rejects a same-titled Broadway/Off-Broadway URL for a West End show (cross-market guard, reverse direction)', () => {
  const westEndShow = { ...broncoBilly };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/bronco-billy-the-musical-broadway-some-theatre-2030',
    westEndShow
  );
  assert.equal(score, null);
});

test('scorePlaybillUrl rejects a URL for a different title', () => {
  const score = scorePlaybillUrl(
    'https://playbill.com/production/some-other-show-west-end-charing-cross-theatre-2024',
    broncoBilly
  );
  assert.equal(score, null);
});

test('parseTitleVenueYear extracts market/venue/year from a Playbill <title> tag', () => {
  const html = '<title>Bronco Billy - The Musical (West End, Charing Cross Theatre, 2024) | Playbill</title>';
  const parsed = parseTitleVenueYear(html);
  assert.equal(parsed.market, 'West End');
  assert.equal(parsed.venue, 'Charing Cross Theatre');
  assert.equal(parsed.year, 2024);
});

test('parseFactDates extracts opening/closing dates from Playbill fact blocks', () => {
  const html = `
    <div class="bsp-list-promo-title">First Preview</div>
    <span class="info-circular-pre-text">Jan</span><span class="info-circular-text">24</span><span class="info-circular-post-text">2024</span>
    <div class="bsp-list-promo-title">Opening Date</div>
    <span class="info-circular-pre-text">Jan</span><span class="info-circular-text">31</span><span class="info-circular-post-text">2024</span>
    <div class="bsp-list-promo-title">Closing Date</div>
    <span class="info-circular-pre-text">Apr</span><span class="info-circular-text">7</span><span class="info-circular-post-text">2024</span>
  `;
  const dates = parseFactDates(html);
  assert.deepEqual(dates, {
    firstPreview: '2024-01-24',
    openingDate: '2024-01-31',
    closingDate: '2024-04-07',
  });
});

test('urlYear reads the trailing year off a Playbill production URL', () => {
  assert.equal(urlYear(broncoBillyPlaybillUrl), 2024);
});

test('daysBetween is null when either date is missing or unparseable', () => {
  assert.equal(daysBetween(null, '2024-01-31'), null);
  assert.equal(daysBetween('2024-01-31', 'not-a-date'), null);
  assert.equal(daysBetween('2024-01-31', '2024-02-02'), 2);
});

test('compareShow reports no mismatches when shows.json matches Playbill (Bronco Billy fixture)', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Charing Cross Theatre', year: 2024 },
    dates: { firstPreview: '2024-01-24', openingDate: '2024-01-31', closingDate: '2024-04-07' },
  };
  const { mismatches } = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.deepEqual(mismatches, []);
});

test('compareShow flags a venue mismatch (wrong-venue stub guard)', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Prince Edward Theatre', year: 2024 },
    dates: { firstPreview: '2024-01-24', openingDate: '2024-01-31', closingDate: '2024-04-07' },
  };
  const { mismatches } = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.ok(mismatches.some(m => m.field === 'venue'));
});

test('compareShow flags an opening-date delta beyond the 30-day threshold', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Charing Cross Theatre', year: 2024 },
    dates: { firstPreview: null, openingDate: '2024-04-01', closingDate: '2024-04-07' },
  };
  const { mismatches } = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.ok(mismatches.some(m => m.field === 'openingDate'));
});

// BRO-2023: Playbill's genre tag-line ("Broadway | Play | Revival" /
// "... | Original") is authoritative over both corpus title cross-reference
// and title heuristics — it catches a prior production this corpus never
// recorded AND a same-title cross-market transfer wrongly read as a revival.
test('compareShow flags isRevival mismatch when Playbill says Revival but shows.json says false (Gloria — missing prior production)', () => {
  const gloria = { id: 'gloria-2026', title: 'Gloria', venue: 'Helen Hayes Theater', category: 'broadway', isRevival: false };
  const parsed = {
    titleParse: null, dates: {},
    tagLine: { tags: ['Broadway', 'Play', 'Dark Comedy', 'Revival'], market: 'Broadway', showType: 'play', revivalStatus: 'revival' },
  };
  const { mismatches } = compareShow(gloria, parsed, 'https://playbill.com/production/gloria-broadway-helen-hayes-theater-2027');
  const m = mismatches.find(x => x.field === 'isRevival');
  assert.ok(m, 'expected an isRevival mismatch');
  assert.equal(m.shows, false);
  assert.equal(m.playbill, true);
});

test('compareShow flags isRevival mismatch when Playbill says Original but shows.json says true (transfer misread as revival)', () => {
  const interAlia = { id: 'inter-alia-broadway-2026', title: 'Inter Alia', venue: 'Music Box Theatre', category: 'broadway', isRevival: true };
  const parsed = {
    titleParse: null, dates: {},
    tagLine: { tags: ['Broadway', 'Play', 'Drama', 'One Act', 'Original'], market: 'Broadway', showType: 'play', revivalStatus: 'original' },
  };
  const { mismatches } = compareShow(interAlia, parsed, 'https://playbill.com/production/inter-alia-broadway-music-box-theatre-2026');
  const m = mismatches.find(x => x.field === 'isRevival');
  assert.ok(m, 'expected an isRevival mismatch');
  assert.equal(m.shows, true);
  assert.equal(m.playbill, false);
});

test('compareShow does not flag isRevival when Playbill tag line is absent/unknown', () => {
  const show = { id: 'x-2026', title: 'X', venue: 'Some Theatre', category: 'broadway', isRevival: false };
  const parsed = { titleParse: null, dates: {}, tagLine: { tags: [], market: null, showType: null, revivalStatus: 'unknown' } };
  const { mismatches } = compareShow(show, parsed, 'https://playbill.com/production/x-2026');
  assert.ok(!mismatches.some(m => m.field === 'isRevival'));
});

test('compareShow agrees — no isRevival mismatch when shows.json already matches Playbill', () => {
  const fantasticks = { id: 'the-fantasticks-2026', title: 'The Fantasticks', venue: 'Helen Hayes Theater', category: 'broadway', isRevival: true };
  const parsed = {
    titleParse: null, dates: {},
    tagLine: { tags: ['Broadway', 'Musical', 'Revival'], market: 'Broadway', showType: 'musical', revivalStatus: 'revival' },
  };
  const { mismatches } = compareShow(fantasticks, parsed, 'https://playbill.com/production/the-fantasticks-broadway-helen-hayes-theater-2026');
  assert.ok(!mismatches.some(m => m.field === 'isRevival'));
});

test('isProvisional flags manual-user-request entries like Bronco Billy for validation', () => {
  assert.equal(isProvisional({ discoverySource: 'manual-user-request', provisional: true }), true);
  assert.equal(isProvisional({ discoverySource: 'todaytix-sync', provisional: false }), false);
});

test('scorePlaybillUrl rejects a legacy URL whose venue is in another market (BRO-2821)', () => {
  // A legacy (vault / "-YYYY-YYYY") URL carries NO market segment, so the
  // -regional-/-tour-, -london- and -broadway- rejects are all no-ops on it and
  // isCrossMarketPlaybillUrl is too. An earlier fix rejected only legacy+London,
  // which was one-directional; both of these still scored 8.
  const obChicago = scorePlaybillUrl(
    'https://playbill.com/production/chicago-richard-rodgers-theatre-vault-0000003074',
    { id: 'chicago-ob-2026', title: 'Chicago', venue: 'Some Theatre', category: 'off-broadway' });
  assert.equal(obChicago, null, 'an off-Broadway stub must not take a Broadway house\'s vault page');

  const bwVsLondon = scorePlaybillUrl(
    'https://playbill.com/production/hamiltonvictoria-palace-theatre-2017-2018',
    { id: 'hamilton-2015', title: 'Hamilton', venue: 'Richard Rodgers Theatre', category: null });
  assert.equal(bwVsLondon, null, 'a Broadway show must not take a West End season page');

  // …and the real recovery this branch exists for still works: Chicago the
  // Broadway production, whose vault URL names the ORIGINAL house while the
  // corpus records the current one.
  const bwChicago = scorePlaybillUrl(
    'https://playbill.com/production/chicago-richard-rodgers-theatre-vault-0000003074',
    { id: 'chicago-1996', title: 'Chicago', venue: 'Ambassador Theatre', category: null });
  assert.ok(bwChicago !== null && bwChicago > 0, 'the genuine Broadway recovery must survive');
});

test('scorePlaybillUrl ranks an exact-title candidate above a relaxed one (BRO-2821)', () => {
  // The title gate used to score a flat 10 for every accepted URL; it now scores
  // exact=10 and relaxed=8, so when a SERP page returns both readings of a title
  // the exact one wins. Nothing pinned multi-candidate ORDERING before — the only
  // consumer filters `score > 0` and sorts — so an adversarial review noted the
  // ranking change was only accidentally safe. Pin it.
  const show = { id: 'doubt-2024', title: 'Doubt: A Parable', venue: 'Todd Haimes Theatre', category: null };
  const exact = scorePlaybillUrl(
    'https://playbill.com/production/doubt-a-parable-broadway-todd-haimes-theatre-2024', show);
  const relaxed = scorePlaybillUrl(
    'https://playbill.com/production/doubt-broadway-todd-haimes-theatre-2024', show);
  assert.ok(exact !== null && exact > 0, 'the exact-title URL must still be accepted');
  assert.ok(relaxed !== null && relaxed > 0, 'the relaxed URL must still be accepted');
  assert.ok(exact > relaxed,
    `exact (${exact}) must outrank relaxed (${relaxed}) at the same venue and year`);
});

// ---------------------------------------------------------------------------
// BRO-2821 suggestion 1 — the WIRING, not just the decision.
//
// scripts/lib/named-show-verdict.test.mjs pins the decision function. This
// spawns the real script end to end, because deleting the call site in
// validate-show-venue.js while leaving the require in place would not fail a
// single one of those tests — the exact shape of v38's defect 11 (a guard that
// detected an IMPORT rather than a call and stayed green at 23/23 with the fix
// removed). Reverting the `if (!named.validated)` block turns this test red.
//
// No network: serpQuery() returns null before touching any provider when
// neither SCRAPINGBEE_API_KEY nor BRIGHTDATA_TOKEN is set, which lands the show
// on 'serp-error' — an unresolved class. The fixture id is deliberately absent
// from data/playbill-urls.json (read from the real repo regardless of
// --data-dir, by design) so the cache cannot short-circuit ahead of that.
test('validate-show-venue exits non-zero when an explicitly named --show cannot be validated (BRO-2821)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsv-named-'));
  try {
    fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify([{
      id: 'bro-2821-fixture-show-never-real-2099',
      title: 'BRO-2821 Fixture Show Never Real',
      venue: 'Fixture Theatre',
      category: 'broadway',
      openingDate: '2099-01-01',
    }]));
    const res = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'validate-show-venue.js'),
      '--show=bro-2821-fixture-show-never-real-2099',
      '--dry-run',
      `--data-dir=${tmp}`,
    ], {
      encoding: 'utf8',
      // v38: the sibling venue-complex wiring test went red on
      // `spawnSync node ENOBUFS` because a whole-validator spawn crossed the
      // 1 MiB default. Set it explicitly rather than inherit that boundary.
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        SCRAPINGBEE_API_KEY: '',
        BRIGHTDATA_TOKEN: '',
        SCRAPINGDOG_API_KEY: '',
        // Never let a test read or write the repo-wide ledger (BRO-2696).
        VENUE_AUDIT_PATH: path.join(tmp, 'venue-date-mismatches.json'),
      },
    });
    // Re-raise rather than collapsing to a number: an ENOBUFS or ETIMEDOUT
    // kill surfaces on res.error with res.status null, and reading that as a
    // failing exit code would make this test "pass" for the wrong reason.
    if (res.error) throw res.error;
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    assert.notEqual(res.status, 0,
      `a named --show that produced no verdict must not exit 0. Output:\n${out}`);
    assert.equal(res.status, 3,
      `expected the not-validated exit code 3 (1 = real mismatch, 2 = fatal). Output:\n${out}`);
    assert.match(out, /was NOT validated/);
    assert.match(out, /bro-2821-fixture-show-never-real-2099/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The autonomous Tier-2 verifier (scripts/autonomous-merge.js) reports a block
// reason as the FIRST 400 characters of `err.stderr || err.stdout ||
// err.message`, stderr preferred. This script's stdout holds a full run log by
// that point, so a stdout-only reason would surface on the card as the log's
// opening lines and the real cause would never be read. Pin the reason to
// stderr, and pin that it survives that exact 400-char slice.
test('the not-validated reason reaches stderr, so the autonomous block reason is the cause and not the log header (BRO-2821)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsv-named-stderr-'));
  try {
    fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify([{
      id: 'bro-2821-fixture-show-never-real-2099',
      title: 'BRO-2821 Fixture Show Never Real',
      venue: 'Fixture Theatre',
      category: 'broadway',
      openingDate: '2099-01-01',
    }]));
    const res = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'validate-show-venue.js'),
      '--show=bro-2821-fixture-show-never-real-2099',
      '--dry-run',
      `--data-dir=${tmp}`,
    ], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        SCRAPINGBEE_API_KEY: '',
        BRIGHTDATA_TOKEN: '',
        SCRAPINGDOG_API_KEY: '',
        VENUE_AUDIT_PATH: path.join(tmp, 'venue-date-mismatches.json'),
      },
    });
    if (res.error) throw res.error;
    const harnessVisible = res.stderr ? res.stderr : (res.stdout || '');
    const firstChunk = String(harnessVisible).slice(0, 400);
    assert.match(firstChunk, /was NOT validated/,
      `the first 400 chars of the harness-visible output must carry the cause, got:\n${firstChunk}`);
    assert.match(firstChunk, /bro-2821-fixture-show-never-real-2099/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Third wiring test: the run that never REACHED the named show. The
// time-budget `break` in validate-show-venue.js's loop is not gated on
// --all-provisional, so `--show=<id> --time-budget-min=<tiny>` produces zero
// result rows. Before the targetCount check that read as a clean exit 0.
// Deterministic and offline: the budget is exhausted before the first
// iteration, so no SERP or Playbill call is made at all.
test('validate-show-venue exits non-zero when the run never reached the named --show (BRO-2821)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsv-notreached-'));
  try {
    fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify([{
      id: 'bro-2821-fixture-show-never-real-2099',
      title: 'BRO-2821 Fixture Show Never Real',
      venue: 'Fixture Theatre',
      category: 'broadway',
      openingDate: '2099-01-01',
    }]));
    const res = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'validate-show-venue.js'),
      '--show=bro-2821-fixture-show-never-real-2099',
      // A tiny POSITIVE value: parseTimeBudgetMin treats <=0 as "disabled"
      // (scripts/lib/run-budget.js:30), so 0 would silently turn the budget
      // off and this test would exercise the wrong path.
      '--time-budget-min=0.000001',
      '--dry-run',
      `--data-dir=${tmp}`,
    ], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        SCRAPINGBEE_API_KEY: '',
        BRIGHTDATA_TOKEN: '',
        SCRAPINGDOG_API_KEY: '',
        VENUE_AUDIT_PATH: path.join(tmp, 'venue-date-mismatches.json'),
      },
    });
    if (res.error) throw res.error;
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    assert.notEqual(res.status, 0,
      `a named --show the run never reached must not exit 0. Output:\n${out}`);
    assert.match(out, /bro-2821-fixture-show-never-real-2099/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The regional/tour market reject. CI run 34000023372 went RED on
// much-ado-about-nothing-2026: a Broadway show at the Winter Garden opening
// 2026-11-19 scored a full 10 against
// /production/much-ado-about-nothing-regional-playmakers-repertory-company-2023,
// a different production three years earlier. The guard's own comment said
// "never a fit for a NYC OB/Broadway entry" while its condition only covered
// `isOB || !show.category` — the comment was the rule, the code was narrower.
// An upcoming Broadway show often has no Playbill page yet, so the scorer
// reaches for the nearest same-titled one; that is the population this guards.
test('scorePlaybillUrl rejects a REGIONAL production URL for a Broadway show (CI run 34000023372 red main)', () => {
  const muchAdo = {
    id: 'much-ado-about-nothing-2026', title: 'Much Ado About Nothing',
    venue: 'Winter Garden Theatre', category: 'broadway',
  };
  assert.equal(scorePlaybillUrl(
    'https://playbill.com/production/much-ado-about-nothing-regional-playmakers-repertory-company-2023',
    muchAdo), null);
});

test('scorePlaybillUrl rejects a regional URL for a West End show too — the reject is not NYC-only', () => {
  const we = { id: 'y-2026', title: 'Some Play', venue: 'Apollo Theatre', category: 'west-end' };
  assert.equal(scorePlaybillUrl(
    'https://playbill.com/production/some-play-regional-playmakers-repertory-company-2024', we), null);
});

test('a category-less entry still refuses a regional URL (unchanged behaviour)', () => {
  const noCat = { id: 'x-2026', title: 'Some Play', venue: 'Whatever', category: null };
  assert.equal(scorePlaybillUrl(
    'https://playbill.com/production/some-play-regional-playmakers-repertory-company-2024', noCat), null);
});

test('a REGIONAL show may still hold a regional URL — the reject must not swallow its own market', () => {
  const regShow = { id: 'some-regional-2024', title: 'Some Play', venue: 'PlayMakers Repertory Company', category: 'regional' };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/some-play-regional-playmakers-repertory-company-2024', regShow);
  assert.ok(score !== null && score > 0, `a regional show's own regional URL must survive, got ${score}`);
});

// The other half of the same fix, and a defect that PREDATES it: the test used
// to search the WHOLE url, and the title is part of the url, so a show whose
// own name contains "tour" or "regional" condemned itself. This is BRO-2821
// defect 5's shape (a venue gate that searched the whole url let a show
// corroborate itself) pointed the other way. Exactly one corpus title has this
// shape today, and it scored null on its own correct page.
test('a show whose TITLE contains "tour" still matches its own correct URL (whole-url self-condemnation)', () => {
  const apology = {
    id: 'september-l-davis-the-apology-tour-off-broadway-2026',
    title: 'September L. Davis: The Apology Tour',
    venue: 'Soho Playhouse', category: 'off-broadway',
  };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/september-l-davis-the-apology-tour-off-broadway-soho-playhouse-2026',
    apology);
  assert.ok(score !== null && score > 0,
    `the title's own "-tour-" must not reject its own off-Broadway page, got ${score}`);
});

// The SAME whole-url defect in the market tests a few lines further down.
// v39 narrowed only the regional/tour reject to `marketTail`; `-london-`,
// `-broadway-` and `-off-broadway-` were still read off the WHOLE url, and the
// title is part of the url.
//
// Both of these are LATENT shapes, stated plainly so nobody later reads them as
// incident repros: measured 2026-09-06, 16 of 2,942 corpus titles carry a market
// word, none of them changes score under the market half of the fix, and all 107
// live playbill-urls.json entries score identically old-vs-new on it. The
// whole-url read only bites when the title's market word contradicts the url's
// real market segment, which is why these two cases are constructed rather than
// quoted. The venue half further down DOES move one live entry, named there.
test('a show whose TITLE contains "london" still matches its own correct non-London URL', () => {
  const show = {
    id: 'a-night-in-london-off-broadway-2026',
    title: 'A Night in London',
    venue: 'Soho Playhouse', category: 'off-broadway',
  };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/a-night-in-london-off-broadway-soho-playhouse-2026', show);
  assert.ok(score !== null && score > 0,
    `the title's own "-london-" must not trip the cross-market reject on its own off-Broadway page, got ${score}`);
  // `> 0` alone cannot tell "market read correctly" from "no market signal at
  // all" — and that gap is exactly why neither of these tests caught the
  // form-vs-raw-path defect in their own commit. Pin the bonus itself against a
  // control whose title carries no market word.
  const control = { ...show, id: 'a-night-out-off-broadway-2026', title: 'A Night Out' };
  const controlScore = scorePlaybillUrl(
    'https://playbill.com/production/a-night-out-off-broadway-soho-playhouse-2026', control);
  assert.equal(score, controlScore,
    `the "-london-" title must score exactly like the same show without it: ${score} vs ${controlScore}`);
});

test('a TITLE containing "broadway" does not change the market bonus (self-corroboration)', () => {
  // Same category, same market segment in the url, same venue — the ONLY
  // difference is a market word inside the title, so the scores must be equal.
  const withWord = {
    id: 'prince-of-broadway-regional-2024', title: 'Prince of Broadway',
    venue: 'Some Company', category: 'regional',
  };
  const without = {
    id: 'prince-of-tides-regional-2024', title: 'Prince of Tides',
    venue: 'Some Company', category: 'regional',
  };
  const a = scorePlaybillUrl(
    'https://playbill.com/production/prince-of-broadway-regional-some-company-2024', withWord);
  const b = scorePlaybillUrl(
    'https://playbill.com/production/prince-of-tides-regional-some-company-2024', without);
  assert.ok(a !== null && b !== null, `both must match their own regional page, got ${a} and ${b}`);
  assert.equal(a, b, `the title's own "-broadway-" must not earn a market bonus: ${a} vs ${b}`);
});

// The narrowing above is worthless unless the tail is derived correctly, and
// the first cut of it was not. It read `pathTail.startsWith(titleMatch.form)`,
// but `form` is a NORMALIZED title — normalizeTitle strips a leading "the-"
// that Playbill keeps — so the test failed for every "The …" title and the
// fallback silently restored whole-url behaviour on 16 of the 97 title-matching
// live cache entries. The matcher now returns the raw tail for the split it
// chose. This case is a "The …" title carrying a market word: it exercises the
// derivation, not just the comparison.
test('a "The …" title gets a REAL market tail, not a silent whole-url fallback', () => {
  const show = {
    id: 'the-london-season-off-broadway-2026',
    title: 'The London Season',
    venue: 'Soho Playhouse', category: 'off-broadway',
  };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/the-london-season-off-broadway-soho-playhouse-2026', show);
  assert.ok(score !== null && score > 0,
    `"the-" is stripped from the normalized form, so deriving the tail from it falls back to the whole url and the title's own "-london-" rejects the show, got ${score}`);
});

// The venue bonus had the same whole-url shape, defended by an argument that
// was wrong: competing candidates need NOT consume the same title text, since
// exact/lossless/lossy each consume a different form, so a +2 taken off the
// title can outrank a candidate that names the real venue in its tail.
// music-city-off-broadway-2026 is the live instance — its venue field is
// literally its title, and it took +2 (18, now 16) off a url whose actual venue
// is st-lukes-theatre. It is the only one of the 107 cache entries that moves.
// NOTE for whoever reads these numbers: canonicalVenue() returns only the
// venue's FIRST WORD, lowercased — "St. Luke's Theatre" becomes "st." — so the
// bonus is first-word matching and never fires for a punctuated first word.
// That is pre-existing and deliberately not touched here; it is why the cases
// below use venues whose first word is a clean token.
test('the venue bonus does not fire off the title (music-city-off-broadway-2026)', () => {
  const url = 'https://playbill.com/production/music-city-off-broadway-st-lukes-theatre-2026';
  // canonicalVenue("Music City") === "music", which appears in the TITLE and
  // nowhere else in this url. This is the live entry: it scored 18, now 16.
  const selfNamed = {
    id: 'music-city-off-broadway-2026', title: 'Music City',
    venue: 'Music City', category: 'off-broadway',
  };
  // canonicalVenue("Palace Theatre") === "palace", which appears nowhere at all.
  const absent = {
    id: 'music-city-off-broadway-2026', title: 'Music City',
    venue: 'Palace Theatre', category: 'off-broadway',
  };
  const selfScore = scorePlaybillUrl(url, selfNamed);
  const absentScore = scorePlaybillUrl(url, absent);
  assert.ok(selfScore !== null && absentScore !== null,
    `both must still match the title, got ${selfScore} and ${absentScore}`);
  assert.equal(selfScore, absentScore,
    `a venue that only appears inside the show's own TITLE must score the same as one that is absent: self=${selfScore} absent=${absentScore}`);
});

test('the venue bonus still fires when the venue is genuinely in the tail', () => {
  // The positive control for the test above — without it, "no bonus ever" would
  // pass just as happily as "no bonus off the title".
  const url = 'https://playbill.com/production/music-city-off-broadway-soho-playhouse-2026';
  const inTail = {
    id: 'music-city-off-broadway-2026', title: 'Music City',
    venue: 'Soho Playhouse', category: 'off-broadway',
  };
  const absent = {
    id: 'music-city-off-broadway-2026', title: 'Music City',
    venue: 'Palace Theatre', category: 'off-broadway',
  };
  const withVenue = scorePlaybillUrl(url, inTail);
  const without = scorePlaybillUrl(url, absent);
  assert.ok(withVenue > without,
    `a venue named in the url's tail must still earn its bonus: ${withVenue} vs ${without}`);
});
