/**
 * verify-frankie-2002-cleanup.test.mjs — acceptance check for BRO-853
 * ("Delete frankie-2002 duplicate files, 11 wrong-production" — the ticket's
 * title names the 11 files whose URL literally contains "2019"; this test
 * covers 15, the full set actually confirmed wrong).
 *
 * The frankie-and-johnny-in-the-clair-de-lune-2002 review-texts directory had
 * 18 files, but 15 of them were actually 2019-production content (the
 * Audra McDonald / Michael Shannon revival) misfiled into the 2002 dir: the
 * 11 named in the ticket, plus 4 more (amny, chicagotribune, cultural-weekly,
 * theatermania) confirmed by direct text comparison against their frankie-2019
 * counterparts — same article, minor scrape differences, already flagged
 * wrongProduction=true on the 2002 side while the 2019 side is clean.
 *
 * A 3rd file, metrmag--unknown.json, is ALSO not a legitimate 2002 review (it's
 * a misattached regional Boston production, unrelated to either Broadway
 * production) but is out of scope for this ticket (a different defect class —
 * orphan misattachment, not the 2002-vs-2019 collision) and is left in place
 * pending a follow-up card. It's excluded from the per-file checks below so
 * this test doesn't falsely claim it as legitimate.
 *
 * Deliberately does NOT assert an exact remaining file count/list — a future
 * legitimately-recovered 2002 review (or a follow-up removing metrmag) must
 * not fail this test. It only asserts the specific 15 confirmed-wrong files
 * never come back, and that whatever remains isn't itself 2019 content.
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
// Same "is this a real corpus, not an empty/sparse checkout" bar as
// review-guards.explain.test.mjs, applied to the whole review-texts root
// rather than just this one show dir.
const MIN_CORPUS_ENTRIES = 10;

const OUT_OF_SCOPE_ORPHAN = 'metrmag--unknown.json';
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

function corpusUsable() {
  const rootOk = fs.existsSync(REVIEW_TEXTS_DIR) && fs.readdirSync(REVIEW_TEXTS_DIR).length > MIN_CORPUS_ENTRIES;
  const showOk = fs.existsSync(SHOW_PATH);
  if (REQUIRE_CORPUS) {
    assert.ok(rootOk,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} isn't a real corpus (>${MIN_CORPUS_ENTRIES} entries expected) — the review-texts checkout did not land, so this test would have silently skipped. Fix the checkout rather than unsetting the flag.`);
    assert.ok(showOk,
      `REQUIRE_REVIEW_CORPUS=1 but no show dir at ${SHOW_PATH} — the review-texts checkout did not land, so this test would have silently skipped. Fix the checkout rather than unsetting the flag.`);
    return true;
  }
  return rootOk && showOk;
}

test(
  'frankie-2002 review-texts dir has no wrong-production duplicates left',
  { skip: !corpusUsable() && `no usable corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)` },
  () => {
    const files = fs.readdirSync(SHOW_PATH).filter((f) => f.endsWith('.json'));

    for (const removed of REMOVED_FILES) {
      assert.ok(!files.includes(removed),
        `${removed} still present in ${SHOW_DIR} — it is 2019-production content that should have been deleted`);
    }

    for (const f of files.filter((f) => f !== OUT_OF_SCOPE_ORPHAN)) {
      const data = JSON.parse(fs.readFileSync(path.join(SHOW_PATH, f), 'utf8'));
      assert.ok(!(data.url || '').includes('2019'),
        `${f} has a 2019 URL (${data.url}) — new 2019-production content shouldn't be added to the 2002 dir`);
      assert.notEqual(data.wrongProduction, true,
        `${f} is flagged wrongProduction=true but is present in the 2002 dir`);
    }
  },
);
