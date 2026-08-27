// Tests for scripts/lib/cast-extraction-guards.js — the post-extraction
// validator used by backfill-cast-web.js to reject wrong-show / corrupted
// cast extractions. See feedback_orphan_cast_invisible_by_design.md for
// the 12 historical contamination cases this catches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  validateCastExtraction,
  isOperaSourceUrl,
  scoreSerpResult,
  meaningfulTitleTokens,
  parseYearFromUrl,
  detectMarketMismatch,
  SERP_MIN_SCORE,
  isViableCastExtraction,
} = require('../../scripts/lib/cast-extraction-guards.js');

test('rejects Met Opera contamination (Kavalier-Clay case)', () => {
  const cast = [
    { name: 'Anna Netrebko', role: 'Abigaille' },
    { name: 'Lise Davidsen', role: 'Isolde' },
    { name: 'Michael Spyres', role: 'Tristan' },
    { name: 'Corinne Winters', role: 'Cavalleria rusticana' },
  ];
  const r = validateCastExtraction(cast, 'The Amazing Adventures of Kavalier and Clay');
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /opera-role-contamination/);
});

test('rejects TV-show role contamination (Much Ado case)', () => {
  const cast = [
    { name: 'Stevie Basaula', role: 'Isaac Baptiste' },
    { name: 'Shobu Kapoor', role: 'Bridgerton' },
    { name: 'Martina Laird', role: 'Unforgotten' },
  ];
  const r = validateCastExtraction(cast, 'Much Ado About Nothing');
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(','), /tv-role-contamination/);
});

test('rejects LASTNAME-FIRSTNAME name swap (Pride case)', () => {
  const cast = [
    { name: 'Jenkins Gethin', role: 'Darren' },
    { name: 'Williams Margaret', role: 'Matthew' },
    { name: 'Lumsden Mark', role: 'Kirsty' },
  ];
  const r = validateCastExtraction(cast, 'Pride');
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(','), /name-swap-pattern/);
});

test('passes clean cast and strips column-header roles', () => {
  const cast = [
    { name: 'Dylan Baker', role: 'Original' },     // column header → role stripped
    { name: 'Madeline Brewer', role: 'Raf Night' },
    { name: 'Hamish Linklater', role: 'Benjamin Braxton' },
  ];
  const r = validateCastExtraction(cast, 'The Disappear');
  assert.equal(r.ok, true);
  assert.deepEqual(r.cleaned[0], { name: 'Dylan Baker' });
  assert.equal(r.cleaned[1].role, 'Raf Night');
  assert.equal(r.cleaned[2].role, 'Benjamin Braxton');
});

test('passes legitimate UK/Irish cast', () => {
  const cast = [
    { name: 'Nicola Coughlan', role: 'Pegeen Mike' },
    { name: 'Éanna Hardwicke', role: 'Christy Mahon' },
    { name: 'Siobhán McSweeney', role: 'Widow Quin' },
  ];
  const r = validateCastExtraction(cast, 'The Playboy of the Western World');
  assert.equal(r.ok, true);
  assert.equal(r.reasons.length, 0);
});

test('allows opera-titled roles when show IS an opera', () => {
  const cast = [
    { name: 'Anna Netrebko', role: 'Abigaille' },
    { name: 'Lise Davidsen', role: 'Isolde' },
  ];
  const r = validateCastExtraction(cast, 'Met Opera 2025-26 Season');
  assert.equal(r.ok, true);
});

test('rejects empty cast', () => {
  const r = validateCastExtraction([], 'Anything');
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['empty']);
});

test('single column-header role does not trigger swap/contamination', () => {
  // Single name like "Williams Margaret" might be a real edge case, not a swap
  // pattern — require ≥2 to flag.
  const cast = [
    { name: 'Williams Margaret', role: 'Catherine' },
    { name: 'Nicola Coughlan', role: 'Pegeen Mike' },
  ];
  const r = validateCastExtraction(cast, 'Test Show');
  assert.equal(r.ok, true);
});

test('isOperaSourceUrl flags opera-publication domains', () => {
  // The historical Kavalier-Clay misroute
  assert.equal(isOperaSourceUrl('https://parterre.com/broadcast/104032/the-amazing-adventures-of-kavalier-clay/'), true);
  assert.equal(isOperaSourceUrl('https://www.metopera.org/season/2025-26/'), true);
  assert.equal(isOperaSourceUrl('https://operanews.com/some/article'), true);
  assert.equal(isOperaSourceUrl('https://www.operawire.com/anything'), true);
  // Non-opera domains
  assert.equal(isOperaSourceUrl('https://www.broadwayworld.com/shows/foo'), false);
  assert.equal(isOperaSourceUrl('https://playbill.com/production/bar'), false);
  // Defensive: null / empty / undefined
  assert.equal(isOperaSourceUrl(null), false);
  assert.equal(isOperaSourceUrl(''), false);
  assert.equal(isOperaSourceUrl(undefined), false);
});

// ============================================================================
// SERP-scoring parity tests — for each of the 11 cast files deleted in
// commit 5cf6b1a7c3, assert what the SERP scorer does today when given a
// realistic SERP title (not an empty string — empty under-approximates
// production scoring; an earlier version of this test missed cases that
// pass with real titles, flagged by Codex review on commit b02f090b1d).
//
// **Layered defense**: the SERP scorer is one of four cast-contamination
// defenses. When the scorer alone can't reject a URL, a downstream defense
// owns the case. Each fixture below names which layer catches it:
//   1. SERP scorer       (this file: score < SERP_MIN_SCORE)
//   2. Opera-source URL  (isOperaSourceUrl, pre-fetch skip)
//   3. validateCastExtraction (post-LLM, in scripts/lib/cast-extraction-guards.js)
//   4. LLM prompt year/venue match (in backfill-cast-web.js, probabilistic)
//
// `caughtBy` = which layer actually catches this URL when given a realistic
// SERP title. Only the SERP-scorer layer is enforced in this block; the
// other layers have their own tests (isOperaSourceUrl, validateCastExtraction)
// or are non-testable (LLM prompt).
// ============================================================================

const HISTORICAL_BAD_SOURCES = [
  {
    show: 'The Amazing Adventures of Kavalier & Clay',
    url: 'https://parterre.com/broadcast/104032/the-amazing-adventures-of-kavalier-clay/',
    serpTitle: 'Met Opera Podcast: Kavalier and Clay',
    note: 'Met Opera podcast — wrong show entirely',
    caughtBy: 'opera-source-url',  // isOperaSourceUrl(parterre.com) → skip before fetch
  },
  {
    show: 'Much Ado About Nothing',
    url: 'https://www.broadwayworld.com/westend/article/Cast-Announced-For-Shakespeares-Globes-SHAKESPEARE-IN-THE-ABBEY-20230329',
    serpTitle: 'Cast Announced For Shakespeares Globes SHAKESPEARE IN THE ABBEY',
    note: 'BWW article for Shakespeare in the Abbey (2023, different Globe show)',
    caughtBy: 'serp-scorer',
  },
  {
    show: 'Pride',
    url: 'https://www.broadwayworld.com/shows/Pride-335789/cast',
    serpTitle: 'Pride - Broadway Cast & Creative Team',
    note: 'BWW /shows/ page for a different Pride production',
    caughtBy: 'validate-cast-extraction',  // name-swap pattern in extracted cast
  },
  {
    show: 'Relics',
    url: 'https://www.londonboxoffice.co.uk/news/post/cast-updated-announced-for-west-end-production-of-oliver',
    serpTitle: 'Oliver West End cast announcement',
    note: 'Oliver cast page — wrong show',
    caughtBy: 'serp-scorer',
  },
  {
    show: "Love's Labour's Lost",
    url: 'https://www.rsc.org.uk/the-resistible-rise-of-arturo-ui/cast-and-creatives',
    serpTitle: 'Arturo Ui cast and creatives RSC',
    note: 'RSC Arturo Ui cast — wrong show',
    caughtBy: 'serp-scorer',
  },
  {
    show: 'Sting',
    url: 'https://thelastship-musical.com/cast-and-creatives/',
    serpTitle: 'The Last Ship - Cast & Creatives',
    note: 'The Last Ship musical cast — wrong show (Sting wrote it, not the same)',
    caughtBy: 'serp-scorer',
  },
  {
    show: "Godot's To-Do List",
    url: 'https://www.londonboxoffice.co.uk/news/post/new-west-end-cast-for-six-announced',
    serpTitle: 'New West End cast for Six announced',
    note: 'Six musical cast announcement — wrong show',
    caughtBy: 'serp-scorer',
  },
  {
    show: 'Little Women the Musical',
    url: 'https://www.broadwayworld.com/people/John-Brooke/',
    serpTitle: 'John Brooke - BroadwayWorld',
    note: 'Actor bio page — not a cast page',
    caughtBy: 'serp-scorer',
  },
  {
    show: 'Making a Show of Myself',
    url: 'https://www.instagram.com/p/DGgqPHcPqiW/',
    serpTitle: 'Instagram post',
    note: 'Instagram post — not a cast page',
    caughtBy: 'serp-scorer',
  },
  {
    show: 'Man to Man',
    url: 'https://www.londonboxoffice.co.uk/news/post/man-and-boy-dorfman-theatre-cast',
    serpTitle: 'Cast announced for Man and Boy',
    note: 'Man and Boy cast — wrong show',
    caughtBy: 'llm-prompt',  // short title → all tokens filtered out → no SERP gate signal
  },
  {
    show: 'The Wedding March',
    url: 'https://www.broadwayworld.com/westend/article/Cast-Set-For-FANNY-at-Kings-Head-Theatre-20250911',
    serpTitle: 'Cast Set For FANNY at Kings Head Theatre',
    note: 'BWW article for FANNY — wrong show',
    caughtBy: 'serp-scorer',
  },
];

for (const c of HISTORICAL_BAD_SOURCES) {
  const label = c.caughtBy === 'serp-scorer'
    ? `SERP scorer rejects historical bad URL: "${c.show}" → ${c.url.slice(0, 60)}`
    : `SERP scorer alone cannot reject "${c.show}" (caught by ${c.caughtBy})`;

  test(label, () => {
    const { score } = scoreSerpResult({ url: c.url, title: c.serpTitle }, c.show);
    if (c.caughtBy === 'serp-scorer') {
      assert.ok(score < SERP_MIN_SCORE,
        `expected score < ${SERP_MIN_SCORE}, got ${score} (${c.note})`);
    } else {
      // Document the boundary: this URL DOES pass the SERP scorer with a
      // realistic title; a different defense layer catches it. We assert
      // score >= SERP_MIN_SCORE so the test breaks if a future SERP-scorer
      // tightening would catch it (good news — update caughtBy then), and
      // breaks if the URL stops passing for unrelated reasons (also worth
      // knowing).
      assert.ok(score >= SERP_MIN_SCORE,
        `${c.show} URL was expected to pass SERP scorer (caughtBy=${c.caughtBy}), but score=${score} < ${SERP_MIN_SCORE}. ` +
        `If the SERP scorer was tightened to catch this case, update caughtBy to "serp-scorer".`);
    }
  });
}

// Verify the downstream defenses named in `caughtBy` actually exist & fire.
test('opera-source-url defense catches Kavalier-Clay URL', () => {
  assert.equal(isOperaSourceUrl('https://parterre.com/broadcast/104032/the-amazing-adventures-of-kavalier-clay/'), true);
});

test('validate-cast-extraction defense catches Pride name-swap pattern', () => {
  // The Pride URL went to BWW Pride-335789 which lists cast in
  // LASTNAME-FIRSTNAME alphabetical order — the LLM extracts swapped names.
  const cast = [
    { name: 'Jenkins Gethin', role: 'Darren' },
    { name: 'Williams Margaret', role: 'Matthew' },
    { name: 'Lumsden Mark', role: 'Kirsty' },
  ];
  const r = validateCastExtraction(cast, 'Pride');
  assert.equal(r.ok, false, 'validateCastExtraction must reject name-swap pattern');
  assert.match(r.reasons.join(','), /name-swap-pattern/);
});

test('SERP scoring passes structured cast pages for the right show', () => {
  // Positive controls — URLs that match the shape of real cast pages on
  // structured aggregators. The exact slugs aren't fetched (the scorer is
  // pure pattern-matching), so these are SYNTHETIC URLs matching the
  // playbill.com/production/<slug> and broadwayworld.com/shows/<slug>/cast
  // shapes. The goal: ensure the threshold isn't so high that real
  // production pages would fail.
  const goodCases = [
    {
      show: 'Hamilton',
      url: 'https://playbill.com/production/hamilton-richard-rodgers-theatre-vault-0000014099',
      title: 'Hamilton on Broadway - Cast & Crew | Playbill',
    },
    {
      show: 'The Lion King',
      url: 'https://www.broadwayworld.com/shows/The-Lion-King-Broadway/cast',
      title: 'The Lion King Broadway Cast',
    },
  ];

  for (const c of goodCases) {
    const { score } = scoreSerpResult({ url: c.url, title: c.title }, c.show);
    assert.ok(score >= SERP_MIN_SCORE,
      `${c.show}: expected score >= ${SERP_MIN_SCORE}, got ${score}`);
  }
});

test('meaningfulTitleTokens filters stopwords and short words', () => {
  assert.deepEqual(meaningfulTitleTokens('The Last Ship'), ['last', 'ship']);
  assert.deepEqual(meaningfulTitleTokens('Love\'s Labour\'s Lost'), ['love', 'labour', 'lost']);
  assert.deepEqual(meaningfulTitleTokens('It'), []); // stopword filtered → empty
  assert.deepEqual(meaningfulTitleTokens('Six'), []); // ≤3 chars → empty
  assert.deepEqual(meaningfulTitleTokens(''), []);
  assert.deepEqual(meaningfulTitleTokens(null), []);
});

// ============================================================================
// Year-mismatch + market-mismatch defenses (added 2026-05-24, Notion card
// 36a637c5-416f-813d-ad5a-ddfa3e7fab4b). These are LATENT defenses — they
// add value when SERP returns a URL with a parseable year or cross-market
// path. Honest scope: they do NOT catch the 3 short-titled cases (Pride /
// Man to Man / Six / It) — those URLs have no year and no cross-market
// signal. caughtBy=llm-prompt is unchanged for those.
// ============================================================================

test('parseYearFromUrl handles plain years, YYYYMMDD, and no-year URLs', () => {
  // Plain YYYY in path
  assert.equal(parseYearFromUrl('https://example.com/show/2024-revival/cast'), 2024);
  // YYYYMMDD suffix (BWW article URL pattern)
  assert.equal(parseYearFromUrl('https://www.broadwayworld.com/article/Cast-Announced-20230329'), 2023);
  // Multiple candidate years: picks the most recent
  assert.equal(parseYearFromUrl('https://example.com/2019/article-published-20240115'), 2024);
  // No year present
  assert.equal(parseYearFromUrl('https://example.com/cast/main'), null);
  // BWW internal ID (335789) not mistaken for a year — 3357 is out of range
  assert.equal(parseYearFromUrl('https://broadwayworld.com/shows/Pride-335789/cast'), null);
  // 5-digit run starting with a valid-year prefix must NOT false-positive
  // (Codex ship-check 2026-05-24: earlier code sliced `19999` → `1999`).
  assert.equal(parseYearFromUrl('https://example.com/article-19999-foo'), null);
  assert.equal(parseYearFromUrl('https://example.com/article-20245-foo'), null);
  // 6 / 7 digit runs also rejected
  assert.equal(parseYearFromUrl('https://example.com/article-202301-foo'), null);
  assert.equal(parseYearFromUrl('https://example.com/article-2023012-foo'), null);
  // Defensive: null/empty/undefined
  assert.equal(parseYearFromUrl(null), null);
  assert.equal(parseYearFromUrl(''), null);
  assert.equal(parseYearFromUrl(undefined), null);
});

test('detectMarketMismatch flags cross-market URLs', () => {
  // West End show landing on broadway.com — mismatch
  assert.equal(
    detectMarketMismatch('https://www.broadway.com/shows/hamilton/cast', 'west-end'),
    'we-show-on-bw-path'
  );
  // West End show landing on BWW /shows/{Slug}-Broadway/ — mismatch
  // (handles BWW's plural /shows/ path; Codex ship-check 2026-05-24
  // caught the singular-only regex missing real URLs)
  assert.equal(
    detectMarketMismatch('https://www.broadwayworld.com/shows/Hamilton-Broadway/cast', 'west-end'),
    'we-show-on-bw-path'
  );
  // Broadway show landing on westendtheatre.com — mismatch
  assert.equal(
    detectMarketMismatch('https://www.westendtheatre.com/shows/foo/cast', 'broadway'),
    'bw-show-on-we-path'
  );
  // West End show on London Box Office (correct market) — no mismatch
  assert.equal(
    detectMarketMismatch('https://www.londonboxoffice.co.uk/cast/foo', 'west-end'),
    null
  );
  // BWW /westend/ article for a West End show — no mismatch
  assert.equal(
    detectMarketMismatch('https://www.broadwayworld.com/westend/article/Foo', 'west-end'),
    null
  );
  // Defensive
  assert.equal(detectMarketMismatch(null, 'broadway'), null);
  assert.equal(detectMarketMismatch('https://example.com', null), null);
});

test('year-mismatch penalty fires when URL year is ≥2 off show year', () => {
  // Synthetic: show is 2026, URL is from a 2023 article. With realistic
  // SERP title and URL signals that would otherwise score above threshold,
  // year mismatch should drag below.
  const r1 = scoreSerpResult(
    { url: 'https://www.broadwayworld.com/article/Cast-Announced-2023-Production-20230815', title: 'Cast Announced 2023 Production' },
    { title: 'Some Play', year: 2026 }
  );
  // URL year 2023 vs show year 2026 → diff 3 → -4 penalty
  // Even with cast+title bonus, should land below threshold or at least
  // measurably lower than the same URL with matching year.
  const r2 = scoreSerpResult(
    { url: 'https://www.broadwayworld.com/article/Cast-Announced-2026-Production-20260815', title: 'Cast Announced 2026 Production' },
    { title: 'Some Play', year: 2026 }
  );
  assert.ok(r2.score > r1.score,
    `year-matching URL (${r2.score}) should outscore year-mismatched URL (${r1.score})`);
  assert.ok(r2.score - r1.score >= 4,
    `expected ≥4 point spread, got ${r2.score - r1.score}`);
});

test('market-mismatch penalty fires when WE show lands on BW domain', () => {
  // Synthetic: WE show landing on broadway.com.
  const r1 = scoreSerpResult(
    { url: 'https://www.broadway.com/shows/some-show/cast', title: 'Some Show Cast' },
    { title: 'Some Show', category: 'west-end' }
  );
  // Same URL but for an actual Broadway show — no penalty
  const r2 = scoreSerpResult(
    { url: 'https://www.broadway.com/shows/some-show/cast', title: 'Some Show Cast' },
    { title: 'Some Show', category: 'broadway' }
  );
  assert.ok(r2.score > r1.score,
    `category-matching URL (${r2.score}) should outscore mismatch (${r1.score})`);
  assert.ok(r2.score - r1.score >= 3,
    `expected ≥3 point spread, got ${r2.score - r1.score}`);
});

test('backward-compat: scoreSerpResult accepts bare title string', () => {
  // Pre-2026-05-24 callers passed (result, title). Both forms should give
  // identical scores when no year/category signals apply.
  const r1 = scoreSerpResult(
    { url: 'https://www.broadwayworld.com/shows/Hamilton-Broadway/cast', title: 'Hamilton Cast' },
    'Hamilton'
  );
  const r2 = scoreSerpResult(
    { url: 'https://www.broadwayworld.com/shows/Hamilton-Broadway/cast', title: 'Hamilton Cast' },
    { title: 'Hamilton' }
  );
  assert.equal(r1.score, r2.score);
  assert.ok(r1.score >= SERP_MIN_SCORE);
});

test('honest scope: short-titled shows STILL bypass SERP scorer (caughtBy=llm-prompt)', () => {
  // Pride 2026 WE: bad URL for an older Pride production. Title token "pride"
  // is in URL, gate doesn't fire. URL has no parseable year. No market
  // mismatch (BWW /shows/ doesn't trigger). Year/venue signals don't help.
  const pride = scoreSerpResult(
    { url: 'https://www.broadwayworld.com/shows/Pride-335789/cast', title: 'Pride - Broadway Cast & Creative Team' },
    { title: 'Pride', year: 2026, category: 'west-end' }
  );
  assert.ok(pride.score >= SERP_MIN_SCORE,
    `Pride still expected to pass SERP scorer (downstream defense: validateCastExtraction name-swap), got ${pride.score}`);

  // Man to Man WE: short title "man" filtered out (3 chars). URL has no year.
  // Not on cross-market domain. SERP scorer remains powerless here.
  const m2m = scoreSerpResult(
    { url: 'https://www.londonboxoffice.co.uk/news/post/man-and-boy-dorfman-theatre-cast', title: 'Cast announced for Man and Boy' },
    { title: 'Man to Man', year: 2026, category: 'west-end' }
  );
  assert.ok(m2m.score >= SERP_MIN_SCORE,
    `Man to Man still expected to pass SERP scorer (downstream defense: LLM prompt year/venue refusal), got ${m2m.score}`);
});

// BRO-504: backfill-cast-web.js used to require >=2 named cast members to
// accept an extraction, which permanently starved solo shows (one actor
// playing every role, e.g. "Jeeves Takes Charge") of cast data — every run
// found the lone real cast member, rejected it as "too few", and tombstoned
// the show empty, so auto-remediation retried forever and gave up.
test('isViableCastExtraction accepts a single named cast member (solo shows)', () => {
  assert.equal(isViableCastExtraction([{ name: 'Sam Harrison', role: 'Jeeves' }]), true);
});

test('isViableCastExtraction accepts multi-member casts', () => {
  assert.equal(isViableCastExtraction([{ name: 'A' }, { name: 'B' }]), true);
});

test('isViableCastExtraction rejects an empty extraction', () => {
  assert.equal(isViableCastExtraction([]), false);
});

test('isViableCastExtraction rejects non-array input', () => {
  assert.equal(isViableCastExtraction(null), false);
  assert.equal(isViableCastExtraction(undefined), false);
});
