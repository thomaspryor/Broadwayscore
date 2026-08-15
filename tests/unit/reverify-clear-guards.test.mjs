/**
 * Guards for the CV-promoted re-verification sweeps.
 *
 * Incident these lock down (2026-08-15 04:03-04:36 UTC): reverify-stale-cv-promoted.js
 * cleared exclusion flags from fresh Gemini verdicts and produced six CI errors,
 * including a manufactured same-URL duplicate. Every test below is written as a
 * sabotage pair — the case the guard MUST refuse, and the neighbouring legitimate
 * case it must still permit — because a refusal guard that refuses everything is
 * just a different outage (it strands recoverable reviews as permanently excluded).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const { assessClearSafety, detectTitleMismatch, detectNonReviewAdmission, findSameUrlIncludableSibling } =
  require(path.join(repoRoot, 'scripts/lib/reverify-clear-guards.js'));

const HIGH = { isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false, confidence: 'high', reasoning: 'A clear review of the production at the named venue.' };

function tmpShow(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverify-guards-'));
  const showDir = path.join(dir, 'some-show-2026');
  fs.mkdirSync(showDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify(data, null, 2));
  }
  return { dir, showDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A minimally-includable review record: no exclusion flags, real text, real score.
function includableRecord(over = {}) {
  return {
    outlet: 'Variety', critic: 'Jane Doe', url: 'https://variety.com/review-a',
    fullText: 'x'.repeat(1200), assignedScore: 80, contentTier: 'complete',
    publishDate: '2026-05-02',
    ...over,
  };
}

// ────────────────────────── GUARD 1: same-URL collision ──────────────────────────

test('GUARD 1 REFUSES: clearing would collide with an already-includable same-URL sibling', () => {
  const { showDir, cleanup } = tmpShow({
    'variety--jane-doe.json': includableRecord({ wrongShow: true, wrongShowReason: 'cv-promoted' }),
    'variety--unknown.json': includableRecord(), // same URL, already includable
  });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hit = findSameUrlIncludableSibling({ filePath, data, show: null });
    assert.ok(hit, 'must detect the includable same-URL sibling');
    assert.equal(hit.sibling, 'variety--unknown.json');

    const { safe, refusals } = assessClearSafety({ filePath, data, show: null, result: HIGH, showTitle: 'Some Show' });
    assert.equal(safe, false, 'a clear that manufactures a same-URL duplicate must be refused');
    assert.ok(refusals.some(r => r.code === 'same-url-collision'));
  } finally { cleanup(); }
});

test('GUARD 1 PERMITS: no sibling shares the URL', () => {
  const { showDir, cleanup } = tmpShow({
    'variety--jane-doe.json': includableRecord({ wrongShow: true }),
    'nyt--other.json': includableRecord({ url: 'https://nytimes.com/different-article' }),
  });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(findSameUrlIncludableSibling({ filePath, data, show: null }), null);
    const { safe } = assessClearSafety({ filePath, data, show: null, result: HIGH, showTitle: 'Some Show' });
    assert.equal(safe, true, 'a legitimate clear with no URL collision must still be permitted');
  } finally { cleanup(); }
});

test('GUARD 1 PERMITS: same-URL sibling exists but is itself EXCLUDED (no duplicate pair possible)', () => {
  const { showDir, cleanup } = tmpShow({
    'variety--jane-doe.json': includableRecord({ wrongShow: true }),
    'variety--unknown.json': includableRecord({ isNonReview: true, rejectionReason: 'not_a_review' }),
  });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(findSameUrlIncludableSibling({ filePath, data, show: null }), null,
      'an excluded sibling cannot form the duplicate pair — refusing on it would strand recoverable reviews');
  } finally { cleanup(); }
});

test('GUARD 1 uses the canonical normalizer: tracking params / case / trailing slash still collide', () => {
  const { showDir, cleanup } = tmpShow({
    'variety--jane-doe.json': includableRecord({ url: 'https://Variety.com/review-a/?utm_source=twitter#top', wrongShow: true }),
    'variety--unknown.json': includableRecord({ url: 'https://variety.com/review-a' }),
  });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hit = findSameUrlIncludableSibling({ filePath, data, show: null });
    assert.ok(hit, 'hand-rolled string equality would miss this; the canonical normalizer must not');
  } finally { cleanup(); }
});

test('GUARD 1 tolerates a corrupt sibling and a missing URL without throwing', () => {
  const { showDir, cleanup } = tmpShow({ 'variety--jane-doe.json': includableRecord({ wrongShow: true }) });
  try {
    fs.writeFileSync(path.join(showDir, 'broken.json'), '{not json');
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.doesNotThrow(() => findSameUrlIncludableSibling({ filePath, data, show: null }));
    assert.equal(findSameUrlIncludableSibling({ filePath, data: { url: null }, show: null }), null);
  } finally { cleanup(); }
});

// ───────────────────── GUARD 2: title mismatch in the verdict ─────────────────────

test('GUARD 2 REFUSES: the real Juniper Blood verdict (states the mismatch, returns wrongArticle:false)', () => {
  // Verbatim shape of the verdict that reached a live review on 2026-08-15.
  const reasoning = 'The content’s show title is "Juniper Blood", not "Blood of my Blood", '
    + 'however the venue is the Royal Court Theatre which matches the expected West End venue, '
    + 'so this appears to be the correct production.';
  const hit = detectTitleMismatch({ reasoning, showTitle: 'Blood of my Blood' });
  assert.ok(hit, 'the verdict states the mismatch in its own reasoning — it must be caught');
  assert.equal(hit.quotedTitle, 'Juniper Blood');

  const { safe, refusals } = assessClearSafety({
    filePath: '/nonexistent/some-show-2026/timeout-london--x.json',
    data: { url: 'https://timeout.com/london/juniper-blood-review' },
    show: null, result: { ...HIGH, reasoning }, showTitle: 'Blood of my Blood',
  });
  assert.equal(safe, false, 'wrongArticle:false + confidence:high must NOT be enough to clear');
  assert.ok(refusals.some(r => r.code === 'title-mismatch-in-reasoning'));
});

test('GUARD 2 REFUSES: the Here We Are / Here There Are Blueberries title-prefix collision', () => {
  const reasoning = 'The article is a review of "Here We Are" by Stephen Sondheim, not '
    + '"Here There Are Blueberries", but the venue string matches.';
  const hit = detectTitleMismatch({ reasoning, showTitle: 'Here There Are Blueberries' });
  assert.ok(hit, 'a title-PREFIX collision must not be waved through by containment matching');
});

test('GUARD 2 PERMITS: reasoning quotes the show’s OWN title, with case/punctuation drift', () => {
  for (const reasoning of [
    'This is a clear review of "Blood Of My Blood" at the Royal Court Theatre.',
    'A review of “Blood of my Blood” — not a preview.',
    'The content reviews "Blood of my Blood," praising the staging.',
  ]) {
    assert.equal(detectTitleMismatch({ reasoning, showTitle: 'Blood of my Blood' }), null,
      `must not refuse on the show's own title: ${reasoning}`);
  }
});

test('GUARD 2 PERMITS: a quoted pull-quote or venue with no contrast cue nearby', () => {
  const reasoning = 'The critic calls it "a triumph of staging" and praises the ensemble at the Royal Court Theatre.';
  assert.equal(detectTitleMismatch({ reasoning, showTitle: 'Blood of my Blood' }), null,
    'quoted prose that is not held up against the show title must not trip the guard');
});

test('GUARD 2 PERMITS: subtitle variants are the same show', () => {
  assert.equal(detectTitleMismatch({
    reasoning: 'A review of "Death Note" at the Barbican, not a preview.',
    showTitle: 'Death Note: The Musical',
  }), null, 'subtitle drift must not read as a different show');
});

test('GUARD 2 is inert when it has nothing to judge', () => {
  assert.equal(detectTitleMismatch({ reasoning: '', showTitle: 'X Y Z' }), null);
  assert.equal(detectTitleMismatch({ reasoning: 'anything "Other Show" not', showTitle: '' }), null);
  assert.equal(detectTitleMismatch({ reasoning: null, showTitle: null }), null);
});

// The production verdicts used SINGLE quotes. A double-quote-only miner passes
// every hand-written fixture above and still misses the case that shipped, so
// these two are verbatim from the corpus (contentVerification.previousVerification
// .reasoning on the two records a human had to retract on 2026-08-15).
test('GUARD 2 REFUSES: VERBATIM production verdict text, single-quoted titles', () => {
  const juniper = "The scraped content is a review from TimeOut, but it's for a play called "
    + "'Juniper Blood' at an unspecified venue, not 'Blood of my Blood' at the Royal Court. "
    + 'The content is also truncated.';
  const hit = detectTitleMismatch({ reasoning: juniper, showTitle: 'Blood of my Blood' });
  assert.ok(hit, 'the apostrophe in "it\'s" must not stop the single-quote miner');
  assert.equal(hit.quotedTitle, 'Juniper Blood');

  const blueberries = "The scraped content is a review of 'Here We Are', not 'Here There Are Blueberries'.";
  assert.ok(detectTitleMismatch({ reasoning: blueberries, showTitle: 'Here There Are Blueberries (Theatre Royal Stratford East)' }));
});

test('GUARD 2 PERMITS: apostrophes in ordinary prose do not manufacture a mismatch', () => {
  for (const reasoning of [
    "It's a strong review and the critics' consensus is positive; it isn't truncated.",
    "The reviewer doesn't hedge — she's emphatic about the staging's ambition.",
  ]) {
    assert.equal(detectTitleMismatch({ reasoning, showTitle: 'Blood of my Blood' }), null,
      `apostrophe prose must not trip the guard: ${reasoning}`);
  }
});

// ───────────────── GUARD 4: reasoning admits the content is not a review ─────────────────

test('GUARD 4 REFUSES: VERBATIM death-note verdict (admits "preview", cleared anyway)', () => {
  const reasoning = "The content is a preview for 'Death Note: The Musical' at the Barbican Centre, "
    + 'published before the opening date. It describes the plot and production details rather than '
    + 'offering a critical assessment of a performance.';
  const hit = detectNonReviewAdmission({ reasoning });
  assert.ok(hit, 'a verdict that calls the content a preview must not clear a non-review exclusion');

  const { safe, refusals } = assessClearSafety({
    filePath: '/nonexistent/death-note-the-musical-west-end-2026/timeout-london--unknown.json',
    data: { url: 'https://timeout.com/london/death-note-review' },
    show: null, result: { ...HIGH, reasoning }, showTitle: 'Death Note: The Musical',
  });
  assert.equal(safe, false);
  assert.ok(refusals.some(r => r.code === 'non-review-admitted-in-reasoning'));
});

test('GUARD 4 REFUSES: roundup / pull-quote admissions', () => {
  for (const reasoning of [
    'This is a preview/news roundup synthesizing other critics’ verdicts on the musical, not an original review.',
    'The content is a collection of review snippets from various outlets.',
    'There is no original critical assessment attributed to the named critic.',
    'It does not offer a critical assessment; it reads as promotional material or a preview.',
  ]) {
    assert.ok(detectNonReviewAdmission({ reasoning }), `must catch: ${reasoning}`);
  }
});

test('GUARD 4 PERMITS: negated forms and genuine review verdicts', () => {
  for (const reasoning of [
    'This is a review, not a preview.',
    'The content is a full critical assessment of opening night; it is not a roundup.',
    'A clear review of the production, published the morning after press night.',
  ]) {
    assert.equal(detectNonReviewAdmission({ reasoning }), null,
      `must NOT refuse a genuine review verdict: ${reasoning}`);
  }
  assert.equal(detectNonReviewAdmission({ reasoning: '' }), null);
  assert.equal(detectNonReviewAdmission({ reasoning: null }), null);
});

// ───────────────────── GUARD 3: confidence gate on every path ─────────────────────

test('GUARD 3 REFUSES: medium/low/missing confidence on a wrongShow-only clear (was ungated)', () => {
  const { showDir, cleanup } = tmpShow({ 'variety--jane-doe.json': includableRecord({ wrongShow: true }) });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const confidence of ['medium', 'low', undefined, null]) {
      const { safe, refusals } = assessClearSafety({
        filePath, data, show: null, result: { ...HIGH, confidence }, showTitle: 'Some Show',
      });
      assert.equal(safe, false, `confidence=${confidence} must not clear`);
      assert.ok(refusals.some(r => r.code === 'low-confidence'));
    }
  } finally { cleanup(); }
});

test('GUARD 3 PERMITS: high confidence, no collision, no title mismatch → the clear goes through', () => {
  const { showDir, cleanup } = tmpShow({ 'variety--jane-doe.json': includableRecord({ wrongShow: true }) });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { safe, refusals } = assessClearSafety({ filePath, data, show: null, result: HIGH, showTitle: 'Some Show' });
    assert.equal(safe, true, 'the guards must still permit a legitimate clear');
    assert.deepEqual(refusals, []);
  } finally { cleanup(); }
});

test('refusals accumulate — a record failing all three reports all three', () => {
  const { showDir, cleanup } = tmpShow({
    'variety--jane-doe.json': includableRecord({ wrongShow: true }),
    'variety--unknown.json': includableRecord(),
  });
  try {
    const filePath = path.join(showDir, 'variety--jane-doe.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { safe, refusals } = assessClearSafety({
      filePath, data, show: null, showTitle: 'Blood of my Blood',
      result: { ...HIGH, confidence: 'medium', reasoning: 'The show title is "Juniper Blood", not "Blood of my Blood".' },
    });
    assert.equal(safe, false);
    assert.deepEqual(refusals.map(r => r.code).sort(),
      ['low-confidence', 'same-url-collision', 'title-mismatch-in-reasoning']);
  } finally { cleanup(); }
});
