// BRO-7296: verifier-flagged wrong-production reviews are held at build time, not at email time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { decideCvWrongProductionHold, buildGrandfatherSet } = require('../../scripts/lib/cv-wrongproduction-build-gate.js');

const show = { id: 'blueberries-2026', title: 'Blueberries', openingDate: '2026-11-09', category: 'Broadway' };
const grandfather = buildGrandfatherSet([{ showId: 'other-show', url: 'https://x.test/old', outletId: 'nyt', criticName: 'Old Critic' }]);
// The Blueberries shape: CV says wrong production (high), the dateless hold was released by the rebuild's STRING stamp.
const released = () => ({
  url: 'https://cititour.com/1232', outletId: 'cititour', criticName: 'Brian Scott Lipton',
  publishDate: '2024-03-01', fullText: 'now at New York Theatre Workshop',
  wrongProduction: false,
  wrongProductionAutoCleared: 'rebuild: dateless-revival hold released (was: Dateless revival hold)',
  contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'review of the 2024 NYTW production', issues: ['different production'] },
});
const decide = (d, extra = {}) => decideCvWrongProductionHold(d, show, { showId: show.id, filePath: '/nonexistent/f.json', grandfather, ...extra });

test('CV wrongProduction + released dateless hold (string auto-clear) + no clear flag is held', () => {
  const r = decide(released());
  assert.equal(r.hold, true);
  assert.equal(r.reason, 'cv-wrongproduction-unhandled');
});

test('a boolean human/curator clear flag lets it ship', () => {
  for (const f of ['humanReviewedWrongProduction', 'wrongProductionManualClear', 'wrongProductionAutoCleared']) {
    const d = released(); d[f] = true;
    assert.equal(decide(d).hold, false, f);
  }
});

test('rows already live in the previous reviews.json are grandfathered (no live score moves)', () => {
  const d = released();
  const gf = buildGrandfatherSet([{ showId: show.id, url: d.url, outletId: d.outletId, criticName: d.criticName }]);
  assert.deepEqual(decide(d, { grandfather: gf }), { hold: false, reason: 'grandfathered' });
  // A URL-bearing file is recognised by url only: a different-url file from the same critic is NEW and held.
  const sameCriticOtherUrl = buildGrandfatherSet([{ showId: show.id, url: 'https://elsewhere', outletId: d.outletId, criticName: d.criticName }]);
  assert.equal(decide(d, { grandfather: sameCriticOtherUrl }).hold, true);
  // A url-less file falls back to outlet+critic, including a live row whose critic was dropped (null).
  const noUrl = () => { const x = released(); delete x.url; return x; };
  const liveByOc = buildGrandfatherSet([{ showId: show.id, url: 'https://live', outletId: 'cititour', criticName: 'Brian Scott Lipton' }]);
  assert.equal(decide(noUrl(), { grandfather: liveByOc }).hold, false);
  const liveNullCritic = buildGrandfatherSet([{ showId: show.id, outletId: 'cititour', criticName: null }]);
  assert.equal(decide(noUrl(), { grandfather: liveNullCritic }).hold, false);
  // A url-bearing, different-url file is NEW even when a url-less live row has the same outlet+critic
  // (the later dedup would let the newer wrong-production row replace the live one).
  const liveNoUrl = buildGrandfatherSet([{ showId: show.id, url: '', outletId: 'cititour', criticName: 'Brian Scott Lipton' }]);
  assert.equal(decide(d, { grandfather: liveNoUrl }).hold, true);
  // Normalisers are applied on both sides (live rows hold canonical ids, files hold raw ones).
  const norm = { outlet: (o) => String(o).toLowerCase().replace(/[^a-z]/g, ''), critic: (c) => String(c).toLowerCase().trim() };
  const gfN = buildGrandfatherSet([{ showId: show.id, outletId: 'Citi-Tour', criticName: ' BRIAN SCOTT LIPTON ' }], norm);
  assert.equal(decide(noUrl(), { grandfather: gfN, normalizers: norm }).hold, false);
  // same url on a different show does not grandfather
  const otherShow = buildGrandfatherSet([{ showId: 'another', url: d.url, outletId: d.outletId, criticName: d.criticName }]);
  assert.equal(decide(d, { grandfather: otherShow }).hold, true);
});

test('no CV verdict, or CV not wrongProduction, is never held', () => {
  const d = released(); d.contentVerification.wrongProduction = false;
  assert.equal(decide(d).hold, false);
  delete d.contentVerification;
  assert.equal(decide(d).hold, false);
});

test("the rebuild's deliberate keeps are honoured", () => {
  for (const c of ['advisory', 'venueCarveout', 'ownCast', 'lane']) {
    assert.equal(decide(released(), { carveouts: { [c]: true } }).hold, false, c);
  }
  assert.equal(decide({ ...released(), allowEarlyDate: true }).hold, false);
});

test('no previous reviews.json (grandfather null) stands the gate down instead of mass-holding', () => {
  assert.equal(decide(released(), { grandfather: null }).hold, false);
});

test('rebuild-all-reviews.js asks the gate and excludes (wiring guard: fails if the call is removed)', () => {
  const src = fs.readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /cvWpBuildGate\.decideCvWrongProductionHold\(/);
  assert.match(src, /logExclusion\("skippedCvWrongProductionHeld"/);
});

test("the gate's default mode is enforce (a silent flip to advisory would turn the hold off in production)", () => {
  const src = fs.readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.CV_WP_BUILD_GATE \|\| 'enforce'/);
});

// BRO-7310: aliased/typo critic. Live row stores the display name ("Ben Brantley"); the url-less
// review-texts file holds the raw byline ("Ben Brantly"). normalizeCriticName alone never joined them.
test('BRO-7310: url-less file with an aliased critic byline is grandfathered against the live display name', () => {
  const noUrl = { outletId: 'nytimes', criticName: 'Ben Brantly', contentVerification: released().contentVerification,
    wrongProduction: false, wrongProductionAutoCleared: 'rebuild: dateless-revival hold released (was: x)' };
  const live = buildGrandfatherSet([{ showId: show.id, url: 'https://live', outletId: 'nytimes', criticName: 'Ben Brantley' }]);
  assert.equal(decide(noUrl, { grandfather: live }).hold, false);
  const otherCritic = buildGrandfatherSet([{ showId: show.id, url: 'https://live', outletId: 'nytimes', criticName: 'Jesse Green' }]);
  assert.equal(decide(noUrl, { grandfather: otherCritic }).hold, true);
});

// BRO-7310 class test: the rebuild's / scripts' wrongProductionAutoCleared stamps are STRINGS. Every writer in
// the tree that assigns a non-boolean stamp must still be held by the gate, and the gate/check must only read
// clear flags with `=== true`.
test('BRO-7310: no writer\'s string stamp clears the CV gate; clear flags are read with === true', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const files = ['scripts/rebuild-all-reviews.js', 'scripts/unflag-wrong-production-fps.js', 'scripts/autoclear-stale-flags.js',
    'scripts/video-reviews/verify-productions.js', 'scripts/lib/consent-refetch.js', 'scripts/lib/stale-flag-neutralization.js',
    'scripts/lib/review-file-move.js', 'scripts/lib/multi-show-isolation-plan.js', 'scripts/lib/automated-clear-not-manual.js'];
  let stamps = 0;
  for (const f of files) {
    const src = fs.readFileSync(root + f, 'utf8');
    const m = src.match(/\.wrongProductionAutoCleared\s*=\s*[^;]+;/g) || [];
    assert.ok(m.length > 0, `${f}: expected at least one wrongProductionAutoCleared writer`);
    for (const stmt of m) {
      assert.ok(!/=\s*true\s*;/.test(stmt), `${f}: writes boolean true: ${stmt}`);
      stamps++;
    }
  }
  assert.ok(stamps >= 20, `found only ${stamps} writer statements`);
  for (const stamp of ['rebuild: x', 'shadow-gated-contradiction', 'unflag-fps: y', 'verify-productions: z', 'collect-review-texts: w', 1, {}, []]) {
    const d = released(); d.wrongProductionAutoCleared = stamp;
    assert.equal(decide(d).hold, true, `stamp ${JSON.stringify(stamp)} must not clear`);
  }
  for (const f of ['scripts/lib/cv-wrongproduction-build-gate.js', 'scripts/lib/opening-night-checks/cv-wrongproduction-unhandled.check.js']) {
    const src = fs.readFileSync(root + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/!!\s*\w+\.wrongProductionAutoCleared|!\s*\w+\.wrongProductionAutoCleared\b/.test(src), `${f}: truthy read of wrongProductionAutoCleared`);
  }
});
