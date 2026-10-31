/**
 * timeout-london-attribution.test.mjs — BRO-4153 regression guard.
 *
 * outlet-registry.json registers BOTH `timeout` (Time Out New York) and
 * `timeout-london` (Time Out London) under the identical primary domain
 * `timeout.com` — a declared edition-pair collision (path-split, not
 * byline/section, see outlet-registry-domain-collisions.js's EDITION_PAIRS).
 * review-file-writer.js already split by path at write time, but every OTHER
 * resolver that only ever sees a bare hostname (outlet-canonicalize.js's
 * lookupOutletForHost / resolveCanonicalOutletId, used by ingest-review-
 * from-url.js, ingest-manual-review.js, manual-review-direct.js,
 * validate-review-submission.js) either trusted a generic "timeout" operator
 * input without checking the URL path, or bailed out entirely on the
 * now-ambiguous host.
 *
 * The fix: resolveOutletFromUrlIfPathInformed() (review-normalization.js) is
 * the ONE shared path-aware check — it returns the path-split outlet only
 * when the bare origin disagrees with the full URL (true for timeout.com,
 * false for the byline-decided Sunday-paper pairs), and every caller above
 * now consults it before falling back to the bare-domain map.
 *
 * This file:
 *   1. Asserts the shared resolver's timeout.com/timeout.co.uk path split.
 *   2. Asserts resolveCanonicalOutletId (the operator-input + URL entry point
 *      every ingest script above shares) applies that split even when the
 *      operator's own input says the other edition.
 *   3. Asserts the Sunday-paper collisions (telegraph, express) are DECIDED —
 *      declared edition pairs, deliberately left unresolved by URL/path since
 *      no path signal exists for them (byline/section data disambiguates
 *      downstream instead — see the collision-rule comment in
 *      review-normalization.js's buildDomainToOutletIndex).
 *   4. Provides findTimeoutLondonMisattributions(), a corpus assertion
 *      helper, exercised here against a small fixture AND (corpus-presence
 *      gated, same contract as scripts/verify-frankie-2002-cleanup.test.mjs)
 *      against the real review-texts corpus — must report 0.
 *
 * Run: node --test scripts/lib/timeout-london-attribution.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  resolveOutletFromUrl,
  resolveOutletFromUrlIfPathInformed,
} = require_('./review-normalization.js');
const { resolveCanonicalOutletId } = require_('./outlet-canonicalize.js');
const { EDITION_PAIRS } = require_('./outlet-registry-domain-collisions.js');
const { resolveReviewTextsDir } = require_('./review-texts-dir.js');

// ── 1. The shared resolver's path split ─────────────────────────────────────

test('resolveOutletFromUrl: timeout.com/london -> timeout-london, else -> timeout', () => {
  assert.equal(
    resolveOutletFromUrl('https://www.timeout.com/london/theatre/my-neighbour-totoro-review').outletId,
    'timeout-london'
  );
  assert.equal(
    resolveOutletFromUrl('https://www.timeout.com/newyork/theater/school-girls-1').outletId,
    'timeout'
  );
  assert.equal(
    resolveOutletFromUrl('https://www.timeout.co.uk/london/theatre/whatever').outletId,
    'timeout-london'
  );
});

test('resolveOutletFromUrlIfPathInformed: fires for timeout.com, null for undeclared collisions and plain domains', () => {
  const timeoutLondon = resolveOutletFromUrlIfPathInformed(
    'https://www.timeout.com/london/theatre/my-neighbour-totoro-review'
  );
  assert.equal(timeoutLondon?.outletId, 'timeout-london');

  // Sunday-paper editions: the bare origin and the full URL resolve to the
  // SAME (eponymous-wins) outlet regardless of path — no path signal exists,
  // so this must return null, not guess.
  assert.equal(
    resolveOutletFromUrlIfPathInformed('https://www.telegraph.co.uk/theatre/2026/09/24/whatever-review/'),
    null
  );
  assert.equal(
    resolveOutletFromUrlIfPathInformed('https://www.express.co.uk/entertainment/theatre/whatever-review'),
    null
  );

  // An ordinary single-outlet domain is never "path informed".
  assert.equal(
    resolveOutletFromUrlIfPathInformed('https://www.nytimes.com/2026/09/24/theater/whatever.html'),
    null
  );

  assert.equal(resolveOutletFromUrlIfPathInformed(''), null);
  assert.equal(resolveOutletFromUrlIfPathInformed(null), null);
  assert.equal(resolveOutletFromUrlIfPathInformed('not a url'), null);
});

// ── 2. resolveCanonicalOutletId — the shared operator-input + URL entry point ──

test('BRO-4153: a generic "timeout" operator input is overridden by a /london URL', () => {
  const resolved = resolveCanonicalOutletId({
    outletArg: 'timeout',
    url: 'https://www.timeout.com/london/theatre/my-neighbour-totoro-review',
  });
  assert.equal(resolved.outletId, 'timeout-london');
  assert.equal(resolved.source, 'url');
  assert.match(resolved.warning || '', /drift detected/);
});

test('BRO-4153: a generic "timeout-london" operator input is overridden by a non-/london URL', () => {
  const resolved = resolveCanonicalOutletId({
    outletArg: 'timeout-london',
    url: 'https://www.timeout.com/newyork/theater/school-girls-1',
  });
  assert.equal(resolved.outletId, 'timeout');
  assert.equal(resolved.source, 'url');
});

test('a "timeout" operator input + a /newyork URL agree — no drift warning', () => {
  const resolved = resolveCanonicalOutletId({
    outletArg: 'timeout',
    url: 'https://www.timeout.com/newyork/theater/school-girls-1',
  });
  assert.equal(resolved.outletId, 'timeout');
  assert.equal(resolved.warning, null);
});

// ── 3. Sunday-paper collisions: decided, not silently guessed ───────────────

test('BRO-4153: telegraph/express Sunday-paper collisions are declared edition pairs, not resolved by URL', () => {
  const declared = EDITION_PAIRS.map((pair) => [...pair].sort());
  assert.deepEqual(declared.find((p) => p.includes('telegraph')), ['sunday-telegraph', 'telegraph'].sort());
  assert.deepEqual(declared.find((p) => p.includes('express-uk')), ['express-uk', 'sunday-express'].sort());
  assert.deepEqual(declared.find((p) => p.includes('timeout')), ['timeout', 'timeout-london'].sort());

  // Operator input is trusted as-is for these (URL truly cannot disambiguate),
  // unlike timeout.com above.
  const sundayTelegraph = resolveCanonicalOutletId({
    outletArg: 'sunday-telegraph',
    url: 'https://www.telegraph.co.uk/theatre/2026/09/24/whatever-review/',
  });
  assert.equal(sundayTelegraph.outletId, 'sunday-telegraph');
  assert.equal(sundayTelegraph.source, 'alias');
});

// ── 4. Corpus assertion helper ───────────────────────────────────────────────

/**
 * Scan a review-texts checkout for files whose CURRENT `url` field disagrees
 * with their `outletId` on the timeout.com/london split. Deliberately keys
 * off `url` only (not previousUrl/urlCorrectedFrom/playbillVerdictUrl, which
 * legitimately retain a stale edition's URL as an audit trail once corrected —
 * see back-to-the-future-west-end-2021/timeout--adam-feldman.json).
 *
 * Classifies via resolveOutletFromUrlIfPathInformed() itself — the same
 * production resolver every caller in this ticket was wired to — rather than
 * a hand-rolled regex, so this assertion can never drift out of sync with
 * what the real path-split rule (timeout.com/co.uk, /london vs default)
 * actually decides (a Codex review of this ticket's first draft flagged the
 * duplicated-regex version as a real divergence risk: an unanchored `/london\//`
 * match doesn't agree with production's `pathname.startsWith('/london')` on
 * inputs like `/london-fringe/...`).
 *
 * @returns {Array<{file: string, outletId: string, url: string, expected: string}>}
 */
function findTimeoutLondonMisattributions(reviewTextsDir) {
  const violations = [];
  if (!fs.existsSync(reviewTextsDir)) return violations;
  for (const showDir of fs.readdirSync(reviewTextsDir)) {
    const showPath = path.join(reviewTextsDir, showDir);
    let stat;
    try {
      stat = fs.statSync(showPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(showPath)) {
      if (!file.endsWith('.json')) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8'));
      } catch {
        continue;
      }
      if (!data || !data.url) continue;
      if (data.outletId !== 'timeout' && data.outletId !== 'timeout-london') continue;
      const resolved = resolveOutletFromUrlIfPathInformed(data.url);
      if (resolved && resolved.outletId !== data.outletId) {
        violations.push({ file: `${showDir}/${file}`, outletId: data.outletId, url: data.url, expected: resolved.outletId });
      }
    }
  }
  return violations;
}

test('findTimeoutLondonMisattributions: detects both directions against a fixture, ignores clean files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-london-fixture-'));
  try {
    const showA = path.join(tmpDir, 'show-a');
    fs.mkdirSync(showA);
    // Violation: London review filed under the NY outlet id.
    fs.writeFileSync(
      path.join(showA, 'timeout--critic-one.json'),
      JSON.stringify({ outletId: 'timeout', url: 'https://www.timeout.com/london/theatre/show-a-review' })
    );
    // Violation: NY review filed under the London outlet id.
    fs.writeFileSync(
      path.join(showA, 'timeout-london--critic-two.json'),
      JSON.stringify({ outletId: 'timeout-london', url: 'https://www.timeout.com/newyork/theater/show-a-review' })
    );
    // Clean: correctly attributed on both sides.
    fs.writeFileSync(
      path.join(showA, 'timeout--critic-three.json'),
      JSON.stringify({ outletId: 'timeout', url: 'https://www.timeout.com/newyork/theater/show-a-review-2' })
    );
    fs.writeFileSync(
      path.join(showA, 'timeout-london--critic-four.json'),
      JSON.stringify({ outletId: 'timeout-london', url: 'https://www.timeout.com/london/theatre/show-a-review-2' })
    );
    // Unrelated outlet — never flagged.
    fs.writeFileSync(
      path.join(showA, 'guardian--critic-five.json'),
      JSON.stringify({ outletId: 'guardian', url: 'https://www.theguardian.com/stage/show-a-review' })
    );
    // A stale previousUrl-only mention must NOT be flagged (matches the real
    // back-to-the-future-west-end-2021 case: current url already corrected).
    fs.writeFileSync(
      path.join(showA, 'timeout--critic-six.json'),
      JSON.stringify({
        outletId: 'timeout',
        url: 'https://www.timeout.com/newyork/theater/show-a-review-3',
        previousUrl: 'https://www.timeout.com/london/theatre/stale-review',
      })
    );

    const found = findTimeoutLondonMisattributions(tmpDir);
    assert.deepEqual(
      found.map((v) => v.file).sort(),
      ['show-a/timeout--critic-one.json', 'show-a/timeout-london--critic-two.json'].sort()
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findTimeoutLondonMisattributions: a missing directory is not an error', () => {
  assert.deepEqual(findTimeoutLondonMisattributions('/nonexistent/path/for/sure'), []);
});

// ── Real corpus assertion — corpus-presence gated, same contract as
// scripts/verify-frankie-2002-cleanup.test.mjs: skips locally when
// data/review-texts isn't a real checkout (the unit-tests CI job never checks
// one out); REQUIRE_REVIEW_CORPUS=1 (set by the data-validation job's re-run
// after checkout-review-texts) turns a missing/empty corpus into a hard
// failure instead of a silent skip. ────────────────────────────────────────

const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const MIN_CORPUS_ENTRIES = 10;

function corpusUsable() {
  const ok = fs.existsSync(REVIEW_TEXTS_DIR) && fs.readdirSync(REVIEW_TEXTS_DIR).length > MIN_CORPUS_ENTRIES;
  if (REQUIRE_CORPUS) {
    assert.ok(ok,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} isn't a real corpus (>${MIN_CORPUS_ENTRIES} entries expected) — the review-texts checkout did not land, so this test would have silently skipped. Fix the checkout rather than unsetting the flag.`);
    return true;
  }
  return ok;
}

test(
  'BRO-4153: the real review-texts corpus has zero timeout/timeout-london URL misattributions',
  { skip: !corpusUsable() && `no usable corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)` },
  () => {
    const violations = findTimeoutLondonMisattributions(REVIEW_TEXTS_DIR);
    assert.deepEqual(violations, [], `found ${violations.length} misattributed file(s): ${JSON.stringify(violations, null, 2)}`);
  },
);
