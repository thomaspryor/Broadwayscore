/**
 * verify-frankie-2002-cleanup.test.mjs — acceptance check for BRO-853
 * (Delete frankie-2002 duplicate files, 11 wrong-production).
 *
 * The frankie-and-johnny-in-the-clair-de-lune-2002 review-texts directory had
 * 18 files, but 15 of them were actually 2019-production content (the
 * Audra McDonald / Michael Shannon revival) misfiled into the 2002 dir: 11
 * whose URL literally contains "2019" (the set the ticket named), plus 4 more
 * (amny, chicagotribune, cultural-weekly, theatermania) confirmed by direct
 * text comparison against their frankie-2019 counterparts — same article,
 * minor scrape differences, already flagged wrongProduction=true on the 2002
 * side while the 2019 side is clean. Only 3 files are genuinely 2002-era:
 * lighting-and-sound-america, metrmag, talkinbroadway.
 *
 * Same corpus-presence contract as scripts/lib/review-guards.explain.test.mjs:
 * skips locally when data/review-texts is absent (registered in
 * tests/unit-test-manifest.txt, which the unit-tests CI job runs WITHOUT a
 * review-texts checkout — see test.yml). REQUIRE_REVIEW_CORPUS=1 turns a
 * missing/empty corpus into a hard failure instead, set by the data-validation
 * job's re-run of this file AFTER checkout-review-texts, so the claim is
 * actually enforced somewhere rather than perpetually skipping.
 *
 * Run: node --test scripts/verify-frankie-2002-cleanup.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');

const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const SHOW_DIR = 'frankie-and-johnny-in-the-clair-de-lune-2002';
const SHOW_PATH = path.join(REVIEW_TEXTS_DIR, SHOW_DIR);

const REMOVED_FILES = [
  'deadline--greg-evans.json',
  'front-row-center--tulis-mccall.json',
  'gotham-playgoer--robert-sholiton.json',
  'hollywood-reporter--frank-scheck.json',
  'nytimes--jesse-green.json',
  'observer--david-cote.json',
  'thestage--naveen-kumar.json',
  'timeout--adam-feldman.json',
  'variety--marilyn-stasio.json',
  'vulture--sara-holdren.json',
  'wsj--terry-teachout.json',
  'amny--matt-windman.json',
  'chicagotribune--chris-jones.json',
  'cultural-weekly--david-sheward.json',
  'theatermania--zachary-stewart.json',
];
const EXPECTED_REMAINING = [
  'lighting-and-sound-america--david-barbour.json',
  'metrmag--unknown.json',
  'talkinbroadway--unknown.json',
].sort();

function corpusMissing() {
  if (REQUIRE_CORPUS) {
    assert.ok(fs.existsSync(SHOW_PATH),
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${SHOW_PATH} — the review-texts checkout did not land, so this test would have silently skipped. Fix the checkout rather than unsetting the flag.`);
    return false;
  }
  return !fs.existsSync(SHOW_PATH);
}

test(
  'frankie-2002 review-texts dir has no wrong-production duplicates left',
  { skip: corpusMissing() && `no corpus at ${SHOW_PATH} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)` },
  () => {
    const files = fs.readdirSync(SHOW_PATH).filter((f) => f.endsWith('.json')).sort();

    for (const removed of REMOVED_FILES) {
      assert.ok(!files.includes(removed),
        `${removed} still present in ${SHOW_DIR} — it is 2019-production content that should have been deleted`);
    }

    assert.deepEqual(files, EXPECTED_REMAINING,
      `${SHOW_DIR} contains [${files.join(', ')}], expected exactly [${EXPECTED_REMAINING.join(', ')}]`);

    // metrmag--unknown.json is a separate, out-of-scope orphan (a regional Boston
    // production review misattached to this show, not a 2002-vs-2019 collision) —
    // it is already excluded from scoring via contentTier=invalid + wrongProduction
    // and is left in place pending a follow-up card, so it's exempt from this check.
    for (const f of files.filter((f) => f !== 'metrmag--unknown.json')) {
      const data = JSON.parse(fs.readFileSync(path.join(SHOW_PATH, f), 'utf8'));
      assert.ok(!(data.url || '').includes('2019'),
        `${f} has a 2019 URL (${data.url}) but was left in the 2002 dir`);
      assert.notEqual(data.wrongProduction, true,
        `${f} is flagged wrongProduction=true but was left in the 2002 dir`);
    }
  },
);
