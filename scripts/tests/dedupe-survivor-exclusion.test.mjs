/**
 * dedupe-survivor-exclusion.test.mjs — BRO-5901.
 *
 * rebuild-all-reviews.js let the first copy of a review win dedup, then ran
 * more gates (tour/film contamination, skippedNoScore) on the winner. When the
 * winner died at one of those, the loser had already been skipped and nothing
 * re-promoted it, so the review vanished. Live case, paranormal-activity-2026
 * (2026-08-26): an unscored chicagotribune--chris-jones.json re-ingest shielded
 * the scored nydailynews--chris-jones.json (syndication secondary), then hit
 * skippedNoScore. Rebuild shipped zero Chris Jones reviews.
 *
 * Requires the REAL scripts/lib/dedup-survivor.js and review-guards.js
 * (CLAUDE.md rule 15) and runs the real rebuild on a fixture show dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const {
  createClaimLedger, orderAfterDependencies, primaryFilesFor, unknownOutletShadowTargets,
  syndicationShieldDecision, shadowShieldDecision,
} = require('../lib/dedup-survivor.js');
const { explainExclusion, hasIncludableSyndicationPrimary } = require('../lib/review-guards.js');

const SHOW = 'paranormal-activity-2026';
const body = (n) => Array.from({ length: n }, (_, i) =>
  `The haunted house at the August Wilson Theatre keeps finding new ways to unsettle its audience, and paragraph ${i} of this review of Paranormal Activity on Broadway describes how the stagecraft builds dread.`).join('\n\n');
const base = { showId: SHOW, criticName: 'Chris Jones', publishDate: '2026-08-25', source: 'web-search' };
const NYDN = {
  ...base, outlet: 'New York Daily News', outletId: 'nydailynews',
  url: 'https://www.nydailynews.com/2026/08/25/review-paranormal-activity-broadway/',
  fullText: body(18), assignedScore: 86, llmScore: { score: 86, confidence: 'high' },
};
const TRIB = {
  ...base, outlet: 'Chicago Tribune', outletId: 'chicagotribune',
  url: 'https://www.chicagotribune.com/2026/08/25/review-paranormal-activity-broadway/',
  fullText: body(21),
};

function mkTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5901-'));
  const dir = path.join(root, 'review-texts', SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d, null, 2));
  return { root, texts: path.join(root, 'review-texts'), dir };
}

// ---- ledger ---------------------------------------------------------------

test('ledger: an armed file that is not emitted gives every claim back', () => {
  const keys = new Set(['old']);
  const urls = new Map([['k', 'prev']]);
  const l = createClaimLedger();
  l.begin();
  l.addClaim(keys, 'new');
  l.addClaim(keys, 'old'); // already present: not this file's claim
  l.setClaim(urls, 'k', 'mine'); // swap-to-default style overwrite
  l.setClaim(urls, 'fresh', 'mine');
  l.arm();
  assert.equal(l.rollback(), 3);
  assert.deepEqual([...keys], ['old']);
  assert.deepEqual([...urls], [['k', 'prev']]);
});

test('ledger: a file dropped BY dedup (never armed) keeps its claims, as before', () => {
  const keys = new Set();
  const l = createClaimLedger();
  l.begin();
  l.addClaim(keys, 'a');
  assert.equal(l.rollback(), null);
  assert.ok(keys.has('a'));
});

test('ledger: an emitted file keeps its claims', () => {
  const keys = new Set();
  const l = createClaimLedger();
  l.begin(); l.addClaim(keys, 'a'); l.arm(); l.commit();
  assert.equal(l.rollback(), null);
  assert.ok(keys.has('a'));
});

// ---- ordering and shields ------------------------------------------------

test('order: a scored secondary sorted ahead of an unscored primary moves after it', () => {
  const meta = {
    'nydailynews--chris-jones.json': { criticName: 'Chris Jones', outletKey: 'nydailynews' },
    'chicagotribune--chris-jones.json': { criticName: 'Chris Jones', outletKey: 'chicagotribune' },
    'nytimes--jesse-green.json': { criticName: 'Jesse Green', outletKey: 'nytimes' },
  };
  const sorted = ['nydailynews--chris-jones.json', 'nytimes--jesse-green.json', 'chicagotribune--chris-jones.json'];
  const out = orderAfterDependencies(sorted, (f, list) => primaryFilesFor(f, meta[f], list));
  assert.deepEqual(out, ['nytimes--jesse-green.json', 'chicagotribune--chris-jones.json', 'nydailynews--chris-jones.json']);
});

test('order: publishing-group chain settles (baltimoresun after nydailynews after chicagotribune)', () => {
  const m = (o) => ({ criticName: 'Jane Roe', outletKey: o });
  const meta = { 'baltimoresun--jane-roe.json': m('baltimoresun'), 'nydailynews--jane-roe.json': m('nydailynews'), 'chicagotribune--jane-roe.json': m('chicagotribune') };
  const out = orderAfterDependencies(['baltimoresun--jane-roe.json', 'nydailynews--jane-roe.json', 'chicagotribune--jane-roe.json'],
    (f, list) => primaryFilesFor(f, meta[f], list));
  assert.ok(out.indexOf('chicagotribune--jane-roe.json') < out.indexOf('nydailynews--jane-roe.json'));
  assert.ok(out.indexOf('nydailynews--jane-roe.json') < out.indexOf('baltimoresun--jane-roe.json'));
});

test('order: a dependency cycle cannot hang the reorder', () => {
  const out = orderAfterDependencies(['a', 'b'], (f) => (f === 'a' ? ['b'] : ['a']));
  assert.deepEqual(out.slice().sort(), ['a', 'b']);
});

test('order: an unknown-outlet shadow moves after its named-outlet copy', () => {
  const list = ['unknown--samuel-l-leiter.json', 'theater-life--samuel-l-leiter.json'];
  assert.deepEqual(unknownOutletShadowTargets(list[0], list), ['theater-life--samuel-l-leiter.json']);
  assert.deepEqual(unknownOutletShadowTargets('unknown--unknown.json', list), []);
  assert.deepEqual(orderAfterDependencies(list, unknownOutletShadowTargets), [list[1], list[0]]);
});

test('syndication shield follows what was really emitted', () => {
  const p = ['chicagotribune--chris-jones.json'];
  const never = () => { throw new Error('fallback must not run once the primary was processed'); };
  const none = new Set();
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: p, processed: new Set(p), emitted: none, released: new Set(p), fallback: never }), { skip: false, basis: 'none-emitted' });
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: p, processed: new Set(p), emitted: new Set(p), released: none, fallback: never }), { skip: true, basis: 'emitted' });
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: [], processed: none, emitted: none, released: none, fallback: never }), { skip: false, basis: 'no-primary' });
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: p, processed: none, emitted: none, released: none, fallback: () => true }), { skip: true, basis: 'fallback' });
  // Dropped before dedup finished (lost dedup to another copy, or its own
  // flags): the static predicate over just those files decides.
  const seen = [];
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: p, processed: new Set(p), emitted: none, released: none, fallback: (f) => { seen.push(...f); return true; } }), { skip: true, basis: 'dropped-before-dedup' });
  assert.deepEqual(seen, p);
  assert.deepEqual(syndicationShieldDecision({ primaryFiles: p, processed: new Set(p), emitted: none, released: none, fallback: () => false }), { skip: false, basis: 'dropped-before-dedup' });
});

test('unknown-outlet shadow: only a released named copy stops shielding', () => {
  const t = ['theater-life--x.json'];
  assert.equal(shadowShieldDecision({ targets: t, released: new Set() }), true); // dropped early (duplicateOf) or emitted
  assert.equal(shadowShieldDecision({ targets: t, released: new Set(t) }), false); // won dedup, then died
});

// ---- static rule (explainExclusion / scorer / audits) ---------------------

test('static rule: a primary that is itself excluded does not shield the secondary', () => {
  const { dir } = mkTree({
    'chicagotribune--chris-jones.json': { ...TRIB, fullText: null }, // no text, no score: noTextOrScoreSignal
    'nydailynews--chris-jones.json': NYDN,
  });
  const fp = path.join(dir, 'nydailynews--chris-jones.json');
  assert.equal(hasIncludableSyndicationPrimary(NYDN, null, fp), false);
  assert.notEqual(explainExclusion(NYDN, null, fp), 'knownSyndicationSecondary');
});

test('static rule: an includable primary still shields, scored or not (the scorer must reach it)', () => {
  const { dir } = mkTree({ 'chicagotribune--chris-jones.json': TRIB, 'nydailynews--chris-jones.json': NYDN });
  const fp = path.join(dir, 'nydailynews--chris-jones.json');
  assert.equal(explainExclusion(NYDN, null, fp), 'knownSyndicationSecondary');
  assert.equal(hasIncludableSyndicationPrimary(NYDN, null, fp, { requireScore: true }), false);
});

// ---- end to end: the real rebuild ----------------------------------------

const showsJson = path.join(ROOT, 'data', 'shows.json');
const haveShow = fs.existsSync(showsJson) && fs.readFileSync(showsJson, 'utf8').includes(`"${SHOW}"`);

function rebuild(files) {
  const { root, texts } = mkTree(files);
  const audit = path.join(root, 'audit');
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), `--show=${SHOW}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: audit },
  });
  const included = Number((/(\d+) review\(s\) would be included/.exec(out) || [])[1]);
  const excluded = (out.match(/\[EXCLUSION\] (\{.*\})/g) || []).map(l => JSON.parse(l.slice(12)));
  return { included, excluded };
}

test('rebuild: unscored Tribune primary no longer takes the scored Daily News copy down', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({ 'chicagotribune--chris-jones.json': TRIB, 'nydailynews--chris-jones.json': NYDN });
  assert.equal(r.included, 1);
  assert.deepEqual(r.excluded.map(e => [e.file, e.reason]), [['chicagotribune--chris-jones.json', 'skippedNoScore']]);
});

test('rebuild: a scored Tribune primary still wins and the Daily News copy is skipped', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'chicagotribune--chris-jones.json': { ...TRIB, assignedScore: 84, llmScore: { score: 84, confidence: 'high' } },
    'nydailynews--chris-jones.json': NYDN,
  });
  assert.equal(r.included, 1);
  assert.deepEqual(r.excluded.map(e => [e.file, e.reason]), [['nydailynews--chris-jones.json', 'skippedSyndicated']]);
});

test('rebuild: a primary that lost dedup to another copy still shields the Daily News copy', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  // A second Tribune file under a variant byline wins the fuzzy-critic dedup,
  // so the real primary is processed but never emitted or released. The
  // review already ships once; the Daily News copy must not count Chris
  // Jones twice (ship-check finding on the first BRO-5901 cut).
  const scored = { assignedScore: 84, llmScore: { score: 84, confidence: 'high' } };
  const r = rebuild({
    'chicagotribune--c-jones.json': { ...TRIB, ...scored, criticName: 'C. Jones', url: `${TRIB.url}?amp=1`, fullText: body(24) },
    'chicagotribune--chris-jones.json': { ...TRIB, ...scored },
    // Syndicated copies are often re-edited, so fingerprint dedup cannot be
    // relied on to catch this one.
    'nydailynews--chris-jones.json': { ...NYDN, fullText: NYDN.fullText.replace(/haunted house/g, 'spooky home').replace(/stagecraft builds dread/g, 'design keeps everyone on edge') },
  });
  assert.equal(r.included, 1);
  assert.ok(r.excluded.some(e => e.file === 'nydailynews--chris-jones.json' && e.reason === 'skippedSyndicated'), JSON.stringify(r.excluded));
});
