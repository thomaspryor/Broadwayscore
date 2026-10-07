/**
 * verify-prior-run-former-cast-sweep.test.mjs — corpus-wide regression guard
 * for BRO-1397 (excerptMentionsFormerCast, scripts/lib/excerpt-validation.js).
 *
 * The unit tests in tests/unit/prior-run-review-display.test.mjs cover the
 * guard's logic against synthetic fixtures. This test instead sweeps EVERY
 * show in data/shows.json that declares priorRuns against the REAL
 * review-texts corpus and asserts the set of flagged (former-cast) mentions
 * exactly matches a known-good allowlist.
 *
 * Why this exists: shipping the guard against only the one show that
 * motivated the ticket (to-kill-a-mockingbird-west-end-2026) missed 2 real
 * false positives on OTHER priorRuns shows, found only by sweeping all 34:
 *   - allegra-west-end-2026: "West End" itself tokenized as a name candidate
 *   - the-enormous-crocodile-west-end-2026: director missing from structured
 *     show.creativeTeam data, flagged the same way a departed actor would be
 * Both are fixed (MARKET_PHRASE_RE, extractCreativeRolePhraseNames), but a
 * future priorRuns show or a future edit to the guard could reintroduce a
 * similar false positive with no unit-test fixture to catch it — this test
 * is the durable, corpus-shaped check that would.
 *
 * Same corpus-presence contract as scripts/verify-frankie-2002-cleanup.test.mjs:
 * skips locally when data/review-texts is absent (registered in
 * tests/unit-test-manifest.txt, which the unit-tests CI job runs WITHOUT a
 * review-texts checkout). REQUIRE_REVIEW_CORPUS=1 turns a missing/empty
 * corpus into a hard failure, set by the data-validation job's re-run of
 * this file AFTER checkout-review-texts.
 *
 * Run: node --test scripts/verify-prior-run-former-cast-sweep.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');
const { excerptMentionsFormerCast } = require('./lib/excerpt-validation.js');

const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const MIN_CORPUS_ENTRIES = 10;

// Genuine former-cast mentions confirmed by hand (BRO-1397): the 2022
// Gielgud-run leads (Rafe Spall, Jim Norton, Poppy Lee Friar) named across
// several candidate fields — llmPullQuote, westEndTheatreExcerpt,
// stagedoorExcerpt — of these to-kill-a-mockingbird-west-end-2026 files.
// The guard correctly flags every field that mentions them, not just
// whichever field selectBestExcerpt() ultimately picks.
// Format: `${showId}::${fileName}` -> suppresses all fields for that file.
const KNOWN_GOOD_FLAGS = new Set([
  'to-kill-a-mockingbird-west-end-2026::london-theatre--matt-wolf.json',
  'to-kill-a-mockingbird-west-end-2026::times-uk--quentin-letts.json',
  'to-kill-a-mockingbird-west-end-2026::guardian--arifa-akbar.json',
  'to-kill-a-mockingbird-west-end-2026::i-paper--sam-marlowe.json',
  'to-kill-a-mockingbird-west-end-2026::telegraph--dominic-cavendish.json',
  'to-kill-a-mockingbird-west-end-2026::timeout-london--andrzej-lukowski.json',
  'to-kill-a-mockingbird-west-end-2026::times-uk--clive-davis.json',
]);

// NOT former-cast mentions — the guard's suppression is still the right
// outcome, but for an adjacent, PRE-EXISTING data-quality reason unrelated
// to BRO-1397, filed separately rather than fixed here (would need its own
// investigation, not a quote-selection change):
//   - my-neighbour-totoro-west-end-2025::times-uk--clive-davis.json
//     (field=westEndTheatreExcerpt): the excerpt itself is NOT about My
//     Neighbour Totoro at all — it's a Peter Pan review (Wendy, Neverland,
//     "Ella Hickson's feminist-tinged journey to Neverland"). Cross-show
//     contamination that the existing Layer 3 cross-show guard
//     (excerptMentionsWrongShow) should catch but doesn't suppress today
//     because CROSS_SHOW_DRY_RUN defaults to dry-run-only (logs, never
//     suppresses) in scripts/rebuild-all-reviews.js. The former-cast guard
//     flagging "ella" (Ella Hickson, unrecognized because she isn't this
//     show's writer) is a correct-by-accident side effect, not a bug in
//     THIS guard.
//   - cyrano-de-bergerac-west-end-2026::thestage--unknown.json
//     (field=westEndTheatreExcerpt): show.cast for this show is a ~1946
//     Broadway cast (character names like "A Musketeer", "Ragueneau",
//     "Bellerose" — not the 2026 West End production, which stars Adrian
//     Lester). The review correctly names 2026 cast member "Levi Brown",
//     but nothing in the corrupted cast array can recognize him as safe.
const KNOWN_DATA_QUALITY_FLAGS = new Set([
  'my-neighbour-totoro-west-end-2025::times-uk--clive-davis.json',
  'cyrano-de-bergerac-west-end-2026::thestage--unknown.json',
]);

// Candidate fields checked, mirroring the priority order selectBestExcerpt()
// itself tries in scripts/rebuild-all-reviews.js.
const CANDIDATE_FIELDS = ['llmPullQuote', 'pullQuote', 'westEndTheatreExcerpt', 'stagedoorExcerpt'];

function corpusUsable() {
  const rootOk = fs.existsSync(REVIEW_TEXTS_DIR) && fs.readdirSync(REVIEW_TEXTS_DIR).length > MIN_CORPUS_ENTRIES;
  if (REQUIRE_CORPUS) {
    assert.ok(rootOk,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} isn't a real corpus (>${MIN_CORPUS_ENTRIES} entries expected) — the review-texts checkout did not land, so this test would have silently skipped. Fix the checkout rather than unsetting the flag.`);
    return true;
  }
  return rootOk;
}

test(
  'excerptMentionsFormerCast flags exactly the known-good set across every priorRuns show',
  { skip: !corpusUsable() && `no usable corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)` },
  () => {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const withPriorRuns = showsData.shows.filter((s) => Array.isArray(s.priorRuns) && s.priorRuns.length > 0);
    assert.ok(withPriorRuns.length > 0, 'expected at least one show with priorRuns declared — fixture/data drift?');

    const actualFlags = new Set();
    const unexpected = [];

    for (const show of withPriorRuns) {
      const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
      if (!fs.existsSync(showDir)) continue;

      for (const file of fs.readdirSync(showDir).filter((f) => f.endsWith('.json'))) {
        let data;
        try {
          data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        } catch {
          continue;
        }

        for (const field of CANDIDATE_FIELDS) {
          const candidate = data[field];
          if (!candidate) continue;
          const res = excerptMentionsFormerCast(candidate, {
            show,
            reviewDate: data.publishDate,
            reviewData: data,
          });
          if (res.mentionsFormerCast) {
            const key = `${show.id}::${file}`;
            actualFlags.add(key);
            if (!KNOWN_GOOD_FLAGS.has(key) && !KNOWN_DATA_QUALITY_FLAGS.has(key)) {
              unexpected.push(`${key} (field=${field}, name="${res.name}"): "${candidate.slice(0, 100)}"`);
            }
          }
        }
      }
    }

    assert.deepEqual(
      unexpected,
      [],
      `New/unexpected former-cast flag(s) not in KNOWN_GOOD_FLAGS — either a genuine new catch (add it to KNOWN_GOOD_FLAGS after confirming the quote really does name a departed cast member) or a false positive (fix the guard):\n${unexpected.join('\n')}`
    );

    for (const key of KNOWN_GOOD_FLAGS) {
      assert.ok(actualFlags.has(key),
        `${key} was expected to be flagged as a former-cast mention but wasn't — a guard change regressed the original BRO-1397 fix.`);
    }
  }
);
