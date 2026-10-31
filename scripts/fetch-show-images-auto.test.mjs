/**
 * fetch-show-images-auto.test.mjs
 *
 * BRO-178: processOneShow must run failed-fetch cleanup on the THROW path, not
 * just after fetchShowImages resolves. A throw between a source's mkdir and its
 * write (sharp failure, OOM, disk error) used to propagate straight out,
 * leaving Promise.allSettled recording a rejection and the freshly created
 * directory/partial file surviving as false coverage.
 *
 * processOneShow itself isn't exported (fetch-show-images-auto.js runs main()
 * unconditionally at module load, so it can't be require()'d in a test). The
 * fix lives in scripts/lib/show-images.js's runFetchWithCleanup, which
 * processOneShow calls directly — these tests assert on that REAL exported
 * function, against real directories on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runFetchWithCleanup,
  snapshotShowImageDir,
} = require('./lib/show-images.js');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-cleanup-'));
}
function seed(root, showId, files) {
  const dir = path.join(root, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}
function silent() {} // suppress log noise in test output

test('throw between mkdir and write: dir removed AND the original error propagates unchanged', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'throws-empty');
  const before = snapshotShowImageDir(dir); // taken pre-fetch: dir does not exist yet

  const boom = new Error('sharp: unsupported image format');
  const fetchFn = async () => {
    fs.mkdirSync(dir, { recursive: true }); // source mkdir's before it knows if any candidate verifies
    throw boom; // ...then blows up before any write
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'throws-empty', silent),
    (err) => err === boom // exact same error object — not wrapped, not swallowed
  );
  assert.equal(fs.existsSync(dir), false, 'empty dir left by the throw must be pruned');
});

test('throw after a candidate file was written: file removed too, error still propagates', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'throws-with-file');
  fs.mkdirSync(dir, { recursive: true });
  const before = snapshotShowImageDir(dir); // empty at snapshot time

  const boom = new Error('ENOSPC: no space left on device');
  const fetchFn = async () => {
    fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'partial'); // written before verification
    throw boom; // then the run fails before shows.json records anything
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'throws-with-file', silent),
    (err) => err === boom
  );
  // the rejected candidate is removed, which empties the dir, which is then pruned too
  assert.equal(fs.existsSync(dir), false, 'the rejected candidate file must not survive as false coverage');
});

test('successful fetch: files and return value untouched (regression guard)', async () => {
  const root = makeRoot();
  const dir = path.join(root, 'succeeds');
  const before = snapshotShowImageDir(dir);

  const fetchFn = async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'poster.webp'), 'real-art');
    return { thumbnail: 'poster.webp' }; // truthy result = success
  };

  const result = await runFetchWithCleanup(fetchFn, dir, before, 'succeeds', silent);
  assert.deepEqual(result, { thumbnail: 'poster.webp' });
  assert.deepEqual(fs.readdirSync(dir), ['poster.webp'], 'cleanup must not touch a successful fetch');
});

test('throwing refetch on a show with existing archived art: archived art survives', async () => {
  const root = makeRoot();
  const dir = seed(root, 'has-good-art', ['poster.webp', 'thumbnail.webp']);
  const before = snapshotShowImageDir(dir); // snapshot captures the pre-existing files

  const boom = new Error('network timeout');
  const fetchFn = async () => {
    fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'rejected-candidate'); // this run's reject
    throw boom;
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'has-good-art', silent),
    (err) => err === boom
  );
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['poster.webp', 'thumbnail.webp'],
    'only this run’s rejected file is removed — previously archived art must never be destroyed'
  );
});

test('cleanup runs and rethrows unchanged even when nothing needs discarding', async () => {
  // No mkdir at all before the throw (the source failed before it wrote
  // anything) — discardFailedFetchArtifacts sees a missing directory and is a
  // no-op, but the finally block must still run and the original error must
  // still be the one that surfaces.
  const root = makeRoot();
  const dir = path.join(root, 'never-created');
  const before = snapshotShowImageDir(dir);

  const boom = new Error('discoverTodayTixId timed out');
  const fetchFn = async () => {
    throw boom;
  };

  await assert.rejects(
    () => runFetchWithCleanup(fetchFn, dir, before, 'never-created', silent),
    (err) => err === boom
  );
  assert.equal(fs.existsSync(dir), false);
});

// ---------------------------------------------------------------------------
// BRO-4243: paid-search paths and their per-show backoff.
//
// Ledger analysis (data/audit/scraper-spend-ledger.jsonl): before 2026-10-12
// ~95% of this script's ScrapingBee spend was the Google Images tier (25
// credits/search, 2 per show, every sweep). That tier got a per-show backoff,
// then SD-first routing. The 2026-10-13..15 ledger still showed the same ~90
// imageless shows searched on EVERY --missing sweep (4-5/day) by two
// discovery searches with no memory: the TodayTix Google SERP (5 SD credits,
// 25 SB credits on SD failure) and the Playbill google.com search (plus the
// IBDB SERP for Broadway rows). All now
// share the backoff, keyed "<tier>:<showId>" in image-search-attempts.json.
// ---------------------------------------------------------------------------
const {
  searchTierGate, attemptKey, recordGoogleImagesAttempt, shouldSkipGoogleImages, isGoogleBlockPage,
  todaytixSerpHitOutcome,
  TODAYTIX_SERP_TIER, PLAYBILL_SERP_TIER,
} = require('./lib/image-search-backoff.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-13T13:00:00Z');
const xlBully = { id: 'new-26-xl-bully-off-west-end-2026', openingDate: '2026-06-01' };

test('discovery tiers key separately from the Google Images entry', () => {
  assert.equal(attemptKey(null, 'x'), 'x');
  assert.equal(attemptKey(TODAYTIX_SERP_TIER, 'x'), 'todaytix-serp:x');
  assert.notEqual(attemptKey(TODAYTIX_SERP_TIER, 'x'), attemptKey(PLAYBILL_SERP_TIER, 'x'));
  // A Google Images miss must not gate the TodayTix SERP, and vice versa.
  const a = recordGoogleImagesAttempt({}, xlBully.id, false, now);
  assert.equal(searchTierGate(a, TODAYTIX_SERP_TIER, xlBully, { nowMs: now + HOUR }).skip, false);
  const b = recordGoogleImagesAttempt({}, attemptKey(TODAYTIX_SERP_TIER, xlBully.id), false, now);
  assert.equal(shouldSkipGoogleImages(b[xlBully.id], now + HOUR).skip, false);
});

test('the 2026-10-13..15 pattern: a TodayTix SERP miss is not re-searched by the next sweeps', () => {
  const key = attemptKey(TODAYTIX_SERP_TIER, xlBully.id);
  let attempts = recordGoogleImagesAttempt({}, key, false, now);
  // Sweeps ~3h and ~21h later: skipped (1-day window after the first miss).
  for (const dt of [3 * HOUR, 21 * HOUR]) {
    const g = searchTierGate(attempts, TODAYTIX_SERP_TIER, xlBully, { nowMs: now + dt });
    assert.equal(g.skip, true, `+${dt / HOUR}h`);
    assert.equal(g.key, key);
    assert.equal(g.failures, 1);
  }
  // Window elapsed: searches again; a second miss doubles the wait.
  assert.equal(searchTierGate(attempts, TODAYTIX_SERP_TIER, xlBully, { nowMs: now + DAY }).skip, false);
  attempts = recordGoogleImagesAttempt(attempts, key, false, now + DAY);
  assert.equal(searchTierGate(attempts, TODAYTIX_SERP_TIER, xlBully, { nowMs: now + 2.5 * DAY }).skip, true);
  // A hit clears it.
  attempts = recordGoogleImagesAttempt(attempts, key, true, now + 3 * DAY);
  assert.equal(attempts[key], undefined);
});

test('targeted runs (force) and shows near opening always search', () => {
  const key = attemptKey(PLAYBILL_SERP_TIER, xlBully.id);
  const attempts = recordGoogleImagesAttempt({}, key, false, now);
  assert.equal(searchTierGate(attempts, PLAYBILL_SERP_TIER, xlBully, { nowMs: now + HOUR, force: true }).skip, false);
  const opening = { ...xlBully, previewsStartDate: '2026-10-20' };
  assert.equal(searchTierGate(attempts, PLAYBILL_SERP_TIER, opening, { nowMs: now + HOUR }).skip, false);
  assert.equal(searchTierGate(attempts, PLAYBILL_SERP_TIER, xlBully, { nowMs: now + HOUR }).skip, true);
});

test('a Google block/consent page is not a results page (not counted as a miss)', () => {
  assert.equal(isGoogleBlockPage('<html>Our systems have detected unusual traffic from your computer network</html>'), true);
  assert.equal(isGoogleBlockPage('<form action="https://www.google.com/sorry/index">'), true);
  assert.equal(isGoogleBlockPage('<h1>Before you continue to Google</h1>'), true);
  assert.equal(isGoogleBlockPage('<noscript><meta content="0;url=/httpservice/retry/enablejs?sei=x"></noscript>'), true);
  assert.equal(isGoogleBlockPage('<a href="/search?q=x&amp;emsg=SG_REL&amp;sei=y">enablejs</a>'), true);
  assert.equal(isGoogleBlockPage(''), true);
  assert.equal(isGoogleBlockPage(null), true);
  assert.equal(isGoogleBlockPage('<div id="search"><a href="https://playbill.com/production/foo">Foo</a></div>'), false);
  assert.equal(isGoogleBlockPage('<div id="search">No results found for site:playbill.com/production "XL Bully"</div>'), false);
});

test('wiring: the four paid per-show searches in fetch-show-images-auto.js are gated', () => {
  // main() runs at import, so pin the call sites in the source instead: the
  // gate call, then an immediate `if (<gate>.skip) ...` before the paid call.
  const src = fs.readFileSync(new URL('./fetch-show-images-auto.js', import.meta.url), 'utf8');
  const gatedInFn = (needle, gateRe) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `missing ${needle}`);
    const fnStart = src.lastIndexOf('\nasync function ', i);
    assert.match(src.slice(fnStart, i), gateRe, `${needle} is not gated`);
  };
  const discovery = (tier, v) => new RegExp(
    `const ${v} = discoverySerpGate\\(${tier}, show, '[^']+'\\);\\s*\\n\\s*if \\(${v}\\.skip\\) return null;`);
  gatedInFn('await searchGoogleForTodayTix(', discovery('TODAYTIX_SERP_TIER', 'ttSerpGate'));
  gatedInFn('site:playbill.com/production "${show.title}" broadway', discovery('PLAYBILL_SERP_TIER', 'pbSerpGate'));
  gatedInFn('await searchGoogleForIBDB(', discovery('IBDB_SERP_TIER', 'ibdbSerpGate'));
  gatedInFn('googleImages = await fetchFromGoogleImages(show)',
    /const googleGate = searchTierGate\(googleAttempts, null, show, \{ force: forceGoogle \}\);[\s\S]*if \(googleGate\.skip\) \{/);
  // A provider outage (serpQuery null) must not count as a miss.
  assert.match(src, /answered: results != null/);
  assert.match(src, /if \(serpAnswered\) noteSearchAttempt\(ttSerpGate\.key, false\)/);
  // IBDB: a no-URL answer is a miss; the hit is recorded only after the page loads.
  assert.match(src, /if \(results && !ibdbUrl\) noteSearchAttempt\(ibdbSerpGate\.key, false\)/);
  assert.match(src, /const html = await fetchPageWithFallback\(ibdbUrl, \{ premiumProxy: true \}\);[^]{0,300}noteSearchAttempt\(ibdbSerpGate\.key, true\)/);
  assert.doesNotMatch(src, /noteSearchAttempt\(ttSerpGate\.key, true\)/, 'TodayTix success is recorded by the caller, after the owner check');
  assert.match(src, /if \(!isGoogleBlockPage\(searchHtml\)\) noteSearchAttempt\(pbSerpGate\.key, false\)/);
  // An owner-rejected SERP hit and an uncached cross-market Playbill hit are misses.
  assert.match(src, /const serpOutcome = todaytixSerpHitOutcome\(!!todayTixInfo && serpDiscoveredTodayTix\.has\(todayTixInfo\), !!owner\);\s*\n\s*if \(serpOutcome !== null\) noteSearchAttempt\(attemptKey\(TODAYTIX_SERP_TIER, show\.id\), serpOutcome\);/);
});

test('TodayTix SERP: an owner-rejected hit is one miss and failures keep accumulating', () => {
  assert.equal(todaytixSerpHitOutcome(false, false), null, 'direct-search hit: SERP never ran');
  assert.equal(todaytixSerpHitOutcome(false, true), null);
  assert.equal(todaytixSerpHitOutcome(true, false), true);
  assert.equal(todaytixSerpHitOutcome(true, true), false);

  // Replay the caller: a show whose SERP keeps returning another show's page.
  const key = attemptKey(TODAYTIX_SERP_TIER, xlBully.id);
  let attempts = {};
  for (let run = 0; run < 4; run++) {
    const t = now + run * 15 * DAY; // each run after the previous window
    assert.equal(searchTierGate(attempts, TODAYTIX_SERP_TIER, xlBully, { nowMs: t }).skip, false);
    const outcome = todaytixSerpHitOutcome(true, true);
    attempts = recordGoogleImagesAttempt(attempts, key, outcome, t);
  }
  assert.equal(attempts[key].failures, 4, 'never reset to 1 by a success-then-miss');
  assert.equal(searchTierGate(attempts, TODAYTIX_SERP_TIER, xlBully, { nowMs: now + 45 * DAY + 7 * DAY }).skip, true, '8-day window after 4 misses');

  // A hit that survives the owner check clears the entry.
  attempts = recordGoogleImagesAttempt(attempts, key, todaytixSerpHitOutcome(true, false), now + 60 * DAY);
  assert.equal(attempts[key], undefined);
});
