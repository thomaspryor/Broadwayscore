/**
 * Regression test (BRO-2391): the BRO-318 stale-backpointer class recurred on
 * loves-labours-lost-globe-west-end-2026 TWICE after the original fix
 * (b5b4ec2, 2026-08-22) — 2026-08-25 and again 2026-08-26 — because
 * collect-review-texts.js's content-fingerprint dedup re-sets a canonical's
 * duplicateTextOf back-pointer at its own loser on every refetch whose
 * extraction differs (a scraped quiz-widget prefix is enough to shift the
 * fingerprint). The ONLY tool that repairs that shape is
 * fix-canonical-duplicate-backpointer.js, and it is not wired into any CI
 * workflow (`grep -rl fix-canonical-duplicate-backpointer .github/workflows/`
 * — zero hits) — it only ever ran by hand, so the pointer sat stale between
 * runs until validate-data.js's NEW-duplicate-URL gate went red on main and a
 * human noticed and re-ran the tool manually.
 *
 * dedupe-same-url-bylines.js DOES run daily (dedupe-same-url-bylines.yml), but
 * its audit() previously skipped this exact shape outright: a same-URL group
 * where a loser ALREADY carries a live duplicateOf pointing at the canonical
 * is treated as "already collapsed" and never re-examined for a stale pointer
 * newly re-set on the canonical's own side — the gap this ticket investigates.
 *
 * This is a DIFFERENT shape than dedupe-same-url-bylines-double-clear.test.mjs
 * (card #1907): that test covers BOTH sides having been independently CLEARED
 * to duplicateOf:null (so neither points at the other — "double-clear").
 * Here, the loser->canonical link is live and correct; only the canonical's
 * OWN back-pointer into the cluster is stale. That is exactly what
 * fix-canonical-duplicate-backpointer.js targets, and exactly what audit()'s
 * "skip groups already collapsed by a duplicateOf link" check used to hide
 * from the daily gate.
 *
 * REVIEW_TEXTS_DIR must be set BEFORE dedupe-same-url-bylines.js is required
 * (it reads the env var once, at module load, into a top-level const).
 *
 * Run: node --test tests/unit/dedupe-same-url-bylines-stale-canonical-recurrence.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const REVIEW_TEXTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-stale-canon-recur-'));
process.env.REVIEW_TEXTS_DIR = REVIEW_TEXTS_DIR;
const { audit, fix } = require('../../scripts/dedupe-same-url-bylines.js');

const body = (n) => 'x'.repeat(n);

test('audit(): a group already linked by a live duplicateOf still surfaces a stale canonical backpointer re-set at one of its losers', () => {
  const showId = 'loves-labours-lost-globe-west-end-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://www.thetimes.com/culture/theatre-dance/article/loves-labours-lost-review-shakespeare-ruined-by-puerile-knob-gags-wtr9x5xl9';
  const canonName = 'times-uk--clive-davis.json';
  const loserName = 'times-uk--david-jays-and-maxie-szalwinska.json';

  // Loser already carries a LIVE, correct duplicateOf at the canonical — this
  // group already looks "collapsed" from a first glance. But the canonical's
  // own duplicateTextOf was re-set at that SAME loser by a later refetch
  // (collect-review-texts.js's content-fingerprint dedup), recreating the
  // mutual cycle the original BRO-318 fix already closed once.
  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'Clive Davis',
    url, fullText: body(3000), contentTier: 'complete', isFullReview: true,
    duplicateOf: null, duplicateTextOf: loserName,
  }));
  fs.writeFileSync(path.join(showDir, loserName), JSON.stringify({
    showId, outletId: 'times-uk', outlet: 'The Times (UK)', criticName: 'David Jays and Maxie Szalwinska',
    url, fullText: body(2800), contentTier: 'complete', isFullReview: true,
    duplicateOf: canonName,
  }));

  const before = audit();
  assert.ok(before.staleBackpointerCount >= 1, 'the re-set stale canonical backpointer must be detected even though the group already has a live duplicateOf link');
  const hit = before.cohesive.find((g) => g.showId === showId && g.canonical === canonName);
  assert.ok(hit, 'the stale-backpointer group must be queued for fix() alongside ordinary cohesive groups');
  assert.deepEqual(hit.losers, [loserName]);

  const r = fix(before.cohesive);
  assert.ok(r.staleCanonicalPointerCleared >= 1, 'fix() must clear the re-set stale pointer');

  const canonData = JSON.parse(fs.readFileSync(path.join(showDir, canonName), 'utf-8'));
  assert.equal(canonData.duplicateOf, null, 'canonical must stay primary');
  assert.equal('duplicateTextOf' in canonData, false, 'stale self-pointer must be deleted, not nulled');

  const loserData = JSON.parse(fs.readFileSync(path.join(showDir, loserName), 'utf-8'));
  assert.equal(loserData.duplicateOf, canonName, 'loser link must remain intact — it was already correct');

  // Re-audit: the cluster is now clean, so it must never resurface.
  const after = audit();
  assert.equal(after.staleBackpointerCount, 0, 'no stale-backpointer groups left after fix');
});

test('audit(): an already-linked group with NO stale canonical backpointer is left alone (no false positive)', () => {
  const showId = 'some-clean-show-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://example.com/review';
  const canonName = 'outlet--critic-a.json';
  const loserName = 'outlet--critic-b.json';

  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic A', url, fullText: body(3000),
    contentTier: 'complete', isFullReview: true, duplicateOf: null,
  }));
  fs.writeFileSync(path.join(showDir, loserName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic B', url, fullText: body(2800),
    contentTier: 'complete', isFullReview: true, duplicateOf: canonName,
  }));

  const result = audit();
  assert.equal(result.staleBackpointerCount, 0);
  assert.equal(result.cohesive.some((g) => g.showId === showId), false);
});

test('audit(): an unrelated third file sharing the URL is NEVER swept into the canonical\'s losers just for being in the group (adversarial review, BRO-2391)', () => {
  const showId = 'three-member-show-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://example.com/review-shared-url';
  const canonName = 'outlet--critic-a.json';
  const linkedLoserName = 'outlet--critic-b.json';
  const unlinkedName = 'outlet--critic-c.json';

  // Canonical carries a stale backpointer at its ACTUAL loser (linkedLoserName).
  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic A', url, fullText: body(3000),
    contentTier: 'complete', isFullReview: true,
    duplicateOf: null, duplicateTextOf: linkedLoserName,
  }));
  fs.writeFileSync(path.join(showDir, linkedLoserName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic B', url, fullText: body(2800),
    contentTier: 'complete', isFullReview: true, duplicateOf: canonName,
  }));
  // Critic C shares the same URL by coincidence but has NO pointer at the
  // canonical at all — must never be swept in as a loser.
  fs.writeFileSync(path.join(showDir, unlinkedName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic C', url, fullText: body(2600),
    contentTier: 'complete', isFullReview: true, duplicateOf: null,
  }));

  const before = audit();
  const hit = before.cohesive.find((g) => g.showId === showId && g.canonical === canonName);
  assert.ok(hit, 'the linked stale-backpointer pair must still be detected');
  assert.deepEqual(hit.losers, [linkedLoserName], 'the unlinked third file must NOT be included as a loser');

  fix(before.cohesive);
  const unlinkedData = JSON.parse(fs.readFileSync(path.join(showDir, unlinkedName), 'utf-8'));
  assert.equal(unlinkedData.duplicateOf, null, 'the unrelated file must be left completely untouched');
});

test('audit(): two INDEPENDENT linked pairs sharing one URL are resolved separately, not merged into one contradictory collapse (adversarial review, BRO-2391)', () => {
  const showId = 'two-pairs-one-url-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://example.com/two-pairs-shared-url';
  const canonA = 'outlet--critic-a.json';
  const loserB = 'outlet--critic-b.json';
  const canonC = 'outlet--critic-c.json';
  const loserD = 'outlet--critic-d.json';

  fs.writeFileSync(path.join(showDir, canonA), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic A', url, fullText: body(3000),
    contentTier: 'complete', isFullReview: true, duplicateOf: null, duplicateTextOf: loserB,
  }));
  fs.writeFileSync(path.join(showDir, loserB), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic B', url, fullText: body(2800),
    contentTier: 'complete', isFullReview: true, duplicateOf: canonA,
  }));
  fs.writeFileSync(path.join(showDir, canonC), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic C', url, fullText: body(2900),
    contentTier: 'complete', isFullReview: true, duplicateOf: null, duplicateTextOf: loserD,
  }));
  fs.writeFileSync(path.join(showDir, loserD), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic D', url, fullText: body(2700),
    contentTier: 'complete', isFullReview: true, duplicateOf: canonC,
  }));

  const before = audit();
  const hitA = before.cohesive.find((g) => g.showId === showId && g.canonical === canonA);
  const hitC = before.cohesive.find((g) => g.showId === showId && g.canonical === canonC);
  assert.ok(hitA, 'pair A/B must be detected');
  assert.ok(hitC, 'pair C/D must be detected');
  assert.deepEqual(hitA.losers, [loserB], 'A\'s losers must be exactly B, never C or D');
  assert.deepEqual(hitC.losers, [loserD], 'C\'s losers must be exactly D, never A or B');

  fix(before.cohesive);
  const a = JSON.parse(fs.readFileSync(path.join(showDir, canonA), 'utf-8'));
  const c = JSON.parse(fs.readFileSync(path.join(showDir, canonC), 'utf-8'));
  assert.equal(a.duplicateOf, null, 'A stays its own canonical');
  assert.equal(c.duplicateOf, null, 'C stays its own canonical, never folded into A\'s cluster');
});

test('audit(): a human-reviewed canonical is never touched, even with a stale backpointer (adversarial review, BRO-2391)', () => {
  const showId = 'human-reviewed-canonical-2026';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://example.com/human-reviewed';
  const canonName = 'outlet--critic-a.json';
  const loserName = 'outlet--critic-b.json';

  fs.writeFileSync(path.join(showDir, canonName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic A', url, fullText: body(3000),
    contentTier: 'complete', isFullReview: true,
    duplicateOf: null, duplicateTextOf: loserName, humanReviewScore: 85,
  }));
  fs.writeFileSync(path.join(showDir, loserName), JSON.stringify({
    showId, outletId: 'outlet', criticName: 'Critic B', url, fullText: body(2800),
    contentTier: 'complete', isFullReview: true, duplicateOf: canonName,
  }));

  const result = audit();
  assert.equal(result.cohesive.some((g) => g.showId === showId), false, 'a human-reviewed canonical must never be queued for a forced write');
});

test('audit(): a TRUE uncommitted mutual cycle (both sides duplicateOf:null, mutual duplicateTextOf) is left alone, not force-collapsed from both directions (live corpus case, cats-1982 the-sunflower)', () => {
  const showId = 'cats-1982';
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const url = 'https://thesunflower.com/45810/arts-and-culture/review-cats-is-the-musical-spectacular-that-we-all-know-it-to-be/';
  const nameA = 'the-sunflower--karen-galindo.json';
  const nameB = 'the-sunflower--reviews-karen-galindo.json';

  // Neither side has committed via duplicateOf — each only carries a
  // duplicateTextOf pointing at the other. Both look like a valid canonical
  // from the "duplicateOf falsy" test alone.
  fs.writeFileSync(path.join(showDir, nameA), JSON.stringify({
    showId, outletId: 'the-sunflower', criticName: 'Karen Galindo', url, fullText: body(3000),
    contentTier: 'complete', isFullReview: true, duplicateOf: null, duplicateTextOf: nameB,
  }));
  fs.writeFileSync(path.join(showDir, nameB), JSON.stringify({
    showId, outletId: 'the-sunflower', criticName: 'Karen Galindo', url, fullText: body(2900),
    contentTier: 'complete', isFullReview: true, duplicateOf: null, duplicateTextOf: nameA,
  }));

  const before = audit();
  assert.equal(before.cohesive.some((g) => g.showId === showId), false, 'a genuinely uncommitted mutual cycle must not be queued at all — not from either direction');

  // fix() on an empty queue must leave both files completely untouched.
  fix(before.cohesive.filter((g) => g.showId === showId));
  const a = JSON.parse(fs.readFileSync(path.join(showDir, nameA), 'utf-8'));
  const b = JSON.parse(fs.readFileSync(path.join(showDir, nameB), 'utf-8'));
  assert.equal(a.duplicateTextOf, nameB, 'A must be untouched');
  assert.equal(b.duplicateTextOf, nameA, 'B must be untouched');
});
