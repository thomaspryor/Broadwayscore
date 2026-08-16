/**
 * Every show-title matcher must fold diacritics BEFORE it strips
 * non-alphanumerics. Sibling of tests/unit/title-tokens-diacritics.test.mjs,
 * which locks the same invariant for audit-show-review-gap.js::titleTokens.
 *
 * The class (task #648): our shows.json titles and showId slugs are largely
 * ASCII ("les-miserables-...") while outlets and aggregators spell shows
 * correctly with accents ("Les Misérables"). A matcher that lowercases and
 * then runs `.replace(/[^a-z0-9…]/g, …)` turns every accented letter into a
 * space or drops it, shredding one word into fragments that can match nothing:
 *
 *   "Les Misérables"  ->  ["les", "mis", "rables"]   (should be ["les","miserables"])
 *
 * Confirmed live: NY Sun's Les Misérables review (12 body mentions) was
 * dropped as url_content_mismatch on 2026-07-30 because content-quality.js
 * lacked the fold. Eight siblings carried the same latent hole; this file
 * locks all of them plus the canonical helper they now share.
 *
 * Two layers:
 *   1. Behavioral — each patched lib actually folds, on real corpus titles.
 *   2. Structural — a frozen baseline of scripts/lib files that still combine
 *      an ASCII char-class filter with NO fold. A NEW unfolded matcher fails
 *      this test, which is the only thing that stops the class recurring.
 *
 * Run: node --test tests/unit/sibling-matchers-diacritics.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = path.join(REPO, 'scripts/lib');
const SCRIPTS_ROOT = path.join(REPO, 'scripts');

const { foldDiacritics } = require('../../scripts/lib/title-match.js');

describe('foldDiacritics (canonical helper)', () => {
  it('folds composable diacritics to their ASCII base letter', () => {
    assert.strictEqual(foldDiacritics('Les Misérables'), 'Les Miserables');
    assert.strictEqual(foldDiacritics('El Último Sueño'), 'El Ultimo Sueno');
    assert.strictEqual(foldDiacritics('Dvořák'), 'Dvorak');
    assert.strictEqual(foldDiacritics('Jenůfa'), 'Jenufa');
    assert.strictEqual(foldDiacritics('Bad Kreyòl'), 'Bad Kreyol');
  });

  it('is the identity on ASCII — folding can never change an unaccented decision', () => {
    for (const s of ['Hamilton', "Joe Turner's Come and Gone", 'Oh, Mary!', 'Grown-Ups', '']) {
      assert.strictEqual(foldDiacritics(s), s);
    }
  });

  it('tolerates null/undefined instead of throwing', () => {
    assert.strictEqual(foldDiacritics(null), '');
    assert.strictEqual(foldDiacritics(undefined), '');
  });
});

describe('rss-discovery.titleMatchesShow (backs theatermania-discovery)', () => {
  const { titleMatchesShow } = require('../../scripts/lib/rss-discovery.js');

  it('matches an accented headline against our unaccented shows.json title', () => {
    assert.ok(titleMatchesShow('Review: Les Misérables at the Sondheim', 'Les Miserables'));
  });

  it('matches an unaccented headline against an accented shows.json title', () => {
    assert.ok(titleMatchesShow('Review: Les Miserables opens', 'Les Misérables'));
  });

  it('still refuses an unrelated show (folding must not loosen the 80% rule)', () => {
    assert.ok(!titleMatchesShow('Review: Les Misérables at the Sondheim', 'Hamilton'));
    assert.ok(!titleMatchesShow('Review: La Bohème at the Met', 'La Bête'));
  });
});

describe('omc-discovery.titleMatches', () => {
  const { titleMatches } = require('../../scripts/lib/omc-discovery.js');

  it('matches across the accent boundary in both directions', () => {
    assert.ok(titleMatches('Les Misérables review', 'Les Miserables'));
    assert.ok(titleMatches('Les Miserables review', 'Les Misérables'));
  });

  it('does not match a different show that merely shares an accented prefix', () => {
    assert.ok(!titleMatches('La Bohème at the Met', 'La Bête'));
  });
});

describe('show-score-discover.showScoreUrlForShow', () => {
  const { showScoreUrlForShow } = require('../../scripts/lib/show-score-discover.js');

  it('builds an ASCII-folded slug, not one shredded at the accent', () => {
    const url = showScoreUrlForShow({ id: 'x', title: 'Les Misérables', category: 'broadway' }, null);
    assert.strictEqual(url, 'https://www.show-score.com/broadway-shows/les-miserables');
    assert.ok(!url.includes('mis-rables'), 'accent must not become a slug separator');
  });

  it('folds off-Broadway opera titles too', () => {
    const url = showScoreUrlForShow({ id: 'x', title: 'La Bohème', category: 'off-broadway' }, null);
    assert.strictEqual(url, 'https://www.show-score.com/off-broadway-shows/la-boheme');
  });
});

describe('dtli-homepage-scan.tokensFromTitle', () => {
  const { tokensFromTitle, scoreSlugAgainstShow } = require('../../scripts/lib/dtli-homepage-scan.js');

  it('keeps an accented word whole instead of shredding it', () => {
    assert.deepStrictEqual(tokensFromTitle('Les Misérables'), ['les', 'miserables']);
    assert.deepStrictEqual(tokensFromTitle('La Bohème'), ['la', 'boheme']);
    for (const phantom of ['mis', 'rables', 'boh']) {
      assert.ok(!tokensFromTitle('Les Misérables: La Bohème').includes(phantom));
    }
  });

  it('scores the real DTLI slug for an accented show instead of rejecting it', () => {
    const show = { id: 'la-boheme-2002', title: 'La Bohème' };
    const score = scoreSlugAgainstShow('la-boheme-2002', show);
    assert.ok(score > -Infinity, `accented show must be able to match its own slug (got ${score})`);
  });
});

describe('venue-aliases._normalize (via findCanonical)', () => {
  const { findCanonical } = require('../../scripts/lib/venue-aliases.js');

  it('canonicalizes an ASCII rendering of an accented table venue', () => {
    // "Noël Coward Theatre" is a canonical VENUE_ALIASES entry. Reviews and
    // listings routinely write it ASCII; before the fold findCanonical returned
    // the input verbatim — a silent non-canonicalization, not an error.
    assert.strictEqual(findCanonical('Noel Coward Theatre'), 'Noël Coward Theatre');
  });

  it('still canonicalizes the accented spelling', () => {
    assert.strictEqual(findCanonical('Noël Coward Theatre'), 'Noël Coward Theatre');
  });
});

describe('creative-team-verify.normalizeForMatch', () => {
  const { normalizeForMatch } = require('../../scripts/lib/creative-team-verify.js');

  it('folds accented creative-team names so SERP snippets can confirm them', () => {
    assert.strictEqual(normalizeForMatch('Claude-Michel Schönberg'), 'claude-michel schonberg');
    assert.strictEqual(normalizeForMatch('Moisés Kaufman'), 'moises kaufman');
    assert.strictEqual(normalizeForMatch('Anaïs Mitchell'), 'anais mitchell');
  });

  it('still normalizes curly punctuation (the pre-existing contract)', () => {
    assert.strictEqual(normalizeForMatch('I’m Sorry, Prime Minister'), "i'm sorry, prime minister");
  });
});

describe('precursor-wikipedia.normalizeForCompare', () => {
  const { normalizeForCompare } = require('../../scripts/lib/precursor-wikipedia.js');

  it('folds so a Wikipedia ceremony row reaches our unaccented shows.json row', () => {
    assert.strictEqual(normalizeForCompare('Les Misérables'), 'les miserables');
    assert.strictEqual(normalizeForCompare('Phèdre'), 'phedre');
  });
});

describe('deduplication.normalizeTitle', () => {
  const { normalizeTitle } = require('../../scripts/lib/deduplication.js');

  it('gives accented and unaccented spellings the SAME dedup key', () => {
    assert.strictEqual(normalizeTitle('Les Misérables'), normalizeTitle('Les Miserables'));
    assert.strictEqual(normalizeTitle('La Bohème'), normalizeTitle('La Boheme'));
  });

  it('still keeps genuinely different titles apart', () => {
    assert.notStrictEqual(normalizeTitle('La Bohème'), normalizeTitle('La Bête'));
  });
});

/**
 * Structural guard. `.replace(/[^a-z0-9…]/…)` on lowercased text is the shred
 * signature: applied to a show title without a preceding fold, it destroys
 * every accented letter. The baseline below freezes the files that still carry
 * that combination as of task #648 — a NEW file with the signature and no fold
 * fails here.
 *
 * Two ways to satisfy this test when adding a matcher, in preference order:
 *   1. Call foldDiacritics() from scripts/lib/title-match.js (correct).
 *   2. If the input is provably ASCII already (a URL path, a slug we built),
 *      add the file to the baseline WITH a comment saying why.
 *
 * The baseline is a known-unfixed list, not an approved list — these are the
 * remaining candidates in the #648 class (several confirmed real: e.g.
 * loureviews-match.normalizeTitle, production-match-gate.titleSlugTokens,
 * url-utils.normalizeShowName all take show titles). Shrinking it is good;
 * growing it needs the justification above.
 */
// Task #760 shrank this from 34 to 3. Every removed entry was fixed by adding
// a foldDiacritics() call and parity-tested against the real corpus (2874
// shows, 29 with diacritics): foldDiacritics is the identity on all non-
// diacritic titles (proved above), so those 2845 decisions are provably
// unchanged; the 29 diacritic-bearing titles were spot-checked per function
// family (slug builders, token-set comparisons, and the 3 dual-sided haystack
// matches in content-verifier/score-input-validator/serp-slug-discovery) with
// zero matches lost. See task #760 commit message for the per-file summary.
const UNFOLDED_BASELINE = new Set([
  // route is one of our own hardcoded route paths ('/', '/show/hamilton') —
  // ASCII by construction, not a show title. See inline comment at the call site.
  'autonomous-ui-capture.js',
  // cross-production-guards.js FIXED under task #783: hay now folds via
  // foldDiacritics before the ASCII strip, matched against venue-
  // classification.js's shared venueSlug() (also folded) — the two audit
  // scripts that used to duplicate an unfolded venueSlug() now import it too.
  // response is an LLM's YES/NO answer text, not a show title. See inline
  // comment at the call site.
  'page-validator.js',
  // Task #1643 (manifest-drift audit surfaced this file was never running in
  // CI): 4 files added while this test was orphaned. tr-wrongshow-guard.js
  // (a real show-title matcher) was fixed alongside this baseline edit, not
  // added here — see its own foldDiacritics import.
  //
  // isAllEditorial() checks whether every remaining word of a candidate
  // headline is EDITORIAL_VOCAB furniture (all-ASCII English words); it is a
  // junk-vs-real-title heuristic filter, not the primary title matcher —
  // cleanCandidateTitle() in the same file is. A shredded accented word can
  // only ever read as "not editorial", which is already the correct answer.
  'aggregator-candidate-extract.js',
  // normalizeHostSlug() folds a DNS HOSTNAME, not a show title — hostnames
  // are ASCII by construction (punycode), so there is nothing to fold.
  'silent-exclusion-detectors.js',
  // normalizeSubject() keys internal Notion/task subject lines (this repo's
  // own task titles), not show titles — not the class this guard protects.
  'task-reclaim.js',
  // slugify()/coreTokens() here deliberately MIRROR src/lib/data-core.ts's
  // own slugify()/normalizeVenueName() (see this file's header) — data-
  // core.ts is unfolded too. Folding only here would make this audit check
  // a different pipeline than the one it exists to validate. Real fix is
  // upstream in data-core.ts; tracked separately, out of scope for #1643.
  'venue-complex-audit.js',
]);

// Task #781: the structural guard above only ever globbed scripts/lib — the
// same shred signature exists at scripts/ root scale (audit-*, backfill-*,
// discover-*, etc.) completely unscanned. This freezes that root-level debt
// as of #781 so CI stays green while still failing closed on any NEW root
// script that strips non-ASCII without folding first. Not a fix-it list —
// shrinking it (per-file, #760-style) is separate follow-up work. Two of
// these (audit-cross-production.js, audit-review-url-clusters.js) have a
// coordinated venueSlug() fix tracked in task #783.
const UNFOLDED_BASELINE_ROOT = new Set([
  'adjudicate-review-queue.js',
  'analyze-reviews.js',
  'audit-closing-dates.js',
  'audit-critic-coverage-bucket.js',
  'audit-critic-outlets.js',
  'audit-cross-production.js',
  'audit-data-integrity.js',
  'audit-duplicate-shows.js',
  'audit-reroute-backlog.js',
  'audit-review-content.js',
  'audit-review-duplicates.js',
  'audit-review-url-clusters.js',
  'audit-show-director-consensus.js',
  'audit-touring-contamination.js',
  'audit-url-validation.js',
  'audit-we-reviews.js',
  'auto-fix-show-data.js',
  'autonomous-run.js',
  'backfill-html-override-rename.js',
  'backfill-original-scores.js',
  'backfill-theaterlife-bylines.js',
  'batch-correct-reviews.js',
  'build-master-review-list.js',
  'check-opening-night-readiness.js',
  'cleanup-data-integrity.js',
  'collect-all-reviews.js',
  'collect-review-texts.js',
  'dedupe-same-url-bylines.js',
  'delete-misroute-orphans.js',
  'detect-cross-outlet-duplicates.js',
  'detect-syndicated-duplicates.js',
  'discover-dtli-slugs.js',
  'discover-new-shows.js',
  'discover-outlet-reviews-serp.js',
  'enrich-official-urls.js',
  'enrich-stubhub-links.js',
  'enrich-todaytix-data.js',
  'enrich-west-end-dates.js',
  'enrich-west-end-shows.js',
  'fetch-square-images.js',
  'fetch-synopses-wikipedia.js',
  'fix-contaminated-images.js',
  'fix-duplicates-and-zeros.js',
  'fix-unknown-critics.js',
  'gather-reviews.js',
  'health-check.js',
  'ingest-review-from-url.js',
  'linear-next.js',
  'merge-theater-research.js',
  'migrate-reroute-backlog.js',
  'newspapers-com-extract.js',
  'opening-night-poller.js',
  'paywall-browser-extract.js',
  'probe-wrong-show-staleness.js',
  'process-commercial-tip.js',
  'promote-ob-historical.js',
  'promote-ob-venue-candidates.js',
  'rebuild-all-reviews.js',
  'research-theater-scores.js',
  'reset-adjudication.js',
  'scrape-broadway-com-audience.js',
  'scrape-bww-reviews.js',
  'scrape-dtli.js',
  'scrape-wp-theater-blogs.js',
  'sweep-we-aggregators.js',
  'sync-review-texts.js',
  'test-discovery-flow.js',
  'update-commercial-data.js',
  'update-show-status.js',
  'validate-data.js',
  'validate-show-venue.js',
  'validate-stubhub-urls.js',
  'watch-aggregator-urls.js',
]);

// The shred signature: an ASCII-only character-class filter applied to text.
// Both the a-z and a-zA-Z spellings count — a matcher that keeps uppercase
// still destroys accented letters, so the class is not narrower than /[^a-z0-9.
// Task #790: a trailing 0-9 requirement here left NAME matchers (critic/cast
// bylines never contain digits, e.g. [^a-z ] or [^a-z\s]) completely invisible
// to this guard even though they shred accented names identically to a slug
// builder. The signature now stops at the a-z(A-Z)? prefix — any ASCII-only
// character class anchored there counts, digit or no digit.
const SHRED_SIGNATURE = /\.replace\(\/\[\^a-z(A-Z)?/;
// Every fold spelling in the codebase counts: foldDiacritics (the canonical
// helper), .normalize('NFD')/.normalize("NFD") in either quote style, NFKD,
// and the \p{Diacritic}/\p{M} property escapes review-guards.js:677 uses.
// Missing a real spelling here fails CLOSED (the file looks unfolded and, if
// unbaselined, reddens CI) — noisy but never silent.
const FOLDS = /foldDiacritics|normalize\((['"])NFK?D\1\)|\\p\{(Diacritic|M)\}/;

function scanUnfolded(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .filter(f => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      return SHRED_SIGNATURE.test(src) && !FOLDS.test(src);
    });
}

describe('structural guard: no NEW unfolded title matcher', () => {
  const unfolded = scanUnfolded(LIB);

  it('every file with the shred signature and no fold is in the frozen baseline', () => {
    const novel = unfolded.filter(f => !UNFOLDED_BASELINE.has(f));
    assert.deepStrictEqual(
      novel, [],
      `New scripts/lib matcher(s) strip non-ASCII without folding diacritics first:\n` +
      novel.map(f => `  scripts/lib/${f}`).join('\n') +
      `\nFix: import { foldDiacritics } from './title-match' and fold BEFORE the ` +
      `[^a-z0-9…] replace. See task #648 / this file's header.`
    );
  });

  it('title-match plus the nine libs it now feeds stay out of the baseline', () => {
    const fixed = [
      'title-match.js', 'rss-discovery.js', 'omc-discovery.js', 'theatermania-discovery.js',
      'show-score-discover.js', 'dtli-homepage-scan.js', 'venue-aliases.js',
      'creative-team-verify.js', 'precursor-wikipedia.js', 'deduplication.js',
      // task #783
      'cross-production-guards.js', 'venue-classification.js',
    ];
    for (const f of fixed) {
      assert.ok(!unfolded.includes(f), `${f} regressed: it lost its diacritic fold`);
      assert.ok(!UNFOLDED_BASELINE.has(f), `${f} must not be baselined — it is fixed`);
    }
  });
});

describe('structural guard: no NEW unfolded title matcher at scripts/ root (task #781)', () => {
  const unfolded = scanUnfolded(SCRIPTS_ROOT);

  it('every scripts/ root file with the shred signature and no fold is in the frozen baseline', () => {
    const novel = unfolded.filter(f => !UNFOLDED_BASELINE_ROOT.has(f));
    assert.deepStrictEqual(
      novel, [],
      `New scripts/ root matcher(s) strip non-ASCII without folding diacritics first:\n` +
      novel.map(f => `  scripts/${f}`).join('\n') +
      `\nFix: import { foldDiacritics } from './lib/title-match' and fold BEFORE the ` +
      `[^a-z0-9…] replace. See task #648 / #781 / this file's header.`
    );
  });

  it('a file fixed and removed from the root baseline must not regress', () => {
    for (const f of UNFOLDED_BASELINE_ROOT) {
      assert.ok(
        fs.existsSync(path.join(SCRIPTS_ROOT, f)),
        `${f} is baselined but no longer exists at scripts/ root — remove it from UNFOLDED_BASELINE_ROOT`
      );
    }
  });
});
