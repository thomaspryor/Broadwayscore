/**
 * replay-pending-bylines: validate before promoting a stranded _pending review.
 *
 * Incident 2026-06-04 (Beetlejuice WE): the _pending drain promoted junk it found
 * stranded — three WestEndTheatre-roundup URLs filed under telegraph/thestage/times
 * (fabricating fake outlet reviews with the roundup author's byline), a Justin Theroux
 * FILM article, and a Tim Burton interview — all because they mention "Beetlejuice".
 * pendingPromoteRejectReason gates promotion on: aggregator/listing URL, non-theatre
 * news section (wrong production, same title), and verifyAggregatorUrl show-match.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pendingPromoteRejectReason } = require('../../scripts/replay-pending-bylines.js');

const SHOW = { id: 'beetlejuice-west-end-2026', title: 'Beetlejuice', venue: 'Shaftesbury Theatre', openingDate: '2026-05-28' };
const titled = (t) => `<html><head><title>${t}</title></head><body>${t}</body></html>`;
// Same title + a machine-readable publish date (JSON-LD), so the temporal gate
// has a date to act on while checks 1–3 (title token) still pass.
const titledDated = (t, isoDate) =>
  `<html><head><title>${t}</title>` +
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: isoDate })}</script>` +
  `</head><body>${t}</body></html>`;

describe('pendingPromoteRejectReason', () => {
  test('REJECTS a WestEndTheatre roundup URL filed under an outlet', () => {
    const r = pendingPromoteRejectReason(
      'https://www.westendtheatre.com/356598/news/reviews/beetlejuice-the-musical-reviews/',
      titled('Beetlejuice the Musical reviews roundup'), SHOW);
    assert.ok(r && /aggregator/.test(r), `expected aggregator reject, got ${r}`);
  });

  test('REJECTS a same-title FILM article (wrong production)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/film/article/justin-theroux-jennifer-aniston-beetlejuice',
      titled('Justin Theroux on Beetlejuice'), SHOW);
    assert.ok(r && /non-theatre section \(film\)/.test(r), `expected film reject, got ${r}`);
  });

  // Narrowed 2026-06-05 (ship-check): outlets file REAL theatre reviews under
  // tv/music/lifestyle sections (Daily Mail /tv/, USA Today /entertainment/music/,
  // WashPost /lifestyle/), so those sections must NOT auto-reject — that was destroying
  // real reviews. A genuine theatre review under a /tv/ section is promoted; a same-title
  // interview is left to the downstream LLM non-review classifier, not this URL gate.
  test('does NOT reject a real theatre review filed under /tv/ (false-positive guard)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.dailymail.co.uk/tv/article-15559075/review-Shadowlands-London-Aldwych-Theatre.html',
      titled('Beetlejuice review — Aldwych Theatre'), SHOW);
    assert.equal(r, null, `a real review under /tv/ must not be section-rejected, got ${r}`);
  });

  test('REJECTS a different show entirely (show-match)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/war-horse-review',
      titled('War Horse review'), SHOW);
    assert.ok(r && /not this show/.test(r), `expected show-match reject, got ${r}`);
  });

  test('ALLOWS a genuine theatre review of the right show', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/beetlejuice-review-shaftesbury',
      titled('Beetlejuice review — Shaftesbury Theatre'), SHOW);
    assert.equal(r, null, `expected promote-OK, got reject: ${r}`);
  });
});

// Incident 2026-07-19 (Treneman/Oresteia): the drain promoted a 2017 Edinburgh
// Fringe "Oresteia: This Restless House" Times review into the 2026 West End
// "The Oresteia" show dir and scored it 40. The URL slug carries the shared
// "oresteia" token (so the show-match gate passes) and has NO year segment (so
// the URL-year backstop never fired). Only the article's 2017 publish date
// separates the two same-title productions.
describe('pendingPromoteRejectReason — temporal wrong-production gate', () => {
  const ORESTEIA = {
    id: 'the-oresteia-west-end-2026', title: 'The Oresteia',
    previewsStartDate: '2026-07-02', openingDate: '2026-07-14',
    category: 'west-end', market: 'west-end',
  };
  // The exact stranded _pending URL from the incident.
  const TRENEMAN_URL = 'https://www.thetimes.com/uk/scotland/article/edinburgh-theatre-review-oresteia-this-restless-house-at-the-lyceum-theatre-stz2k8fpn';

  test('REJECTS the Treneman URL (2017 date) — earlier production, same title', () => {
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titledDated('Oresteia: This Restless House review', '2017-08-24'), ORESTEIA);
    assert.ok(r && /outside this production's window/.test(r), `expected temporal reject, got ${r}`);
  });

  test('honors a pre-extracted publishDate arg (4th param) over html', () => {
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titled('Oresteia review'), ORESTEIA, '2017-08-24');
    assert.ok(r && /outside this production's window/.test(r), `expected temporal reject, got ${r}`);
  });

  test('ALLOWS an in-window review of the current production (no false positive)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review-2026',
      titledDated('The Oresteia review', '2026-07-15'), ORESTEIA);
    assert.equal(r, null, `an in-window 2026 review must promote, got reject: ${r}`);
  });

  test('does NOT reject when the article has no extractable date (uncertain → promote)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review',
      titled('The Oresteia review'), ORESTEIA);
    assert.equal(r, null, `dateless article must not be temporally rejected, got ${r}`);
  });

  test('ALLOWS an earlier-run review covered by a declared priorRun', () => {
    const show = { ...ORESTEIA, priorRuns: [{ openingDate: '2017-08-01', closingDate: '2017-09-01', venue: 'Royal Lyceum Edinburgh' }] };
    const r = pendingPromoteRejectReason(
      TRENEMAN_URL, titledDated('Oresteia review', '2017-08-24'), show);
    assert.equal(r, null, `a declared priorRun window must exempt the date, got reject: ${r}`);
  });
});

// BRO-1391 byline-explosion root cause: Times UK / WhatsOnStage article pages carry a
// rotating "more from our critics" widget, so extractAuthorFromHtml/extractHighConfidenceAuthor
// can return a DIFFERENT critic name for the SAME url on different fetches. Multiple _pending
// stub files for that one url (one per discovery event: RSS, SERP, aggregator crosslink) each
// promoted under a distinct {outlet}--{critic}.json filename, since the promotion guard only
// checked "does this exact target filename already exist" — never "is this url already a
// promoted primary under a different name". findExistingFileForUrl closes that gap by scanning
// the show dir for an existing file (same outlet) whose canonicalReviewUrl matches, so a second
// promotion attempt files itself as a duplicate instead of a sibling primary.
//
// BRO-3550: findExistingFileForUrl + its terminal-canonical resolution now live in
// scripts/lib/review-url-clusters.js (pure, takes the review-texts root as an explicit
// param) so both replay-pending-bylines.js's _pending drain AND collect-review-texts.js's
// primary collection pipeline share one implementation instead of a second, divergent copy.
// Testing the lib directly means no more fixture-script-copy trick — just a plain tmp dir.
describe('findExistingFileForUrl (scripts/lib/review-url-clusters.js)', () => {
  const { findExistingFileForUrl } = require('../../scripts/lib/review-url-clusters.js');

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'find-existing-file-for-url-'));
  const reviewTextsDir = path.join(fixtureRoot, 'data', 'review-texts');
  fs.mkdirSync(reviewTextsDir, { recursive: true });

  const showDir = path.join(reviewTextsDir, 'test-show-2026');
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(
    path.join(showDir, 'times-uk--ann-treneman.json'),
    JSON.stringify({ url: 'https://www.thetimes.com/article/some-review-abc123' }),
  );
  fs.writeFileSync(
    path.join(showDir, 'financialtimes--sarah-hemming.json'),
    JSON.stringify({ url: 'https://www.ft.com/some-other-review' }),
  );

  test('matches an exact URL under the same outlet', () => {
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'test-show-2026', 'times-uk', 'https://www.thetimes.com/article/some-review-abc123'),
      'times-uk--ann-treneman.json',
    );
  });

  test('matches through query-string/hash/trailing-slash scrape variants', () => {
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'test-show-2026', 'times-uk', 'https://www.thetimes.com/article/some-review-abc123?eafs_enabled=false'),
      'times-uk--ann-treneman.json',
    );
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'test-show-2026', 'times-uk', 'https://www.thetimes.com/article/some-review-abc123/#comments'),
      'times-uk--ann-treneman.json',
    );
  });

  test('does not cross-match a different outlet at the same show', () => {
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'test-show-2026', 'times-uk', 'https://www.ft.com/some-other-review'),
      null,
    );
  });

  test('returns null for a show with no review-texts dir', () => {
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'no-such-show-2099', 'times-uk', 'https://example.com/x'),
      null,
    );
  });

  test('returns null when the outlet exists but the URL does not match', () => {
    assert.equal(
      findExistingFileForUrl(reviewTextsDir, 'test-show-2026', 'times-uk', 'https://www.thetimes.com/article/unrelated-review-xyz'),
      null,
    );
  });

  // rebuild-all-reviews.js's duplicateOf resolution only walks ONE hop back — a
  // file whose duplicateOf target is ITSELF a duplicate is not excluded there,
  // so it leaks into reviews.json as a second scored copy of the same content
  // (Codex adversarial review, BRO-1391). A THIRD promotion for the same url
  // must resolve to the terminal canonical, not to whichever sibling readdir
  // happens to return first.
  describe('chain resolution (rebuild-all-reviews.js duplicateOf is single-hop)', () => {
    const chainShowDir = path.join(reviewTextsDir, 'chain-show-2026');
    fs.mkdirSync(chainShowDir, { recursive: true });
    fs.writeFileSync(
      path.join(chainShowDir, 'times-uk--zzz-canonical.json'),
      JSON.stringify({ url: 'https://www.thetimes.com/article/chain-review-1' }),
    );
    fs.writeFileSync(
      path.join(chainShowDir, 'times-uk--aaa-first-dupe.json'),
      JSON.stringify({ url: 'https://www.thetimes.com/article/chain-review-1', duplicateOf: 'times-uk--zzz-canonical.json' }),
    );

    test('resolves through an intermediate duplicate to the terminal canonical', () => {
      assert.equal(
        findExistingFileForUrl(reviewTextsDir, 'chain-show-2026', 'times-uk', 'https://www.thetimes.com/article/chain-review-1'),
        'times-uk--zzz-canonical.json',
      );
    });

    test('does not hang on a pre-existing cycle among siblings', () => {
      const cycleShowDir = path.join(reviewTextsDir, 'cycle-show-2026');
      fs.mkdirSync(cycleShowDir, { recursive: true });
      fs.writeFileSync(
        path.join(cycleShowDir, 'times-uk--a.json'),
        JSON.stringify({ url: 'https://www.thetimes.com/article/cycle-review', duplicateOf: 'times-uk--b.json' }),
      );
      fs.writeFileSync(
        path.join(cycleShowDir, 'times-uk--b.json'),
        JSON.stringify({ url: 'https://www.thetimes.com/article/cycle-review', duplicateOf: 'times-uk--a.json' }),
      );
      const result = findExistingFileForUrl(reviewTextsDir, 'cycle-show-2026', 'times-uk', 'https://www.thetimes.com/article/cycle-review');
      assert.ok(result === 'times-uk--a.json' || result === 'times-uk--b.json', `expected a cycle member, got ${result}`);
    });
  });

  test.after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
});

// BRO-3550: collect-review-texts.js is the PRIMARY, 3x-daily collection pipeline —
// far higher traffic than the _pending drain above — and had the exact same gap:
// renameReviewFileForCriticOverride() only checked whether its freshly-computed
// target filename collided, never whether the url was already promoted under some
// OTHER filename. That function isn't require()-able directly (collect-review-texts.js
// has no module.exports and runs main() unconditionally on load), so this is a
// source-level assertion — same pattern as tests/unit/talkin-broadway-scraper.test.mjs
// and scripts/lib/collection-attempt-guard.test.mjs's wiring checks.
describe('BRO-3550: collect-review-texts.js wires findExistingFileForUrl into its rename/promotion path', () => {
  const collectSrc = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');

  test('imports findExistingFileForUrl from the shared lib', () => {
    const requireLine = collectSrc.split('\n').find(
      (l) => l.includes("require('./lib/review-url-clusters')"),
    );
    assert.ok(requireLine, 'collect-review-texts.js must require scripts/lib/review-url-clusters.js');
    assert.ok(
      requireLine.includes('findExistingFileForUrl'),
      'collect-review-texts.js must import findExistingFileForUrl from the shared lib',
    );
  });

  test('renameReviewFileForCriticOverride checks the shared URL guard before the exact-filename collision check', () => {
    const fnStart = collectSrc.indexOf('function renameReviewFileForCriticOverride(');
    assert.notEqual(fnStart, -1, 'renameReviewFileForCriticOverride not found — was it renamed? update this test');

    const guardIdx = collectSrc.indexOf('findExistingFileForUrl(', fnStart);
    assert.notEqual(guardIdx, -1, 'renameReviewFileForCriticOverride must call findExistingFileForUrl');

    const existsSyncIdx = collectSrc.indexOf('fs.existsSync(newPath)', fnStart);
    assert.notEqual(existsSyncIdx, -1, 'the exact-filename collision check must still exist (unchanged conflict handling)');

    assert.ok(
      guardIdx < existsSyncIdx,
      'the same-url-different-filename guard must run BEFORE the exact-filename collision check, ' +
        'otherwise a sibling promoted under a different name is never caught',
    );

    // The guard branch must mark duplicateOf onto the EXISTING sibling, not the
    // about-to-be-computed newFilename — that is the whole point of the check.
    const guardBranch = collectSrc.slice(guardIdx, existsSyncIdx);
    assert.ok(guardBranch.includes('data.duplicateOf = existingSameUrl'),
      'the guard branch must set data.duplicateOf to the existing same-url file');
  });
});
