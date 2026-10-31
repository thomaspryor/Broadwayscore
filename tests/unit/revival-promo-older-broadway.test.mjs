// Older Broadway pages behind upcoming revivals (BRO-4889).
//
// The filing audit found other productions' reviews counted on older pages
// (the 2011 Vulture Private Lives review on the 1975/1983/1992/2002 pages, the
// 2013 Washington Post Cat review on the 2003 page, the 2008 National Theatre
// Osage reviews on the Broadway 2007 page), junk rows (an NYT topics page, a
// doubled Variety credit) and genuine reviews excluded by false
// wrong-production verdicts. Plans bro-4889, -b, -c and -d fixed them in
// data/review-texts; this test reads those source files and asks the real
// inclusion gate (review-guards.explainExclusion) what the rebuild will do.
//
// Plan -d is applied in memory with the real applyReviewFieldEdit when the
// files do not carry it yet, so the test holds before and after the plan runs
// (and fails if the plan stops applying cleanly).
// BRO-5839 replays the five National Theatre moves on temporary copies using
// the actual field-edit, add-show and move writers. It also holds after the
// pending plan is applied to the private repositories.
//
// Skips when data/shows.json or the private review texts are absent (CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXTS = path.join(ROOT, 'data/review-texts/');
const SHOWS = path.join(ROOT, 'data', 'shows.json');
const PLAN_D = path.join(ROOT, 'data', 'pending-fixes', 'bro-4889-d.json');
const PLAN_E = path.join(ROOT, 'data', 'pending-fixes', 'bro-4889-e.json');
const PLAN_REHOME = path.join(ROOT, 'data', 'pending-fixes', 'bro-5839.json');
const NATIONAL = 'august-osage-county-national-theatre-west-end-2008';

const { explainExclusion, getWrongProductionReasonFromUrl } = require('../../scripts/lib/review-guards.js');
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');

const probe = path.join(TEXTS, 'private-lives-2002', 'vulture--scott-brown.json');
const SKIP = !fs.existsSync(SHOWS) ? 'data/shows.json absent'
  : !fs.existsSync(probe) ? 'private review texts absent (data/review-texts)' : false;

let showsById = null;
function show(id) {
  if (!showsById) {
    const raw = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
    showsById = new Map((Array.isArray(raw) ? raw : raw.shows).map((s) => [s.id, s]));
  }
  const s = showsById.get(id);
  assert.ok(s, `show ${id} missing from shows.json`);
  return s;
}
const read = (rel) => JSON.parse(fs.readFileSync(path.join(TEXTS, rel), 'utf8'));
const verdict = (rel, data = read(rel)) =>
  explainExclusion(data, show(rel.split('/')[0]), path.join('data/review-texts', rel));

// Plan -d's edits for one file, applied in memory unless already on disk.
function withPlanD(rel, planFile = PLAN_D) {
  let data = read(rel);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const action of plan.plan.actions.filter((a) => a.file === rel)) {
    const current = data[action.field] === undefined ? null : data[action.field];
    if (JSON.stringify(current) === JSON.stringify(action.newValue)) continue; // already applied
    const res = applyReviewFieldEdit(data, action, new Date().toISOString(), { folder: rel.split('/')[0] });
    assert.ok(res.ok, `${rel} ${action.field}: ${res.reason}`);
    data = res.record;
  }
  return data;
}

const MUST_EXCLUDE = [
  // the 2011 Paul Gross / Kim Cattrall Vulture review on four older pages
  'private-lives-2002/vulture--scott-brown.json',
  'private-lives-1992/vulture--scott-brown.json',
  'private-lives-1983/vulture--scott-brown.json',
  'private-lives-1975/vulture--scott-brown.json',
  // 2013 Johansson review text on the 2003 page
  'cat-on-a-hot-tin-roof-2003/washpost--peter-marks.json',
  // 2008 National Theatre (Lyttelton) reviews on the Broadway page
  'august-osage-county-2007/financialtimes--sarah-hemming.json',
  'august-osage-county-2007/independent--michaelcoveney.json',
  // junk: NYT topics page, doubled Variety credit, preview blurb, letters page
  'evita-2012/ricky-martin--unknown.json',
  'evita-2012/variety--marilyn-stasio.json',
  'three-days-of-rain-2006/usatoday--elysa-gardner.json',
  'cat-on-a-hot-tin-roof-2008/latimes--charles-mcnulty-bway.json',
];

const MUST_INCLUDE = [
  'evita-1979/nytimes--ben-brantley.json',
  'evita-2012/amny--matt-windman.json',
  'evita-2012/backstage--david-sheward.json',
  'evita-2012/ew--melissa-rose-bernardo.json',
  'evita-2012/philadelphia-inquirer--howard-shapiro.json',
  'cat-on-a-hot-tin-roof-2013/nypost--elisabeth-vincentelli.json',
  'cat-on-a-hot-tin-roof-2013/vulture--scott-brown.json',
  'cat-on-a-hot-tin-roof-2013/financialtimes--brendan-lemon.json',
  'private-lives-2011/vulture--scott-brown.json',
  'august-osage-county-2007/newyorker--hilton-als.json',
];

// Genuine reviews plan -d releases.
const PLAN_D_INCLUDE = [
  'cat-on-a-hot-tin-roof-2013/nytimes--ben-brantley.json',
  'august-osage-county-2007/theatermania--unknown.json',
  'private-lives-2011/nydailynews--joe-dziemianowicz.json',
];

test('other productions\' reviews and junk rows stay out of older pages', { skip: SKIP }, () => {
  for (const rel of MUST_EXCLUDE) {
    if (rel === 'evita-2012/ricky-martin--unknown.json' && !fs.existsSync(path.join(TEXTS, rel))) continue; // junk row deleted outright
    if (rel.startsWith('august-osage-county-2007/') && !fs.existsSync(path.join(TEXTS, rel))) {
      const moved = `${NATIONAL}/${path.basename(rel)}`;
      assert.equal(verdict(moved), null, `${moved} excluded after rehoming`);
      continue;
    }
    assert.ok(verdict(rel), `${rel} would be counted`);
  }
});

// Keep the plan's identity check active even when private data is absent in CI.
test('BRO-5839 uses one valid West End identity for the show and every move', () => {
  const { marketSuffixMismatch } = require('../../scripts/lib/show-id-market-suffix.js');
  const plan = JSON.parse(fs.readFileSync(PLAN_REHOME, 'utf8'));
  const added = plan.plan.actions.find(a => a.type === 'add-show').show;
  assert.equal(added.id, NATIONAL);
  assert.equal(added.slug, NATIONAL);
  assert.equal(added.category, 'west-end');
  assert.equal(added.market, 'west-end');
  assert.equal(marketSuffixMismatch(added), null);
  const moves = plan.plan.actions.filter(a => a.type === 'review-file-op');
  assert.equal(moves.length, 5);
  for (const move of moves) assert.equal(path.dirname(move.destPath), added.id);
});

test('BRO-5839 rehomes exactly five National Theatre reviews through the real writers', { skip: SKIP }, () => {
  const { applyAddShow } = require('../../scripts/lib/add-show-action.js');
  const { executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit.js');
  const { moveReviewFile } = require('../../scripts/lib/review-file-move.js');
  const plan = JSON.parse(fs.readFileSync(PLAN_REHOME, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
  const shows = structuredClone(Array.isArray(raw) ? raw : raw.shows);
  const beforeShows = structuredClone(shows);
  const oldId = 'august-osage-county-2007';
  const expectedFiles = [
    'express-uk--markshenton.json', 'financialtimes--sarah-hemming.json',
    'independent--michaelcoveney.json', 'observer--susannah-clapp.json',
    'sunday-telegraph--timauld.json',
  ];
  const moves = plan.plan.actions.filter(a => a.type === 'review-file-op');
  assert.deepEqual(moves.map(a => path.basename(a.sourcePath)).sort(), expectedFiles);
  const alreadyMoved = moves.every(a => !fs.existsSync(path.join(TEXTS, a.sourcePath))
    && fs.existsSync(path.join(TEXTS, a.destPath)));
  assert.deepEqual(plan.plan.actions.map(a => a.type), [
    'add-show',
    ...expectedFiles.flatMap(() => ['review-field-edit', 'review-field-edit', 'review-file-op']),
  ], 'every action must run through an add-show, field-edit or move writer');
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-bro-5839-'));
  try {
    // Copy only the two affected folders. Never write the private mount.
    for (const id of [oldId, NATIONAL]) {
      if (fs.existsSync(path.join(TEXTS, id))) fs.cpSync(path.join(TEXTS, id), path.join(tmp, id), { recursive: true });
    }
    const originals = new Map(moves.map(a => [a.destPath,
      read(alreadyMoved ? a.destPath : a.sourcePath)]));
    if (!alreadyMoved) {
      for (const action of moves) {
        assert.ok(verdict(action.sourcePath), `${action.sourcePath} unexpectedly counted before rehoming`);
      }
    }
    const unchanged = new Map(fs.readdirSync(path.join(tmp, oldId))
      .filter(f => !expectedFiles.includes(f))
      .map(f => [f, fs.readFileSync(path.join(tmp, oldId, f))]));
    if (!alreadyMoved) {
      for (const action of plan.plan.actions) {
        let result;
        if (action.type === 'add-show') result = applyAddShow(shows, action);
        else if (action.type === 'review-field-edit') {
          result = executeReviewFieldEditIn(tmp, action, { fixId: plan.planId, at: plan.createdAt });
        } else if (action.type === 'review-file-op') {
          assert.equal(action.operation, 'move');
          result = moveReviewFile(tmp, action.sourcePath, action.destPath);
        } else assert.fail(`Unexpected action ${action.type}`);
        assert.ok(result.ok, `${action.type}: ${result.reason}`);
      }
      const changed = beforeShows.filter(s => JSON.stringify(s) !== JSON.stringify(shows.find(after => after.id === s.id)));
      assert.deepEqual(changed, []);
      assert.equal(shows.length, beforeShows.length + 1);
    }
    const national = shows.find(s => s.id === NATIONAL);
    assert.ok(national, 'the review destination must have a show entry');
    assert.equal(national.category, 'west-end');
    assert.equal(national.market, 'west-end');
    assert.equal(national.venue, 'Lyttelton Theatre');
    assert.equal(national.previewsStartDate, '2008-11-21');
    assert.equal(national.openingDate, '2008-11-26');
    assert.equal(national.closingDate, '2009-01-21');
    for (const action of moves) {
      assert.ok(!fs.existsSync(path.join(tmp, action.sourcePath)), `${action.sourcePath} left behind`);
      const moved = JSON.parse(fs.readFileSync(path.join(tmp, action.destPath), 'utf8'));
      const original = originals.get(action.destPath);
      assert.equal(moved.showId, NATIONAL);
      for (const field of ['fullText', 'assignedScore', 'originalScore', 'humanReviewScore', 'llmScore', 'publishDate', 'criticName', 'url']) {
        assert.deepEqual(moved[field], original[field], `${action.destPath}: ${field} changed`);
      }
      assert.equal(explainExclusion(moved, national, path.join(tmp, action.destPath)), null, `${action.destPath} still excluded`);
    }
    for (const [file, contents] of unchanged) {
      assert.deepEqual(fs.readFileSync(path.join(tmp, oldId, file)), contents, `${file} unexpectedly changed`);
    }
    const broadway = shows.find(s => s.id === oldId);
    assert.equal(broadway.venue, 'Music Box Theatre');
    assert.equal(broadway.previewsStartDate, '2007-10-30');
    console.log('BRO-5839 real-data replay: 5 reviews excluded on Broadway before, 5 included on the new National Theatre page after; 1 show added; all 16 actions use real writers; unrelated records unchanged. Examples: FT, Independent, Observer.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('genuine reviews cleared of false wrong-production verdicts are counted', { skip: SKIP }, () => {
  for (const rel of MUST_INCLUDE) assert.equal(verdict(rel), null, `${rel} excluded`);
});

test('plan bro-4889-d releases the remaining genuine reviews', { skip: SKIP }, () => {
  for (const rel of PLAN_D_INCLUDE) assert.equal(verdict(rel, withPlanD(rel)), null, `${rel} still excluded`);
  const dn = withPlanD('private-lives-2011/nydailynews--joe-dziemianowicz.json');
  assert.equal(dn.humanReviewScore, 45, 'Daily News Private Lives keeps the 80 score from a negative text');
});

test('plan bro-4889-d drops the 2013 Johansson excerpts from the 2008 NYT review', { skip: SKIP }, () => {
  const d = withPlanD('cat-on-a-hot-tin-roof-2008/nytimes--ben-brantley.json');
  for (const f of ['dtliExcerpt', 'showScoreExcerpt']) {
    assert.ok(!/Johansson/.test(String(d[f] || '')), `${f} still quotes the 2013 production`);
  }
});

test('URL year that matches the production raises no wrong-production verdict; another production\'s does', { skip: SKIP }, () => {
  const { url } = read('cat-on-a-hot-tin-roof-2013/nytimes--ben-brantley.json');
  assert.equal(getWrongProductionReasonFromUrl(url, show('cat-on-a-hot-tin-roof-2013')), null);
  assert.ok(getWrongProductionReasonFromUrl(url, show('cat-on-a-hot-tin-roof-2003')));
});

// Plan -e: other-production reviews the sibling-cast audit and a re-read of the Osage page still found counted.
test('plan bro-4889-e excludes the 2012 Cumming Macbeth review and the 2008 Osage replacement-cast piece', { skip: SKIP }, () => {
  for (const rel of [
    'macbeth-2008/hollywood-reporter--david-rooney.json',
    'august-osage-county-2007/nytimes--charles-isherwood.json',
  ]) {
    assert.ok(verdict(rel, withPlanD(rel, PLAN_E)), `${rel} would still be counted`);
  }
});

// The tests above need the private review texts, so on a fresh checkout (the Done gate, CI)
// they all skip. These need only core data (data/shows.json, data/reviews.json), which the
// acceptance checkout copies in: they check what the site actually counts after the rebuild,
// and run the real write-time cross-production cast guard (BRO-5499) on these titles.
const REVIEWS = path.join(ROOT, 'data', 'reviews.json');
const CORE_SKIP = !fs.existsSync(SHOWS) ? 'data/shows.json absent'
  : !fs.existsSync(REVIEWS) ? 'data/reviews.json absent' : false;

let counted = null;
function rows(showId) {
  if (!counted) {
    const raw = JSON.parse(fs.readFileSync(REVIEWS, 'utf8'));
    counted = Array.isArray(raw) ? raw : raw.reviews;
  }
  assert.ok(show(showId), `${showId} is not in shows.json (renamed?), so its checks would pass vacuously`);
  return counted.filter((r) => r.showId === showId);
}
const has = (showId, re, field = 'outlet') => rows(showId).filter((r) => re.test(String(r[field] || '')));

test('reviews.json: other productions\' reviews are not counted on the older pages', { skip: CORE_SKIP }, () => {
  for (const id of ['private-lives-1975', 'private-lives-1983', 'private-lives-1992', 'private-lives-2002']) {
    assert.deepEqual(has(id, /vulture/i), [], `${id} counts the 2011 Vulture review`);
  }
  assert.deepEqual(has('cat-on-a-hot-tin-roof-2003', /washington post/i), [], 'Cat 2003 counts the 2013 WaPo review');
  assert.deepEqual(has('august-osage-county-2007', /financial times|independent|express|telegraph/i), [],
    'Osage 2007 counts a 2008 National Theatre review');
  // "Observer" is also the New York Observer, a genuine Broadway outlet: only the UK paper is a contaminant.
  assert.deepEqual(has('august-osage-county-2007', /observer/i).filter((r) => /theguardian\.com|observer\.co\.uk/.test(r.url || '')), [],
    'Osage 2007 counts the London Observer review');
  assert.deepEqual(has('august-osage-county-2007', /^2008-07/, 'publishDate'), [], 'Osage 2007 counts the July 2008 replacement-cast piece');
});

test('reviews.json: Evita 2012 junk and duplicate rows are gone, Dreamgirls 1981 is the AP rave', { skip: CORE_SKIP }, () => {
  assert.deepEqual(has('evita-2012', /ricky martin/i), [], 'NYT topics page counted as an outlet');
  const variety = has('evita-2012', /variety/i);
  assert.equal(variety.length, 1, 'Variety counted more than once');
  assert.equal(variety[0].criticName, 'Steven Suskin');
  assert.deepEqual(has('evita-2012', /jesse green/i, 'criticName'), [], 'Vulture review credited to Jesse Green');
  assert.deepEqual(has('evita-2012', /thom geier/i, 'criticName'), [], 'textless EW row counted');
  assert.equal(has('evita-1979', /new york times/i).length, 1, 'genuine 1979 NYT review dropped');
  const dg = rows('dreamgirls-1981');
  assert.ok(dg.some((r) => r.outlet === 'Associated Press' && r.criticName === 'Mary Campbell' && r.assignedScore >= 71),
    'Dreamgirls 1981 AP Mary Campbell rave missing or under-scored');
  assert.deepEqual(dg.filter((r) => /douglas watt/i.test(r.criticName || '')), [], 'AP wire story still credited to Douglas Watt');
});

test('reviews.json: genuine reviews cleared of false verdicts are counted', { skip: CORE_SKIP }, () => {
  const want = [
    ['evita-2012', /amnewyork/i], ['evita-2012', /backstage/i], ['evita-2012', /entertainment weekly/i],
    ['evita-2012', /philadelphia inquirer/i],
    ['cat-on-a-hot-tin-roof-2013', /new york times/i], ['cat-on-a-hot-tin-roof-2013', /new york post/i],
    ['cat-on-a-hot-tin-roof-2013', /vulture/i], ['cat-on-a-hot-tin-roof-2013', /financial times/i],
    ['private-lives-2011', /vulture/i], ['private-lives-2011', /daily news/i],
    ['august-osage-county-2007', /new yorker/i], ['august-osage-county-2007', /theatermania/i],
  ];
  for (const [id, re] of want) assert.ok(has(id, re).length >= 1, `${id} ${re} not counted`);
  const dn = has('private-lives-2011', /daily news/i)[0];
  assert.ok(dn.assignedScore <= 60, `Private Lives 2011 Daily News scored ${dn.assignedScore} on a negative review`);
  assert.equal(has('cat-on-a-hot-tin-roof-2013', /usa today/i)[0]?.publishDate, '2013-01-17');
});

// Write-time prevention (scripts/lib/review-file-writer.js Guard L): run the real writer
// against the real shows.json entries in a temp dir. Never touches data/review-texts.
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
const filler = 'The staging moves briskly and the design is handsome, though the second act sags. ';
function writeReview(showId, names, url, outletId = 'vulture', outlet = 'Vulture') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4889-'));
  try {
    const res = createOrMergeReviewFile(showId, {
      outletId, outlet, criticName: 'Unknown', url,
      source: 'submit-review-form',
      fields: { fullText: `${names} lead the cast. ${filler.repeat(8)}${names} are the reason to go.` },
    }, { reviewTextsDir: dir });
    assert.equal(res && res.action, 'new', `write refused: ${JSON.stringify(res)}`);
    const folder = path.join(dir, showId);
    return JSON.parse(fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a review naming another production\'s cast is stamped wrongProduction and excluded', { skip: CORE_SKIP }, () => {
  // The 2011 Paul Gross / Kim Cattrall review filed on the 2002 Rickman / Duncan page.
  const d = writeReview('private-lives-2002', 'Kim Cattrall and Paul Gross', 'https://www.vulture.com/theater/private-lives-test-a.html');
  assert.equal(d.wrongProduction, true);
  assert.match(d.wrongProductionReason, /private-lives-2011/);
  assert.ok(explainExclusion(d, show('private-lives-2002'), 'data/review-texts/private-lives-2002/x.json'));
  // The 2013 Johansson review filed on the 2003 Ashley Judd page.
  const c = writeReview('cat-on-a-hot-tin-roof-2003', 'Scarlett Johansson and Ciarán Hinds', 'https://www.vulture.com/theater/cat-test-b.html');
  assert.equal(c.wrongProduction, true);
  assert.match(c.wrongProductionReason, /cat-on-a-hot-tin-roof-2013/);
  assert.ok(explainExclusion(c, show('cat-on-a-hot-tin-roof-2003'), 'data/review-texts/cat-on-a-hot-tin-roof-2003/x.json'));
});

test('no wrongProduction flag when URL year and cast match the production', { skip: CORE_SKIP }, () => {
  const url = 'https://www.nytimes.com/2013/01/18/theater/reviews/cat-on-a-hot-tin-roof-test.html';
  assert.equal(getWrongProductionReasonFromUrl(url, show('cat-on-a-hot-tin-roof-2013')), null);
  assert.ok(getWrongProductionReasonFromUrl(url, show('cat-on-a-hot-tin-roof-2003')), 'a 2013 URL on the 2003 page must be caught');
  const d = writeReview('cat-on-a-hot-tin-roof-2013', 'Scarlett Johansson and Ciarán Hinds', url, 'nytimes', 'The New York Times');
  assert.notEqual(d.wrongProduction, true, `stale flag: ${d.wrongProductionReason}`);
  const p = writeReview('private-lives-2011', 'Kim Cattrall and Paul Gross', 'https://www.nytimes.com/2011/11/18/theater/reviews/private-lives-test.html', 'nytimes', 'The New York Times');
  assert.notEqual(p.wrongProduction, true, `stale flag: ${p.wrongProductionReason}`);
});

// Plan bro-4889-f corrects two Evita bylines (verified on the outlet pages). The rows are asserted
// once the executor recorded status "applied" and reviews.json was scanned 15+ minutes later (the
// review-texts push lands after executedAt is stamped); before that, only the plan's shape.
test('plan bro-4889-f: Evita bylines are David Finkle (TheaterMania 2012) and Walter Kerr (NYT 1979)', { skip: CORE_SKIP }, (t) => {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pending-fixes', 'bro-4889-f.json'), 'utf8'));
  assert.deepEqual(plan.plan.actions.map((a) => [a.file, a.field, a.newValue]), [
    ['evita-2012/theatermania--david-rooney.json', 'criticName', 'David Finkle'],
    ['evita-1979/nytimes--ben-brantley.json', 'criticName', 'Walter Kerr'],
  ]);
  const meta = JSON.parse(fs.readFileSync(REVIEWS, 'utf8'))._meta || {};
  const rebuiltAfter = plan.status === 'applied' && plan.executedAt
    && Date.parse(meta.reviewTextsScannedAt || 0) > Date.parse(plan.executedAt) + 15 * 60 * 1000;
  if (!rebuiltAfter) {
    // A rebuild runs at least every few hours, so an applied plan still unscanned after two days is a real failure.
    const stale = plan.status === 'applied' && Date.now() - Date.parse(plan.executedAt) > 48 * 3600 * 1000;
    assert.ok(!stale, `plan applied ${plan.executedAt} but reviews.json last scanned ${meta.reviewTextsScannedAt}`);
    t.skip('waiting for a reviews.json rebuild after the plan was applied');
    return;
  }
  const tm = has('evita-2012', /theatermania/i);
  assert.ok(tm.some((r) => r.criticName === 'David Finkle'), 'Evita 2012 TheaterMania not credited to David Finkle');
  assert.ok(!tm.some((r) => r.criticName === 'David Rooney'), 'Evita 2012 TheaterMania still credited to David Rooney');
  const nyt = has('evita-1979', /new york times/i);
  assert.ok(nyt.some((r) => r.criticName === 'Walter Kerr'), 'Evita 1979 NYT not credited to Walter Kerr');
  assert.ok(!nyt.some((r) => r.criticName === 'Ben Brantley'), 'Evita 1979 NYT still credited to Ben Brantley');
});
