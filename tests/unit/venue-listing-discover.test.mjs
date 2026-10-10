// Per-venue fixture tests for scripts/lib/venue-listing-discover.js.
//
// Fixtures captured live 2026-05-26 (see tests/fixtures/ob-discovery/).
// Subagent baseline counts: Atlantic 6, Vineyard 2, Signature 14, MCC 5.
//
// Why: ship-check QA reviewer flagged the lib as untested, and the
// pre-mortem PRIMARY scenario is "Atlantic banner-class reuse leaks
// phantom shows past the gate." A fixture test catches selector rot
// before it ships — if the parser starts returning 14 from a 6-baseline
// fixture, the test fails and a real reviewer can decide whether the
// fixture is stale or the parser regressed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OB_VENUE_CONFIGS, OWE_VENUE_CONFIGS, parseVenueListingHtml, DATED_JSON_STRATEGIES } = require('../../scripts/lib/venue-listing-discover.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'ob-discovery');

// Subagent-verified counts from /tmp/ob-venue-playwright-findings.md.
// expectedMin = an absolute floor; expectedMax catches selector-leak
// regressions (e.g. Atlantic banner showing 14 phantoms). Bands tolerate
// minor venue-page changes without false-failing the test.
const EXPECTED = {
  'Atlantic Theater':  { min: 4,  max: 10, mustInclude: ['indian-princesses', 'reservoir'] },
  'Vineyard Theatre':  { min: 1,  max: 6,  mustInclude: ['girls', 'msblackforpresident'] },
  'Signature Theatre': { min: 5,  max: 20, mustInclude: ['animal-wisdom', 'king-of-the-yees', 'miles-for-mary'] },
  'MCC Theater':       { min: 3,  max: 12, mustInclude: ['birthright', 'cold-war-choir-practice'] },
  // Tier A additions (2026-05-26 — Soho Rep, The New Group, Irish Rep).
  // TFANA + Second Stage Uptown deferred — TFANA site 526 SSL errored,
  // 2st Uptown stream is currently dormant (Hayes B'way only).
  'Soho Rep':          { min: 0,  max: 2,  mustInclude: [] },   // 1 current show typical; sometimes between productions
  'The New Group':     { min: 1,  max: 5,  mustInclude: [] },   // hero + obj-title cards; verifies cross-venue dedup with Signature
  'Irish Rep':         { min: 1,  max: 4,  mustInclude: [] },
  // St. Ann's Warehouse (added to OB_VENUE_CONFIGS 9b07b87295). Homepage
  // /show/<slug>/ links; fixture captured 2026-05-28 (~59KB) parsed 6 shows.
  'St. Ann\'s Warehouse': { min: 4, max: 10, mustInclude: ['the-maids', 'anna-christie'] },
  // S5-T2 (2026-07-22): added from the late-add venue ranking (both venues
  // directly produced a real late-add gap in the corpus). Fixtures captured
  // live 2026-07-22 (curl, no JS rendering needed for either page).
  'Bedlam': { min: 10, max: 25, mustInclude: ['new-portfolio-item', 'hamlet'] },
  'Audible\'s Minetta Lane Theatre': { min: 1, max: 6, mustInclude: ['gloria-steinem'] },
  // BRO-3123 (2026-09-09): closes the discovery gap that let "The Ford/Hill
  // Project" (BAM) and "Bigfoot Ripped My Dog In Half I Saw It" (Soho
  // Playhouse) go missing — neither sold through TodayTix, and Show Score
  // didn't have Bigfoot listed either. Fixtures captured live 2026-09-09
  // (curl, no JS rendering needed for either page); real parse counts were
  // 13 (Soho Playhouse) and 6 (BAM).
  // BRO-4396: now read from the venue's OvationTix org (JSON bundle fixture,
  // captured live 2026-09-29: 32 productions, every one dated). Full titles
  // instead of the homepage's marketing slugs.
  'Soho Playhouse': { min: 25, max: 45, capturedOn: '2026-09-29', mustInclude: ['bigfoot-ripped-my-dog-in-half-i-saw-it', 'diana-the-untold-and-untrue-story', 'the-very-gay-christmas-prince'], allDated: true },
  'BAM': { min: 3, max: 12, mustInclude: ['ford-hill-project'] },
  // ── BRO-4396: fixtures captured live 2026-09-29, replayed against that day
  // (dated readers drop closed bookings). allDated = every row must carry
  // both run dates, which is what lets the listing count as evidence.
  'WP Theater': { min: 1, max: 6, capturedOn: '2026-09-29', mustInclude: ['fish'], allDated: true },
  'The Players Theatre': { min: 8, max: 25, capturedOn: '2026-09-29', mustInclude: ['alice-in-wonderland-the-musical', 'broom-play'], allDated: true },
  'The Flea Theater': { min: 1, max: 6, capturedOn: '2026-09-29', mustInclude: ['beyond-the-stardust'], allDated: true },
  'Axis Theatre': { min: 1, max: 4, capturedOn: '2026-09-29', mustInclude: ['specimen'], allDated: true },
  'The Space at Irondale': { min: 1, max: 6, capturedOn: '2026-09-29', mustInclude: ['miss-julie'], allDated: true },
  "Theater at St. Jean's": { min: 3, max: 10, capturedOn: '2026-09-29', mustInclude: ['kilgallen', 'truly-howard-hughes'], allDated: true },
  '59E59 Theaters': { min: 6, max: 16, capturedOn: '2026-09-29', mustInclude: ['crazy-mama', 'the-steel-man', 'fantasma'], allDated: true },
  'Polonsky Shakespeare Center': { min: 1, max: 5, capturedOn: '2026-09-29', mustInclude: ['elektra'], mustExclude: ['ztest', 'seminar', 'discussion'], allDated: true },
  'The Theater Center': { min: 1, max: 5, capturedOn: '2026-09-29', mustInclude: ['perfect-crime'] },
  "Theatre at St. Clement's": { min: 0, max: 4, capturedOn: '2026-09-29', mustInclude: [] },
  'Westside Theatre': { min: 1, max: 3, capturedOn: '2026-09-29', mustInclude: ['little-shop-of-horrors'] },
  'Stage 42': { min: 0, max: 3, capturedOn: '2026-09-29', mustInclude: [] },
  'East Village Basement': { min: 0, max: 4, capturedOn: '2026-09-29', mustInclude: [] },
  'Classic Stage Company': { min: 2, max: 6, capturedOn: '2026-09-29', mustInclude: ['waiting-for-lefty', 'penelope'], allDated: true },
  'Perelman Performing Arts Center': { min: 2, max: 8, capturedOn: '2026-09-29', mustInclude: ['a-christmas-carol', 'the-unsinkable'], allDated: true },
  'NYU Skirball': { min: 6, max: 20, capturedOn: '2026-09-29', mustInclude: ['tom-at-the-farm', 'dead-centre-deaf-republic'], allDated: true },
  'Repertorio Español': { min: 6, max: 16, capturedOn: '2026-09-29', mustInclude: ['toc-toc', 'la-gringa'], allDated: true },
  'Cherry Lane Theatre': { min: 1, max: 6, capturedOn: '2026-09-29', mustInclude: ['school-pictures', 'two-girls'], allDated: true },
  'Asylum NYC': { min: 4, max: 20, capturedOn: '2026-09-29', mustInclude: ['the-infinite-wrench'], allDated: true },
  'New Victory Theater': { min: 5, max: 14, capturedOn: '2026-09-29', mustInclude: ['rosie-revere', 'tilt'], allDated: true },
  // "the Ādat" is listed as "January 2027" with no day: undated by design.
  'HERE Arts Center': { min: 3, max: 8, capturedOn: '2026-09-29', mustInclude: ['arias-with-a-twist', 'the-kick-inside'] },
  'New York City Center': { min: 10, max: 25, capturedOn: '2026-09-29', mustInclude: ['in-the-heights', 'kiss-of-the-spider-woman'] },
  'Studio Seaview': { min: 2, max: 8, capturedOn: '2026-09-29', mustInclude: ['sea-wall', 'spring-awakening'], allDated: true },
  'New York Theatre Workshop': { min: 3, max: 8, capturedOn: '2026-09-29', mustInclude: ['wild-rose', 'blood-be-sweet'], allDated: true },
  'A.R.T./New York Theatres': { min: 3, max: 10, capturedOn: '2026-09-29', mustInclude: ['burning-leaves', 'the-morbs'], allDated: true },
  // Roundabout's page, filtered to the Laura Pels (Rocky Horror at Studio 54
  // and The Imaginary Invalid at the Todd Haimes must NOT appear).
  'Laura Pels Theatre': { min: 1, max: 5, capturedOn: '2026-09-29', mustInclude: ['the-heart'], mustExclude: ['rocky-horror', 'imaginary-invalid'] },
  // Newhouse / Claire Tow only; A Few Good Men and The Sound of Music are
  // at the (Broadway) Beaumont.
  'Lincoln Center Theater': { min: 2, max: 8, capturedOn: '2026-09-29', mustInclude: ['seven-guitars', 'pretend-its-pretend'], mustExclude: ['a-few-good-men', 'the-sound-of-music'] },
  'The Public Theater': { min: 2, max: 12, capturedOn: '2026-09-29', mustInclude: ['the-curious-case-of-benjamin-button'], allDated: true },
  'Lucille Lortel Theatre': { min: 1, max: 4, capturedOn: '2026-09-29', mustInclude: ['2-22-a-ghost-story'], allDated: true },
  'New World Stages': { min: 3, max: 10, capturedOn: '2026-09-29', mustInclude: ['heathers-the-musical'] },
  'Daryl Roth Theatre': { min: 1, max: 4, capturedOn: '2026-09-29', mustInclude: ['midnight'], allDated: true },
  'Greenwich House Theater': { min: 1, max: 4, capturedOn: '2026-09-29', mustInclude: ['pre-existing-condition'], allDated: true },
  'Park Avenue Armory': { min: 1, max: 6, capturedOn: '2026-09-29', mustInclude: ['music-for-18-musicians'], mustExclude: ['armory-public-tours'], allDated: true },
  'Playwrights Horizons': { min: 3, max: 12, capturedOn: '2026-09-29', mustInclude: ['degenerates'] },
  '92NY': { min: 2, max: 8, capturedOn: '2026-09-29', mustInclude: ['annie'], allDated: true },
  'Theatre Row': { min: 1, max: 8, capturedOn: '2026-09-29', mustInclude: ['parcel-from-america'], allDated: true },
  'The Ruby Theatre': { min: 1, max: 5, capturedOn: '2026-09-29', mustInclude: ['drunk-dracula'] },
  'Orpheum Theatre': { min: 1, max: 3, capturedOn: '2026-09-29', mustInclude: ['slam-frank'], allDated: true },
  'The Marjorie S. Deane Little Theater': { min: 1, max: 4, capturedOn: '2026-09-29', mustInclude: ['going-bacharach'], allDated: true },
  'West End Theatre': { min: 1, max: 3, capturedOn: '2026-09-29', mustInclude: ['human-things'], allDated: true },
  'Astor Place Theatre': { min: 0, max: 3, capturedOn: '2026-09-29', mustInclude: [] },
  'The Duke on 42nd Street': { min: 1, max: 3, capturedOn: '2026-09-29', mustInclude: ['copperfield'], allDated: true },
};

for (const venue of OB_VENUE_CONFIGS) {
  const slug = venue.name.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
  // Platform readers (OvationTix, Tribe REST) replay a JSON payload.
  const ext = DATED_JSON_STRATEGIES.has(venue.strategy) ? '.json' : '.html';
  const fixturePath = join(FIXTURE_DIR, slug + ext);
  const expected = EXPECTED[venue.name];
  // Dated readers drop bookings that already closed, so a fixture replays
  // against the day it was captured, not today.
  const parseOpts = expected?.capturedOn ? { todayIso: expected.capturedOn } : undefined;

  // P0 from /second-opinion: silent test skip if EXPECTED[venue.name] is
  // missing. assert.ok(len >= undefined) silently passes. Fail loud.
  test(`${venue.name}: EXPECTED entry must exist`, () => {
    assert.ok(expected, `EXPECTED[${JSON.stringify(venue.name)}] missing — add band to EXPECTED map in this file`);
    assert.ok(typeof expected.min === 'number', `EXPECTED[${venue.name}].min must be number`);
    assert.ok(typeof expected.max === 'number', `EXPECTED[${venue.name}].max must be number`);
  });

  test(`${venue.name}: fixture parses to band ${expected?.min ?? '?'}..${expected?.max ?? '?'}`, () => {
    if (!expected) { assert.fail(`EXPECTED missing — see prior test`); }
    if (!existsSync(fixturePath)) {
      assert.fail(`fixture missing: ${fixturePath} — capture via scripts/smoke-ob-discovery.js`);
    }
    const html = readFileSync(fixturePath, 'utf8');
    const candidates = parseVenueListingHtml(venue, html, parseOpts);

    assert.ok(candidates.length >= expected.min,
      `${venue.name}: got ${candidates.length} candidates, expected >=${expected.min}. Titles: ${candidates.map(c => c.title).join(', ')}`);
    assert.ok(candidates.length <= expected.max,
      `${venue.name}: got ${candidates.length} candidates, expected <=${expected.max}. Selector may be leaking — titles: ${candidates.map(c => c.title).join(', ')}`);

    // Each "must include" slug must appear in at least one candidate's slug.
    const allSlugs = candidates.map(c => c.slug).join(' | ');
    for (const required of expected.mustInclude) {
      assert.ok(
        candidates.some(c => c.slug.includes(required)),
        `${venue.name}: expected a candidate with slug containing "${required}", got slugs: ${allSlugs}`
      );
    }

    for (const banned of expected.mustExclude || []) {
      assert.ok(!candidates.some(c => c.slug.includes(banned)), `${venue.name}: "${banned}" belongs to another house and must be filtered out; got: ${allSlugs}`);
    }

    // A dated reader must actually deliver dates: decideVenueListingPromotion
    // treats the listing as evidence only when both ends of the run are known.
    if (expected.allDated) {
      const undated = candidates.filter(c => !c.listingFirstDate || !c.listingLastDate);
      assert.deepEqual(undated.map(c => c.title), [], `${venue.name}: dated reader returned undated rows`);
    }
  });

  test(`${venue.name}: parser rejects empty html`, () => {
    assert.deepEqual(parseVenueListingHtml(venue, ''), []);
    assert.deepEqual(parseVenueListingHtml(venue, '<html></html>'), []);
  });
}

// ── BRO-4398: Off-West End dated readers ───────────────────────────────────
// Fixtures captured live 2026-09-30 with plain curl (Spektrix: /api/v3/events
// plus /api/v3/instances trimmed to {event.id, start, cancelled}, both cut to
// events still running that day). Every row must be dated, since a dated row
// is what lets promote-owe-venue-candidates.js accept the venue's own
// listing; Spektrix rows must also carry a performance count. mustExclude
// names add-ons and non-theatre rows each account really lists.
const OWE_FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'owe-discovery');
const OWE_CAPTURED_ON = '2026-09-30';
const EXPECTED_OWE = {
  'Theatre Royal Stratford East': { min: 5, max: 12, mustInclude: ['bloodsport', 'robin-hood', 'surinderella'], mustExclude: ['ses-sep'] },
  'Kiln Theatre': { min: 2, max: 5, mustInclude: ['nine-night', 'table-17', 'berlin'], mustExclude: ['hadestown', 'nt-live', 'audio-description', 'bad-apples'] },
  'Southwark Playhouse': { min: 8, max: 14, mustInclude: ['jane-eyre', 'dog-mom', 'twenty-thousand-streets-under-the-sky'], mustExclude: ['playtext', 'bundle', 'writers-collective', 'chris-test'] },
  'Orange Tree Theatre': { min: 15, max: 32, mustInclude: ['cranford', 'a-small-and-quiet-light', 'king-lear'], mustExclude: ['ot-on-screen'] },
  'Park Theatre': { min: 10, max: 20, mustInclude: ['the-pianist', 'holy-fool', 'bull'], mustExclude: ['programme', 'drinks', 'pizzas', 'touch-tour', 'winner-of', 'cast-album'] },
  'Bush Theatre': { min: 5, max: 10, mustInclude: ['darkling', 'the-hungry-ghost'], mustExclude: ['touch-tour', 'captioning', 'pre-order', 'audio-description', 'alt-b'] },
  'Arcola Theatre': { min: 5, max: 10, mustInclude: ['the-master-builder', 'incident-at-vichy'], mustExclude: ['2026-', 'ayt', 'writing-workshop'] },
  "King's Head Theatre": { min: 4, max: 8, mustInclude: ['dick-whittington', 'gang-of-three'], mustExclude: ['adult', 'secure-my-booking'] },
  'Lyric Hammersmith': { min: 8, max: 18, mustInclude: ['fences', 'the-children', 'cinderella'], mustExclude: ['for-the-culture', 'touch-tour', 'secure-my-booking', 'test-event', 'scratch'] },
  'Young Vic': { min: 6, max: 14, mustInclude: ['thelma-louise', 'eurotrash', 'girls'], mustExclude: ['priority-test', 'headset', 'assisted-listening'] },
  'Riverside Studios': { min: 10, max: 25, mustInclude: ['cadel-lungs-on-legs', 'tinderella'], mustExclude: ['yoga', 'pilates', 'rehearsal-room', 'scratch-night', 'in-conversation', 'riverside-sharing'] },
  'Bridge Theatre': { min: 1, max: 4, mustInclude: ['pride', 'ivanov'] },
  'Menier Chocolate Factory': { min: 1, max: 4, mustInclude: ['tru', 'fourteen-again'] },
  'Almeida Theatre': { min: 2, max: 6, mustInclude: ['golden-boy', 'desire-under-the-elms'], mustExclude: ['theatre-tour'] },
  'New Diorama Theatre': { min: 2, max: 6, mustInclude: ['stuffed', 'orlando-a-pornobiography'], mustExclude: ['operation-mincemeat'] },
  'Troubadour Wembley Park Theatre': { min: 1, max: 3, mustInclude: ['high-school-musical'], mustExclude: ['hunger-games'] },
  'Hampstead Theatre': { min: 3, max: 8, mustInclude: ['kimberly-akimbo', 'the-urmetazoan', 'jumpers'] },
  'Finborough Theatre': { min: 2, max: 8, mustInclude: ['what-the-animals-say', 'the-moth'], mustExclude: ['walking-tours', 'voices-from-ukraine', 'remember-your-lovers'] },
  // BRO-4433 readers.
  'Rose Theatre Kingston': { min: 2, max: 6, mustInclude: ['jane-eyre', 'frankenstein', 'three-men-in-a-boat'], mustExclude: ['play-in-a-week', 'test', 'tribute', 'dinosaur', 'secure-my-booking', 'touch-tour'] },
  "Wilton's Music Hall": { min: 10, max: 30, mustInclude: ['the-little-match-girl', 'not-the-benny-hill-show', 'romeo-and-juliet', 'wolf-country'], mustExclude: ['live-score', 'guided-tours', 'the-marriage-of-figaro', 'oct26', 'apr27', 'jan-27', 'cally-beaton'] },
  'Waterloo East Theatre': { min: 1, max: 5, mustInclude: ['jerker', 'a-train-to-woking'], mustExclude: ['standby-please'] },
};

test('OWE_VENUE_CONFIGS: every reader is off-west-end and has an EXPECTED_OWE band', () => {
  for (const v of OWE_VENUE_CONFIGS) {
    assert.equal(v.category, 'off-west-end', v.name);
    assert.ok(EXPECTED_OWE[v.name], `EXPECTED_OWE[${JSON.stringify(v.name)}] missing`);
  }
});

for (const venue of OWE_VENUE_CONFIGS) {
  const slug = venue.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ext = DATED_JSON_STRATEGIES.has(venue.strategy) ? '.json' : venue.strategy === 'ticketsolve' ? '.xml' : '.html';
  const fixturePath = join(OWE_FIXTURE_DIR, slug + ext);
  const expected = EXPECTED_OWE[venue.name] || { min: 1, max: 0, mustInclude: [] };

  test(`OWE ${venue.name}: fixture parses to band ${expected.min}..${expected.max}, every row dated`, () => {
    assert.ok(existsSync(fixturePath), `fixture missing: ${fixturePath}`);
    const candidates = parseVenueListingHtml(venue, readFileSync(fixturePath, 'utf8'), { todayIso: OWE_CAPTURED_ON });
    const titles = candidates.map(c => c.title).join(', ');
    assert.ok(candidates.length >= expected.min && candidates.length <= expected.max, `${venue.name}: got ${candidates.length} (${titles})`);
    const slugs = candidates.map(c => c.slug).join(' | ');
    for (const required of expected.mustInclude) {
      assert.ok(candidates.some(c => c.slug.includes(required)), `${venue.name}: expected "${required}" in ${slugs}`);
    }
    for (const banned of expected.mustExclude || []) {
      assert.ok(!candidates.some(c => c.slug.includes(banned)), `${venue.name}: "${banned}" must be filtered out; got ${slugs}`);
    }
    const undated = candidates.filter(c => !c.listingFirstDate || !c.listingLastDate);
    assert.deepEqual(undated.map(c => c.title), [], `${venue.name}: dated reader returned undated rows`);
    if (venue.strategy === 'spektrix' && venue.spektrixInstances) {
      const uncounted = candidates.filter(c => typeof c.listingPerformanceCount !== 'number' || c.listingPerformanceCount < 1);
      assert.deepEqual(uncounted.map(c => c.title), [], `${venue.name}: Spektrix rows need a performance count from /instances`);
    }
    for (const c of candidates) assert.equal(c.category, 'off-west-end');
  });

  test(`OWE ${venue.name}: parser rejects empty payload`, () => {
    assert.deepEqual(parseVenueListingHtml(venue, ''), []);
  });
}

test('slugToTitle keeps Roman numerals upper case (BRO-4563 "Richard Ii")', () => {
  const { slugToTitle, extractByRegex } = require('../../scripts/lib/venue-listing-discover.js');
  assert.equal(slugToTitle('richard-ii'), 'Richard II');
  assert.equal(slugToTitle('henry-viii'), 'Henry VIII');
  assert.equal(slugToTitle('indian-princesses'), 'Indian Princesses');
  assert.equal(slugToTitle('mix-tape'), 'Mix Tape', 'an ordinary word is not shouted');
  assert.equal(slugToTitle('9-to-5'), '9 To 5');
  const html = '<a href="/whats-on/richard-ii/">x</a><a href="/whats-on/the-seagull/">y</a>';
  assert.deepEqual(extractByRegex(html, { name: 't', linkPattern: /\/whats-on\/[a-z]/ }), ['Richard II', 'The Seagull']);
});
