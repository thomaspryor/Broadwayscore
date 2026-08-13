#!/usr/bin/env node
/**
 * Tests for scripts/lib/deduplication.js
 *
 * Covers the 2026-05-03 Emporium duplicate incident:
 *   "Thornton Wilder's The Emporium" vs "The Emporium"
 *   shipped as two entries because the possessive prefix wasn't stripped.
 *
 * Run: node scripts/test-deduplication.js
 */

const {
  normalizeTitle,
  checkForDuplicate,
  isSubtitleVariantOf,
} = require('./lib/deduplication');

const tests = [];
let pass = 0;
let fail = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, name) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------- normalizeTitle ----------

test('normalizeTitle: strips author possessive prefix (2-word author)', () => {
  assertEqual(
    normalizeTitle("Thornton Wilder's The Emporium"),
    'emporium',
    "Thornton Wilder's The Emporium → emporium"
  );
});

test('normalizeTitle: strips brand possessive prefix (Disney)', () => {
  assertEqual(
    normalizeTitle("Disney's Aladdin"),
    'aladdin',
    "Disney's Aladdin → aladdin"
  );
});

test('normalizeTitle: strips multi-word author possessive (3 words)', () => {
  assertEqual(
    normalizeTitle("Andrew Lloyd Webber's Cats"),
    'cats',
    "Andrew Lloyd Webber's Cats → cats"
  );
});

test('normalizeTitle: strips Stephen Sondheim possessive', () => {
  assertEqual(
    normalizeTitle("Stephen Sondheim's Old Friends"),
    'old friends',
    "Stephen Sondheim's Old Friends → old friends"
  );
});

test('normalizeTitle: handles curly apostrophe', () => {
  assertEqual(
    normalizeTitle('Thornton Wilder’s The Emporium'),
    'emporium',
    "Thornton Wilder’s The Emporium → emporium"
  );
});

test('normalizeTitle: keeps integral possessives (single-word)', () => {
  // Single-word possessive that IS the title's own structure,
  // we still strip — collisions are caught downstream by isMultiProduction.
  assertEqual(
    normalizeTitle("Hell's Kitchen"),
    'kitchen',
    "Hell's Kitchen → kitchen (collision risk handled by venue/year check)"
  );
});

test('normalizeTitle: leaves non-possessive titles alone', () => {
  assertEqual(
    normalizeTitle('Cats'),
    'cats',
    "Cats → cats"
  );
  assertEqual(
    normalizeTitle('A Doll House'),
    'doll house',
    "A Doll House → doll house"
  );
});

test('normalizeTitle: still strips colon subtitle', () => {
  assertEqual(
    normalizeTitle('All Out: Comedy About Ambition'),
    'all out',
    "All Out: ... → all out"
  );
});

// Regression: TodayTix appends a descriptive genre+author tail with no colon
// ("THE TRUTH a comedy by Florian Zeller"), which defeated normalized-title
// dedup against the clean catalog entry "The Truth" — the WE 2026 duplicate.
// See memory/feedback_dedup_genre_suffix.md.
test('normalizeTitle: strips trailing "a <genre> by <author>" listing tail', () => {
  assertEqual(
    normalizeTitle('THE TRUTH a comedy by Florian Zeller'),
    'truth',
    "THE TRUTH a comedy by Florian Zeller → truth"
  );
  assertEqual(
    normalizeTitle('Stereophonic a new play'),
    'stereophonic',
    "Stereophonic a new play → stereophonic"
  );
  assertEqual(
    normalizeTitle('The Seagull a play by Anton Chekhov'),
    'seagull',
    "The Seagull a play by Anton Chekhov → seagull"
  );
});

// Guard: the genre-tail strip must NOT eat real titles where the genre word is
// integral (no leading "a/an") or mid-title.
test('normalizeTitle: keeps integral genre words (Slave Play, Goes Wrong)', () => {
  assertEqual(normalizeTitle('Slave Play'), 'slave play', "Slave Play kept");
  assertEqual(
    normalizeTitle('The Play That Goes Wrong'),
    'play that goes wrong',
    "The Play That Goes Wrong kept"
  );
});

// Guard: a BARE "a/an <genre>" tail (no "new", no "by <author>") is ambiguous —
// it may be integral to the title — so it must NOT be stripped. The strip is
// gated on a marketing signal ("new <genre>" or "<genre> by <Name>"). Regression
// for "It's Only a Play" → "only" (Terrence McNally), caught in pre-ship review.
test('normalizeTitle: keeps bare "a <genre>" with no marketing signal', () => {
  assertEqual(
    normalizeTitle("It's Only a Play"),
    'only a play',
    "It's Only a Play kept as 'only a play' (NOT collapsed to bare 'only')"
  );
  assertEqual(
    normalizeTitle('The Real Thing a Play'),
    'real thing a play',
    "bare '... a play' tail kept without 'new'/'by'"
  );
});

// The actual dup that shipped: clean catalog entry vs TodayTix verbose listing
// must now collapse via checkForDuplicate.
test('checkForDuplicate: TodayTix verbose title matches clean catalog entry', () => {
  const verbose = {
    id: 'the-truth-a-comedy-by-florian-zeller-west-end-2026',
    title: 'THE TRUTH a comedy by Florian Zeller',
    slug: 'the-truth-a-comedy-by-florian-zeller-west-end',
    venue: 'Apollo Theatre', openingDate: '2026-06-09',
    status: 'upcoming', category: 'west-end',
  };
  const clean = {
    id: 'the-truth-west-end-2026', title: 'The Truth',
    slug: 'the-truth-west-end', venue: 'TBA', openingDate: '2026-06-18',
    status: 'announced', category: 'west-end',
  };
  const r = checkForDuplicate(verbose, [clean]);
  assertEqual(r.isDuplicate, true, "verbose TodayTix title flagged as duplicate of clean entry");
});

// ---------- checkForDuplicate (the Emporium case) ----------

const emporium2025 = {
  id: 'the-emporium-off-broadway-2025',
  title: 'The Emporium',
  slug: 'the-emporium-off-broadway',
  venue: 'Classic Stage Company',
  category: 'off-broadway',
  status: 'upcoming',
  openingDate: null,
};

const emporium2026 = {
  id: 'thornton-wilders-the-emporium-off-broadway-2026',
  title: "Thornton Wilder's The Emporium",
  slug: 'thornton-wilders-the-emporium-off-broadway',
  venue: 'Classic Stage Company',
  category: 'off-broadway',
  status: 'previews',
  openingDate: '2026-05-18',
};

test('Emporium: possessive variant flagged as duplicate (same venue, same year)', () => {
  const r = checkForDuplicate(emporium2026, [emporium2025]);
  assertEqual(r.isDuplicate, true, '2026 variant flagged as dup of 2025 entry');
});

test('Emporium: order-invariant', () => {
  const r = checkForDuplicate(emporium2025, [emporium2026]);
  assertEqual(r.isDuplicate, true, '2025 variant flagged when 2026 already in catalog');
});

// ---------- false-positive prevention ----------

const bandsVisit2017 = {
  id: 'the-bands-visit-2017',
  title: "The Band's Visit",
  slug: 'the-bands-visit-2017',
  venue: 'Ethel Barrymore Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2017-11-09',
};

const visit2015 = {
  id: 'the-visit-2015',
  title: 'The Visit',
  slug: 'the-visit-2015',
  venue: 'Lyceum Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2015-04-23',
};

test("FP guard: \"The Band's Visit\" vs \"The Visit\" at different venues NOT flagged", () => {
  const r = checkForDuplicate(bandsVisit2017, [visit2015]);
  assertEqual(r.isDuplicate, false, "different venues → multi-production");
});

const visit1973 = {
  id: 'the-visit-1973',
  title: 'The Visit',
  slug: 'the-visit-1973',
  venue: 'Ethel Barrymore Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '1973-11-25',
};

test("FP guard: \"The Band's Visit\" 2017 vs \"The Visit\" 1973 same venue NOT flagged (year gap)", () => {
  const r = checkForDuplicate(bandsVisit2017, [visit1973]);
  assertEqual(r.isDuplicate, false, "44-year gap → multi-production");
});

const fosseDancin = {
  id: 'bob-fosses-dancin-2023',
  title: "Bob Fosse's Dancin'",
  slug: 'bob-fosses-dancin-2023',
  venue: 'Music Box Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '2023-03-19',
};

const dancin1978 = {
  id: 'dancin-1978',
  title: "Dancin'",
  slug: 'dancin-1978',
  venue: 'Broadhurst Theatre',
  category: 'broadway',
  status: 'closed',
  openingDate: '1978-03-27',
};

test("FP guard: \"Bob Fosse's Dancin'\" vs \"Dancin'\" different venues NOT flagged", () => {
  const r = checkForDuplicate(fosseDancin, [dancin1978]);
  assertEqual(r.isDuplicate, false, "different venues + closed → multi-production");
});

// ---------- existing dedup behavior preserved ----------

test("Existing: Disney's Aladdin still dedupes against Aladdin", () => {
  const aladdinDisney = {
    id: 'aladdin-2014',
    title: "Disney's Aladdin",
    slug: 'aladdin-2014',
    venue: 'New Amsterdam Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2014-03-20',
  };
  const aladdinPlain = {
    id: 'aladdin-2014-todaytix',
    title: 'Aladdin',
    slug: 'aladdin-2014-todaytix',
    venue: 'New Amsterdam Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2014-03-20',
  };
  const r = checkForDuplicate(aladdinDisney, [aladdinPlain]);
  assertEqual(r.isDuplicate, true, "Disney's Aladdin === Aladdin");
});

test('Existing: cross-market same title NOT flagged (Hamilton BW vs WE)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    slug: 'hamilton-2015',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
  };
  const hamiltonWe = {
    id: 'hamilton-west-end-2017',
    title: 'Hamilton',
    slug: 'hamilton-west-end-2017',
    venue: 'Victoria Palace Theatre',
    category: 'west-end',
    status: 'open',
    openingDate: '2017-12-21',
  };
  const r = checkForDuplicate(hamiltonWe, [hamiltonBw]);
  assertEqual(r.isDuplicate, false, 'cross-market: not a duplicate');
});

// ---------- regression: Globe duplicate guard (2026-05-09 incident) ----------

const { findSameTitleTwinIfNoOpeningDate } = require('./lib/deduplication');

const motherCourageGlobe = {
  id: 'mother-courage-and-her-children-globe-west-end-2026',
  title: 'Mother Courage and Her Children - Globe',
  slug: 'mother-courage-and-her-children-globe-west-end',
  venue: "Shakespeare's Globe",
  category: 'off-west-end',
  status: 'upcoming',
  openingDate: '2026-05-07',
};

test('Globe guard: candidate with null openingDate + same title in same pool → twin found', () => {
  const candidate = {
    title: 'Mother Courage and Her Children - Globe',
    venue: 'Globe Theatre',
    category: 'off-west-end',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [motherCourageGlobe]);
  assertEqual(twin?.id, motherCourageGlobe.id, 'twin returned for Globe-incident scenario');
});

test('Globe guard: candidate WITH openingDate → guard skipped (returns null)', () => {
  const candidate = {
    title: 'Mother Courage and Her Children - Globe',
    venue: 'Globe Theatre',
    category: 'off-west-end',
    openingDate: '2026-05-07',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [motherCourageGlobe]);
  assertEqual(twin, null, 'openingDate present → guard does not fire');
});

test('Globe guard: cross-pool same title → no twin (Hamilton WE vs Hamilton BW)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
  };
  const candidate = {
    title: 'Hamilton',
    venue: 'Victoria Palace Theatre',
    category: 'west-end',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [hamiltonBw]);
  assertEqual(twin, null, 'cross-pool: BW vs WE never twins');
});

test('Globe guard: candidate with null category → guard skipped (no decision without category)', () => {
  // getMarketPool defaults missing category to 'broadway'/'nyc'. A London
  // candidate that arrived without a category set (early-stage discovery)
  // should NOT be force-bridged to NYC twins. The guard refuses to decide.
  const wickedBw = {
    id: 'wicked-2003',
    title: 'Wicked',
    venue: 'Gershwin Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2003-10-30',
  };
  const candidateNoCategory = {
    title: 'Wicked',
    venue: 'Apollo Victoria',
    category: null,
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidateNoCategory, [wickedBw]);
  assertEqual(twin, null, 'null category → no decision, guard skipped');
});

test('Globe guard: existing entry with null category not matched (avoids spurious twin)', () => {
  // Mirror image of above: an existing show with missing category should
  // not act as a twin for a London candidate. Otherwise legacy NYC entries
  // with missing categories would silently swallow new West End shows.
  const legacyExisting = {
    id: 'wicked-legacy',
    title: 'Wicked',
    venue: '',
    category: null,
    status: 'closed',
    openingDate: null,
  };
  const candidateWE = {
    title: 'Wicked',
    venue: 'Apollo Victoria',
    category: 'west-end',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidateWE, [legacyExisting]);
  assertEqual(twin, null, 'existing with null category not matched');
});

// ---------- regression: long-closed twin carve-out (2026-07-14 incident) ----------
// The guard was permanently blocking real revivals: Seven Guitars (LCT 2026)
// vs seven-guitars-1996, An American Daughter (Signature 2026) vs 1997, etc.
// A candidate currently on sale cannot be the same production as a show that
// closed 18+ months ago.

test('Long-closed twin: revival of decades-closed show → guard skipped (added, not blocked)', () => {
  const sevenGuitars1996 = {
    id: 'seven-guitars-1996',
    title: 'Seven Guitars',
    venue: 'Walter Kerr Theatre',
    category: 'broadway',
    status: 'closed',
    openingDate: '1996-03-28',
    closingDate: '1996-09-08',
  };
  const candidate = {
    title: 'Seven Guitars',
    venue: 'Lincoln Center Theater - Mitzi E. Newhouse Theater',
    category: 'off-broadway',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [sevenGuitars1996]);
  assertEqual(twin, null, 'twin closed in 1996 → new production allowed');
});

test('Long-closed twin: closed show with no closingDate but old openingDate → guard skipped', () => {
  const anAmericanDaughter1997 = {
    id: 'an-american-daughter-1997',
    title: 'An American Daughter',
    venue: 'Cort Theatre',
    category: 'broadway',
    status: 'closed',
    openingDate: '1997-04-13',
    closingDate: null,
  };
  const candidate = {
    title: 'An American Daughter',
    venue: 'Pershing Square Signature Center',
    category: 'off-broadway',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [anAmericanDaughter1997]);
  assertEqual(twin, null, 'closed 1997, dated by openingDate → new production allowed');
});

test('Recently-closed twin: closed <18 months ago → still a twin (blocked)', () => {
  const recentClose = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const justClosed = {
    id: 'some-play-2026',
    title: 'Some Play',
    venue: 'Public Theater',
    category: 'off-broadway',
    status: 'closed',
    openingDate: null,
    closingDate: recentClose,
  };
  const candidate = {
    title: 'Some Play',
    venue: 'The Public',
    category: 'off-broadway',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [justClosed]);
  assertEqual(twin?.id, justClosed.id, 'closed 3 months ago → still twin');
});

test('Open twin from years ago → still a twin (long-running show, Globe protection intact)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
  };
  const candidate = {
    title: 'Hamilton',
    venue: 'Richard Rodgers',
    category: 'broadway',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [hamiltonBw]);
  assertEqual(twin?.id, hamiltonBw.id, 'open show is never long-closed → still twin');
});

test('Closed twin with no dates at all → still a twin (conservative)', () => {
  const undatable = {
    id: 'mystery-1990s',
    title: 'Mystery Play',
    venue: '',
    category: 'broadway',
    status: 'closed',
    openingDate: null,
    closingDate: null,
  };
  const candidate = {
    title: 'Mystery Play',
    venue: 'Somewhere',
    category: 'broadway',
    openingDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [undatable]);
  assertEqual(twin?.id, undatable.id, 'undatable closed show → conservative, still twin');
});

// ---------- regression: far-future announced season (2026-08-12 incident) ----------
// The whole 2027 Encores! season went missing/hollow. discover-new-shows.js
// quarantines a TodayTix startDate >120d out as `unconfirmedStartDate` rather
// than trusting it as previewsStartDate, so an early-announced subscription
// season reaches this guard with openingDate AND previewsStartDate both null.
// "You're a Good Man, Charlie Brown" (City Center, Feb 3-14 2027) was blocked
// on every daily run by the 92NY production that closed 2026-03-29 — only ~5
// months earlier, so the 18-month long-closed carve-out never applied.

const charlieBrown92NY = {
  id: 'youre-a-good-man-charlie-brown-off-broadway-2026',
  title: "You're A Good Man, Charlie Brown",
  venue: '92NY Buttenwieser Hall',
  category: 'off-broadway',
  status: 'closed',
  openingDate: '2026-03-14',
  closingDate: '2026-03-29',
};

test('Far-future season: quarantined start after a recently-closed twin → guard skipped (show is added)', () => {
  const candidate = {
    title: "You're A Good Man, Charlie Brown",
    venue: 'New York City Center',
    category: 'off-broadway',
    openingDate: null,
    previewsStartDate: null,
    unconfirmedStartDate: '2027-02-03',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [charlieBrown92NY]);
  assertEqual(twin, null, 'starts 10 months after the twin closed → separate production');
});

test('Far-future season: same candidate WITHOUT the quarantined date → still blocked', () => {
  // Proves the carve-out is doing the work, not some unrelated field.
  const candidate = {
    title: "You're A Good Man, Charlie Brown",
    venue: 'New York City Center',
    category: 'off-broadway',
    openingDate: null,
    previewsStartDate: null,
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [charlieBrown92NY]);
  assertEqual(twin?.id, charlieBrown92NY.id, 'no date evidence at all → conservative, still twin');
});

test('Far-future season: quarantined start BEFORE the twin closed → still a twin', () => {
  const candidate = {
    title: "You're A Good Man, Charlie Brown",
    venue: 'New York City Center',
    category: 'off-broadway',
    openingDate: null,
    unconfirmedStartDate: '2026-03-20', // inside the 92NY run
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [charlieBrown92NY]);
  assertEqual(twin?.id, charlieBrown92NY.id, 'overlaps the twin run → same production');
});

test('Far-future season: quarantined start does NOT clear an OPEN twin (Globe/long-runner protection)', () => {
  const hamiltonBw = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    venue: 'Richard Rodgers Theatre',
    category: 'broadway',
    status: 'open',
    openingDate: '2015-08-06',
    closingDate: null,
  };
  const candidate = {
    title: 'Hamilton',
    venue: 'Richard Rodgers',
    category: 'broadway',
    openingDate: null,
    unconfirmedStartDate: '2027-03-01',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [hamiltonBw]);
  assertEqual(twin?.id, hamiltonBw.id, 'open twin is never cleared by a quarantined date');
});

test('Far-future season: quarantined start does NOT clear an UPCOMING twin (the Globe shape itself)', () => {
  const candidate = {
    title: 'Mother Courage and Her Children - Globe',
    venue: 'Globe Theatre',
    category: 'off-west-end',
    openingDate: null,
    unconfirmedStartDate: '2027-01-01',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [motherCourageGlobe]);
  assertEqual(twin?.id, motherCourageGlobe.id, 'upcoming twin is never cleared by a quarantined date');
});

test('Far-future season: garbage quarantined date is ignored (falls back to blocking)', () => {
  const candidate = {
    title: "You're A Good Man, Charlie Brown",
    venue: 'New York City Center',
    category: 'off-broadway',
    openingDate: null,
    unconfirmedStartDate: 'not-a-date',
  };
  const twin = findSameTitleTwinIfNoOpeningDate(candidate, [charlieBrown92NY]);
  assertEqual(twin?.id, charlieBrown92NY.id, 'unparseable date → no evidence → still twin');
});

// ---------- regression: isSubtitleVariantOf (2026-08-04/05 incident) ----------
//
// promote-ob-venue-candidates.js and promote-ob-historical.js each maintained
// their own duplicate check using title-match.js's normalizeTitle, which does
// NOT strip colon/dash subtitles. Same-venue subtitle variants ("Ectoplasm"
// vs "Ectoplasm: Spit and Vigor") slipped through both, shipped as duplicate
// shows.json entries, and blocked a Vercel deploy (task #1011). The fix
// (isSubtitleVariantOf, shared by both scripts as of 2026-08-05) strips
// subtitles the same way checkForDuplicate's Check 5 does, with the same
// carve-out for two distinct works that happen to share a base title.

test('isSubtitleVariantOf: real incident pair — Ectoplasm', () => {
  assertEqual(
    isSubtitleVariantOf('Ectoplasm', 'Ectoplasm: Spit and Vigor'),
    true,
    'Ectoplasm vs Ectoplasm: Spit and Vigor → variant (must collapse)'
  );
});

test('isSubtitleVariantOf: real incident pair — Bone Wars', () => {
  assertEqual(
    isSubtitleVariantOf('Bone Wars', 'Bone Wars: A New Musical'),
    true,
    'Bone Wars vs Bone Wars: A New Musical → variant (must collapse)'
  );
});

test('isSubtitleVariantOf: is symmetric (order of arguments does not matter)', () => {
  assertEqual(
    isSubtitleVariantOf('Ectoplasm: Spit and Vigor', 'Ectoplasm'),
    true,
    'reversed argument order still collapses'
  );
});

test('isSubtitleVariantOf: carve-out — both subtitled, different works (Angels in America)', () => {
  assertEqual(
    isSubtitleVariantOf('Angels in America: Millennium Approaches', 'Angels in America: Perestroika'),
    false,
    'both sides carry a subtitle and differ → must NOT collapse (distinct works)'
  );
});

test('isSubtitleVariantOf: carve-out — both subtitled, different works (Coast of Utopia)', () => {
  assertEqual(
    isSubtitleVariantOf('The Coast of Utopia: Voyage', 'The Coast of Utopia: Shipwreck'),
    false,
    'both sides carry a subtitle and differ → must NOT collapse (distinct works)'
  );
});

test('isSubtitleVariantOf: identical titles collapse', () => {
  assertEqual(
    isSubtitleVariantOf('Music City', 'Music City'),
    true,
    'identical titles → variant'
  );
});

test('isSubtitleVariantOf: unrelated titles never collapse', () => {
  assertEqual(
    isSubtitleVariantOf('Ectoplasm', 'Bone Wars'),
    false,
    'unrelated titles → not a variant'
  );
});

test('isSubtitleVariantOf: KNOWN LIMITATION — one side subtitled, one bare, same base title', () => {
  // Documents an accepted, pre-existing gap (also present in checkForDuplicate's
  // own Check 5, which only carves out when BOTH sides have a subtitle marker):
  // when only one side has a subtitle, the carve-out does not fire and the pair
  // collapses. This is the "Hamlet" vs "Hamlet: Hail to the Thief" shape. Callers
  // mitigate by scoping comparisons to the same venue before calling this
  // function — a real false positive additionally requires an identical base
  // title AND the same venue for two truly distinct productions.
  assertEqual(
    isSubtitleVariantOf('Hamlet', 'Hamlet: Hail to the Thief'),
    true,
    'accepted limitation: collapses when only one side has a subtitle'
  );
});

test('isSubtitleVariantOf: intra-run collision — second same-batch candidate correctly collapses (both orders)', () => {
  // Mirrors the actual usage pattern in both promote-ob-venue-candidates.js and
  // promote-ob-historical.js: a promoted candidate's title is pushed into the
  // per-venue candidate list, then the NEXT candidate in the same run is
  // checked against that updated list. This is the exact scenario the
  // second-opinion review of commit 829cd8efbea flagged as untested for
  // promote-ob-historical.js (venue-candidates.js's version was already
  // covered by a live --dry-run run with two staged candidates).
  const venueList = ['Bone Wars']; // first candidate already accepted this run
  assertEqual(
    venueList.some(existing => isSubtitleVariantOf('Bone Wars: A New Musical', existing)),
    true,
    'second candidate (subtitled) vs first (bare), same run → collapses'
  );
  // Order shouldn't matter: bare-first-then-subtitled and subtitled-first-then-bare
  // must both collapse, since a discovery source can list either form first.
  const venueListReversed = ['Bone Wars: A New Musical'];
  assertEqual(
    venueListReversed.some(existing => isSubtitleVariantOf('Bone Wars', existing)),
    true,
    'second candidate (bare) vs first (subtitled), same run → collapses'
  );
});

// ---------- run ----------

console.log('Running deduplication tests...\n');
for (const t of tests) {
  console.log(t.name);
  try {
    t.fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ threw: ${e.message}`);
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
