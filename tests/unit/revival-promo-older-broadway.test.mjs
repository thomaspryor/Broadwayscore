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
//
// Skips when data/shows.json or the private review texts are absent (CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXTS = path.join(ROOT, 'data/review-texts/');
const SHOWS = path.join(ROOT, 'data', 'shows.json');
const PLAN_D = path.join(ROOT, 'data', 'pending-fixes', 'bro-4889-d.json');

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
function withPlanD(rel) {
  let data = read(rel);
  const plan = JSON.parse(fs.readFileSync(PLAN_D, 'utf8'));
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
  for (const rel of MUST_EXCLUDE) assert.ok(verdict(rel), `${rel} would be counted`);
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
