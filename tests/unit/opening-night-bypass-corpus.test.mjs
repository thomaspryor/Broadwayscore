// Growable regression harness for opening-night bypass classes.
//
// Every opening-night postmortem has uncovered a NEW way for contamination to
// slip past guards. The pre-broadcast audit gate (scripts/lib/opening-night-checks/*)
// is the last line of defense. This harness proves the gate catches the CLASS
// of each past failure by running the real check plugins against synthetic
// fixtures. When a new bypass class is documented, add a fixture here.
//
// Fixtures are SYNTHETIC (no copyrighted review text) — they only reproduce
// the structural fields that characterize each bypass. Real review-text files
// live in the private broadway-review-texts repo.
//
// Plugins are required directly (not via runChecks) so the test stays offline —
// bww-rr-count-mismatch and dtli-count-mismatch hit external aggregators over
// the network and must not be invoked from unit tests.
//
// Current coverage (5 classes from 2026-04-20 Schmigadoon postmortem):
//   1. cv-bypass-via-override       — juan-a-ramirez / EBT-as-Schmig
//   2. wrong-slug-in-url            — Kennedy Center tryout URL scraped as Broadway
//   3. cross-show-bww-roundup-url   — amny review pointed at wrong BWW Roundup
//   4. anticipatory-pre-opening     — frontmezzjunkies 16-day-before-opening post
//   5. non-numeric-assigned-score   — nypost "2/4 stars" schema drift

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PLUGINS = Object.fromEntries(
  [
    'slug-mismatch',
    'roundup-url-mismatch',
    'fulltext-mentions-show',
    'cv-wrongproduction-unhandled',
    'publish-date-pre-opening',
    'assigned-score-schema',
  ].map(n => [n, require(`../../scripts/lib/opening-night-checks/${n}.check.js`)])
);

async function runPlugin(name, show, context) {
  const mod = PLUGINS[name];
  if (!mod) throw new Error(`Unknown plugin: ${name}`);
  return mod.run(show, context);
}

const OPENING_DATE = '2026-04-20';
const SHOW = {
  id: 'bypass-corpus-fixture',
  title: 'Schmigadoon!',
  slug: 'schmigadoon',
  openingDate: OPENING_DATE,
  category: 'broadway',
  status: 'open',
};

// Long enough to clear the 80-char fulltext gate; never mentions the show.
const OFF_SHOW_FULLTEXT = (
  'Synthetic test fixture. This text deliberately does not mention the show '
  + 'under review and is long enough to pass the minimum-length gates in '
  + 'fulltext-mentions-show.check.js. It describes an entirely different '
  + 'production to simulate cross-show contamination at ingest time. '
  + 'lorem ipsum dolor sit amet, '.repeat(40)
);

// Mentions the show multiple times — used when a fixture needs to isolate a
// different bypass class without also tripping fulltext-mentions-show.
const ON_SHOW_FULLTEXT = (
  'Synthetic test fixture for Schmigadoon. This is a placeholder body for a '
  + 'review of Schmigadoon on Broadway, long enough to pass minimum-length '
  + 'gates. It mentions Schmigadoon multiple times so the fulltext check '
  + 'will not flag it. Schmigadoon Schmigadoon Schmigadoon. '
  + 'lorem ipsum dolor sit amet, '.repeat(30)
);

const SHIPPED_REVIEW_BASE = {
  outletId: 'theatrely',
  criticName: 'Test Critic',
  assignedScore: 80,
  scoreSource: 'llm_ensemble',
  publishDate: OPENING_DATE,
};

function buildContext({ fixtureFilename, fixture, reviewsOverride }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-corpus-'));
  const showDir = path.join(tmpRoot, SHOW.id);
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, fixtureFilename), JSON.stringify(fixture));

  const review = {
    ...SHIPPED_REVIEW_BASE,
    url: fixture.url,
    publishDate: fixture.publishDate || SHIPPED_REVIEW_BASE.publishDate,
    ...(reviewsOverride || {}),
  };

  return {
    tmpRoot,
    context: {
      reviewTextsRoot: tmpRoot,
      reviewsDoc: { [SHOW.id]: [review] },
      shows: [SHOW],
      driftState: {},
      criticConsensusDoc: {},
      now: new Date(OPENING_DATE + 'T23:00:00Z'),
    },
  };
}

async function assertPluginFires(name, show, context) {
  const result = await runPlugin(name, show, context);
  assert.equal(result.ok, false, `${name} expected to fire (ok=false), got ok=${result.ok}: ${result.message}`);
  assert.equal(
    result.severity,
    'error',
    `${name} expected severity=error, got ${result.severity}: ${result.message}`
  );
}

// ---- Class 1: CV-wrongProduction bypass via [OVERRIDE] string -----------
// The juan-a-ramirez class. CV LLM correctly flagged wrongProduction=true,
// but an [OVERRIDE] string in the reasoning downgraded confidence to "low",
// which prevents the top-level wrongProduction field from being set, so
// isIncludableForRebuild passes and the review ships.

describe('bypass corpus — Class 1: CV-wrongProduction bypass via [OVERRIDE]', () => {
  let tmpRoot, ctx;
  before(() => {
    const fixture = {
      showId: SHOW.id,
      outletId: 'theatrely',
      criticName: 'Test Critic',
      url: 'https://www.theatrely.com/post/daniel-radcliffe-crowd-sources-community-in-every-brilliant-thing-review',
      bwwRoundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-EVERY-BRILLIANT-THING-on-Broadway-20260312',
      publishDate: OPENING_DATE,
      fullText: OFF_SHOW_FULLTEXT,
      textWordCount: 300,
      isFullReview: true,
      contentTier: 'complete',
      contentVerification: {
        wrongProduction: true,
        confidence: 'low',
        reasoning: '[OVERRIDE: review within 1d of opening, likely correct production] The scraped content is a valid Broadway theater review, but it reviews the wrong production entirely.',
        issues: ['reviews a different production'],
      },
    };
    const built = buildContext({ fixtureFilename: 'theatrely--test-critic.json', fixture });
    tmpRoot = built.tmpRoot;
    ctx = built.context;
  });
  after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('slug-mismatch fires', () => assertPluginFires('slug-mismatch', SHOW, ctx));
  it('roundup-url-mismatch fires', () => assertPluginFires('roundup-url-mismatch', SHOW, ctx));
  it('fulltext-mentions-show fires', () => assertPluginFires('fulltext-mentions-show', SHOW, ctx));
  it('cv-wrongproduction-unhandled fires', () => assertPluginFires('cv-wrongproduction-unhandled', SHOW, ctx));
});

// ---- Class 2: Wrong-slug-in-URL (Kennedy Center tryout scraped) ---------
// SERP returned a pre-Broadway tryout URL. fullText is a vaguely-relevant
// review of a different production. URL slug alone flags it.

describe('bypass corpus — Class 2: wrong-slug-in-url (tryout URL scraped)', () => {
  let tmpRoot, ctx;
  before(() => {
    const fixture = {
      showId: SHOW.id,
      outletId: 'dcmetrotheaterarts',
      criticName: 'Test Critic',
      url: 'https://dcmetrotheaterarts.com/2025/11/kennedy-center-world-premiere-of-some-other-show-review/',
      publishDate: OPENING_DATE,
      // OFF-show fullText: a real Kennedy Center tryout review of a different
      // production wouldn't mention the eventual Broadway title. This exercises
      // the REALISTIC case — both URL slug and fullText should fail.
      fullText: OFF_SHOW_FULLTEXT,
      textWordCount: 300,
      isFullReview: true,
      contentTier: 'complete',
    };
    const built = buildContext({ fixtureFilename: 'dcmetrotheaterarts--test-critic.json', fixture });
    tmpRoot = built.tmpRoot;
    ctx = built.context;
  });
  after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('slug-mismatch fires', () => assertPluginFires('slug-mismatch', SHOW, ctx));
  it('fulltext-mentions-show also fires (defense in depth)', () =>
    assertPluginFires('fulltext-mentions-show', SHOW, ctx));
});

// ---- Class 3: Cross-show bwwRoundupUrl ---------------------------------
// Real case: amny Schmig review had bwwRoundupUrl pointing to EBT's roundup.
// URL slug is correct and fullText mentions the show, but BWW roundup
// attribution is wrong — pulls wrong excerpts/score attribution downstream.

describe('bypass corpus — Class 3: cross-show bwwRoundupUrl', () => {
  let tmpRoot, ctx;
  before(() => {
    const fixture = {
      showId: SHOW.id,
      outletId: 'amny',
      criticName: 'Test Critic',
      url: 'https://www.amny.com/entertainment/schmigadoon-broadway-review-2026/',
      bwwRoundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-EVERY-BRILLIANT-THING-on-Broadway-20260312',
      publishDate: OPENING_DATE,
      fullText: ON_SHOW_FULLTEXT,
      textWordCount: 300,
      isFullReview: true,
      contentTier: 'complete',
    };
    const built = buildContext({ fixtureFilename: 'amny--test-critic.json', fixture });
    tmpRoot = built.tmpRoot;
    ctx = built.context;
  });
  after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('roundup-url-mismatch fires', () => assertPluginFires('roundup-url-mismatch', SHOW, ctx));
});

// ---- Class 4: Anticipatory pre-opening post -----------------------------
// frontmezzjunkies scored 76 for an article published 16 days before opening.
// Everything else is correct — URL, roundup, fullText, CV — but the article
// is an anticipation piece about previews, not a review.

describe('bypass corpus — Class 4: anticipatory pre-opening post', () => {
  let tmpRoot, ctx;
  before(() => {
    const preOpeningDate = '2026-04-04'; // 16 days before OPENING_DATE
    const fixture = {
      showId: SHOW.id,
      outletId: 'frontmezzjunkies',
      criticName: 'Test Critic',
      url: 'https://frontmezzjunkies.com/2026/04/04/schmigadoon-broadway-preview-anticipation/',
      publishDate: preOpeningDate,
      fullText: ON_SHOW_FULLTEXT,
      textWordCount: 300,
      isFullReview: true,
      contentTier: 'complete',
    };
    const built = buildContext({
      fixtureFilename: 'frontmezzjunkies--test-critic.json',
      fixture,
      reviewsOverride: { publishDate: preOpeningDate },
    });
    tmpRoot = built.tmpRoot;
    ctx = built.context;
  });
  after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('publish-date-pre-opening fires', () => assertPluginFires('publish-date-pre-opening', SHOW, ctx));
});

// ---- Class 5: Non-numeric assignedScore (nypost "2/4 stars") ------------
// The score extractor returned a string "2/4 stars" instead of parsing it to
// a number. validate-data.js missed it because `"2/4 stars" < 0` is false.
// The per-show plugin surfaces it as a hard error before broadcast.

describe('bypass corpus — Class 5: non-numeric assignedScore', () => {
  let tmpRoot, ctx;
  before(() => {
    const fixture = {
      showId: SHOW.id,
      outletId: 'nypost',
      criticName: 'Test Critic',
      url: 'https://nypost.com/2026/04/20/schmigadoon-broadway-review/',
      publishDate: OPENING_DATE,
      fullText: ON_SHOW_FULLTEXT,
      textWordCount: 300,
      isFullReview: true,
      contentTier: 'complete',
    };
    const built = buildContext({
      fixtureFilename: 'nypost--test-critic.json',
      fixture,
      reviewsOverride: { assignedScore: '2/4 stars' },
    });
    tmpRoot = built.tmpRoot;
    ctx = built.context;
  });
  after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('assigned-score-schema fires', () => assertPluginFires('assigned-score-schema', SHOW, ctx));
});
