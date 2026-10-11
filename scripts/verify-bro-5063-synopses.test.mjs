/**
 * verify-bro-5063-synopses.test.mjs — acceptance for BRO-5063 (synopses
 * holding Wikipedia scrape debris or producer pitch copy). Asserts against
 * LIVE data/shows.json, not fixtures: a red run means a listed row still
 * reads as debris, pitch or billing, or a cleared row was never refilled.
 *
 * Skips until every data/pending-fixes/bro-5063*.json part has been run by
 * execute-approved-fix.yml (land.js runs every changed *.test.mjs, before
 * the data fix exists).
 *
 * timebomb-audit-exempt: probe of live core data after a one-off data fix; no clock-dependent assertion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { synopsisStoryProblems } = require('./lib/synopsis-story-audit.js');
const { nonStoryReason } = require('./lib/todaytix-page-identity.js');

// The 29 rows the card named (BRO-4884 replay, 2026-10-11).
const CARD_ROWS = [
  'hay-fever-1985', 'hay-fever-1970', 'taking-sides-1996', 'lestat-2006', 'chita-rivera-the-dancers-life-2005',
  'little-me-1982', 'betrayal-1980', 'amahl-and-the-night-visitors-1970', 'the-merchant-1977', 'woman-of-the-year-1981',
  'noises-off-2001', 'doonesbury-1983', 'schmigadoon-2026', 'mr-saturday-night-2022', 'rock-n-roll-the-first-5000-years-1982',
  'the-misanthrope-west-end-2026', 'the-comedy-about-spies-west-end-2026', 'the-truth-a-comedy-by-florian-zeller-west-end-2027',
  'ceilidh-the-musical-off-west-end-2026', 'queen-of-hearts-off-broadway-2026', 'dr-seuss-how-the-grinch-stole-christmas-2007',
  'dr-seuss-how-the-grinch-stole-christmas-tour-2026', 'twelfth-night-2013', 'tender-by-dave-harris-off-west-end-2026',
  'my-sons-a-queer-but-what-can-you-do-west-end-2026', 'truly-howard-hughes-off-broadway-2026',
  'paranormal-activity-national-tour-regional-2025', 'three-men-in-a-boat-off-west-end-2026', 'the-estate-west-end-2025',
];

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
// The plan is split into parts of at most 25 actions (bro-5063, -b, -c).
const PLAN_DIR = path.join(ROOT, 'data', 'pending-fixes');
const planFiles = () => (fs.existsSync(PLAN_DIR) ? fs.readdirSync(PLAN_DIR) : []).filter(f => /^bro-5063(-[a-z])?\.json$/.test(f));
const plans = () => planFiles().map(f => readJson(`data/pending-fixes/${f}`));
const NO_DATA = fs.existsSync(path.join(ROOT, 'data', 'shows.json')) ? false : 'no core-data checkout here';
// Runs once the executor wrote to shows.json: 'applied', or 'partial' when
// some actions were refused. Pending, rejected or rolled-back plans skip.
const RAN = new Set(['applied', 'partial']);
const PENDING = NO_DATA || (planFiles().length && plans().every(p => RAN.has(p.status))
  ? false : 'waits for execute-approved-fix.yml to apply every data/pending-fixes/bro-5063*.json part');

const showsById = () => {
  const data = readJson('data/shows.json');
  return new Map((Array.isArray(data) ? data : data.shows).map(s => [s.id, s]));
};
const planActions = () => plans().flatMap(p => p.plan.actions);
const planRows = () => planActions().map(a => a.showId);

test('no card or plan row still holds wikitext debris or audience pitch', { skip: PENDING }, () => {
  const byId = showsById();
  const bad = [...new Set([...CARD_ROWS, ...planRows()])]
    .map(id => [id, byId.get(id)])
    .filter(([, s]) => s && synopsisStoryProblems(s, nonStoryReason).hard.length)
    .map(([id, s]) => `${id}: ${synopsisStoryProblems(s, nonStoryReason).hard.join(', ')}`);
  assert.deepEqual(bad, []);
});

test('no card row opens on a press quote, billing, pitch or fragment', { skip: PENDING }, () => {
  const byId = showsById();
  const bad = CARD_ROWS
    .map(id => [id, byId.get(id)])
    .filter(([, s]) => s && synopsisStoryProblems(s, nonStoryReason).soft.length)
    .map(([id, s]) => { const f = synopsisStoryProblems(s, nonStoryReason).soft[0]; return `${id} [${f.reason}] ${f.sentence.slice(0, 100)}`; });
  assert.deepEqual(bad, []);
});

test('every row the plan cleared, and the Grinch tour, has a synopsis again', { skip: PENDING }, () => {
  const byId = showsById();
  const cleared = planActions().filter(a => a.newValue === null).map(a => a.showId);
  const empty = [...cleared, 'dr-seuss-how-the-grinch-stole-christmas-tour-2026']
    .filter(id => byId.has(id) && !(typeof byId.get(id).synopsis === 'string' && byId.get(id).synopsis.trim()));
  assert.deepEqual(empty, [], 'cleared and not refilled: dispatch backfill-historical-metadata.yml with shows=<these ids>');
});
