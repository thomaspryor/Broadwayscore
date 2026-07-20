import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DENY_TAGS,
  EXCLUDED_CATEGORIES,
  categoryOf,
  isExcludedCategory,
  isCardEligible,
  isPathAllowed,
  isDiffAllowed,
  isDeterministicGreenPath,
  isDiffDeterministicGreen,
  classifyDataCard,
  isScorecardDataPathAllowed,
  isReviewTextsPathAllowed,
  isDataRepoPathAllowed,
  isDataRepoDiffAllowed,
} = require('./autonomous-eligibility.js');

// ── Card level ──────────────────────────────────────────────────────────────

test('marketing/partnerships categories are ineligible', () => {
  for (const category of ['Marketing', 'Partnerships']) {
    const r = isCardEligible({ name: 'Some product card', category, tags: [] });
    assert.equal(r.eligible, false);
    assert.match(r.reason, /human territory/);
  }
  assert.equal(isCardEligible({ name: 'Fix the thing', category: 'Product', tags: [] }).eligible, true);
});

test('deny-tag card is ineligible regardless of category', () => {
  for (const tag of ['email', 'Commercial', 'scoring', 'ios-app']) {
    const r = isCardEligible({ name: 'Improve pipeline', category: 'Product', tags: ['ci', tag] });
    assert.equal(r.eligible, false, `tag ${tag} should deny`);
    assert.match(r.reason, /deny-tag/);
  }
});

test('categoryless cards fail closed on human-action verbs regardless of title length', () => {
  for (const category of ['', null, undefined, 'no-category', 'No-Category']) {
    const r = isCardEligible({ name: 'Ask Dennis T to mentor (Tony voter + coproducer path)', category, tags: [] });
    assert.equal(r.eligible, false, `category=${JSON.stringify(category)} must be ineligible`);
    assert.match(r.reason, /no category/);
  }
  // Categoryless technical card stays eligible.
  assert.equal(isCardEligible({ name: 'Fix stage-latency rotation cron', category: '', tags: [] }).eligible, true);
  // A real category still vouches for long verb-led product titles.
  assert.equal(isCardEligible({ name: 'Email gate conversion critically low at 0.9% needs investigation', category: 'Product', tags: [] }).eligible, true);
});

test('short human-action imperatives are ineligible; long product subjects are not', () => {
  assert.equal(isCardEligible({ name: 'Email volunteers', category: 'Admin', tags: [] }).eligible, false);
  assert.equal(isCardEligible({ name: 'Reconnect App Store Connect', category: 'Admin', tags: [] }).eligible, false);
  // Long subject starting with the same verb = product card, eligible.
  assert.equal(
    isCardEligible({ name: 'Email gate conversion critically low at 0.9% needs investigation', category: 'Product', tags: [] }).eligible,
    true
  );
});

test('task-mirror helpers parse the fmt:2 meta line', () => {
  const task = { subject: 'Scope the TodayTix partnership', description: '[notion:abc] P1 Next · Not started · Partnerships\nmore' };
  assert.equal(categoryOf(task), 'partnerships');
  assert.equal(isExcludedCategory(task), true);
  const product = { subject: 'Fix rage clicks', description: '[notion:def] P1 Next · Not started · Product\n' };
  assert.equal(isExcludedCategory(product), false);
});

test('null-category tasks (native TaskCreate, no fmt-2 line) fail closed on human-action verbs', () => {
  const nativeEmail = { subject: 'Email volunteers', description: 'plain native description' };
  const nativeLongVerb = { subject: 'Email gate conversion critically low at 0.9%', description: 'no bridge line' };
  const nativeTech = { subject: 'Fix scraper retry logic', description: 'native task' };
  assert.equal(isExcludedCategory(nativeEmail), true);
  assert.equal(isExcludedCategory(nativeLongVerb), true);  // ≤5-word bound does NOT apply without a category
  assert.equal(isExcludedCategory(nativeTech), false);
});

test("'no-category' bridge value (empty Notion category) also fails closed", () => {
  // notion-tasks-sync writes `category || 'no-category'` — a categoryless
  // Notion card must get the same fail-closed treatment as a native task.
  const ask = { subject: 'Ask Dennis T to mentor (Tony voter + coproducer path)', description: '[notion:a] P2 · Not started · no-category' };
  const meet = { subject: 'Meet with Kevin McCollum (lead producer, Two Strangers)', description: '[notion:b] P2 · Not started · no-category' };
  const tech = { subject: 'Fix stage-latency rotation cron', description: '[notion:c] P2 · Not started · no-category' };
  assert.equal(categoryOf(ask), 'no-category');
  assert.equal(isExcludedCategory(ask), true);
  assert.equal(isExcludedCategory(meet), true);
  assert.equal(isExcludedCategory(tech), false);
});

test('categoryOf refuses to parse a category from a non-bridge line ("·" in native text)', () => {
  // Without the [notion: anchor, this description fabricates category "notes"
  // and bypasses the fail-closed branch entirely.
  const sneaky = { subject: 'Email everyone about the launch timeline change', description: 'Priority: P0 · Key files: x · notes' };
  assert.equal(categoryOf(sneaky), null);
  assert.equal(isExcludedCategory(sneaky), true);
});

test('hyphenated compound nouns after a verb are NOT human actions (whitespace lookahead)', () => {
  // Trailing \b treated the hyphen as a boundary: "Post-Tonys … rollout"
  // (bridge Product, 4 words, real task #108) sat in the human-territory list.
  const postTonys = { subject: 'Post-Tonys Broadway anchored-bands rollout', description: '[notion:a] P1 Next · Not started · Product' };
  const nativeHyphen = { subject: 'Reply-to header parsing bug', description: 'native task' };
  const nativeVerb = { subject: 'Post revivals thread on Reddit', description: 'native task' };
  assert.equal(isExcludedCategory(postTonys), false);
  assert.equal(isExcludedCategory(nativeHyphen), false);  // null category, but hyphen ≠ imperative
  assert.equal(isExcludedCategory(nativeVerb), true);     // real imperative still caught
});

// ── Path level ──────────────────────────────────────────────────────────────

test('scoring-delta watchlist files are refused', () => {
  for (const f of [
    'scripts/lib/review-guards.js',
    'scripts/rebuild-all-reviews.js',
    'scripts/lib/rebuild-helpers.js',
    'scripts/lib/score-routing.js',
  ]) {
    assert.equal(isPathAllowed(f), false, `${f} must be refused`);
  }
});

test('audit scripts, gates, workflows, src, data are refused', () => {
  for (const f of [
    'scripts/audit-review-contamination.js',
    'scripts/audit-regex-patterns.js',
    'scripts/lib/contamination-gate.js',
    '.github/workflows/test.yml',
    'src/app/page.tsx',
    'data/shows.json',
    'scripts/lib/scraper.js',
  ]) {
    assert.equal(isPathAllowed(f), false, `${f} must be refused`);
  }
});

test('self-modification is refused', () => {
  for (const f of [
    'scripts/lib/autonomous-eligibility.js',
    'scripts/lib/autonomous-state.js',
    'scripts/autonomous-triage.js',
    'scripts/autonomous-run.js',
  ]) {
    assert.equal(isPathAllowed(f), false, `${f} must be refused`);
  }
});

test('tests/, docs/, memory/ and enumerated tooling files are allowed', () => {
  for (const f of [
    'tests/unit/date-utils.test.mjs',
    'tests/fixtures/some-other-fixture.json',
    'docs/anything.md',
    'memory/some-topic.md',
    './memory/some-topic.md', // normalized
    'scripts/bsc-next.js',
  ]) {
    assert.equal(isPathAllowed(f), true, `${f} must be allowed`);
  }
});

test('traversal, backslashes, and the calibration corpus are refused', () => {
  for (const f of [
    'tests/../src/lib/scoring.ts',
    'docs/../scripts/lib/scraper.js',
    'memory/../.github/workflows/test.yml',
    'tests\\..\\src\\lib\\scoring.ts',
    'tests/fixtures/triage-calibration.json', // loop must not grade its own homework
  ]) {
    assert.equal(isPathAllowed(f), false, `${f} must be refused`);
  }
});

test('default deny: unknown paths refused', () => {
  for (const f of [
    'scripts/lib/date-utils.js', // real lib but not enumerated
    'package.json',
    'next.config.js',
    'README.md',
    '',
  ]) {
    assert.equal(isPathAllowed(f), false, `${f || '(empty)'} must be refused`);
  }
});

test('isDiffAllowed names every refused file', () => {
  const r = isDiffAllowed(['tests/unit/x.test.mjs', 'scripts/lib/review-guards.js', 'src/app/page.tsx']);
  assert.equal(r.allowed, false);
  assert.deepEqual(r.refused, ['scripts/lib/review-guards.js', 'src/app/page.tsx']);
  assert.deepEqual(isDiffAllowed(['docs/a.md', 'memory/b.md']), { allowed: true, refused: [] });
});

// ── Drift guards ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('EXCLUDED_FILES stays in sync with scoring-delta.js watchlists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scoring-delta.js'), 'utf8');
  const { EXCLUDED_FILES } = require('./autonomous-eligibility.js');
  // Pull every quoted path out of the two watchlist arrays.
  const lists = /const INCLUSION_FILES = \[([\s\S]*?)\];[\s\S]*?const SCORE_VALUE_FILES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(lists, 'could not locate watchlist arrays in scoring-delta.js — update this drift guard');
  const entries = [...(lists[1] + lists[2]).matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(entries.length >= 10, `expected ≥10 watchlist entries, parsed ${entries.length}`);
  for (const f of entries) {
    assert.ok(
      EXCLUDED_FILES.has(f) || !isPathAllowed(f),
      `scoring-delta watchlist entry ${f} is not refused by autonomous-eligibility`
    );
  }
});

test('bsc-next re-uses this module (no second copy of the predicate)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bsc-next.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/autonomous-eligibility(\.js)?['"]\)/);
  assert.doesNotMatch(src, /^const EXCLUDED_CATEGORIES = new Set/m, 'bsc-next must not define its own EXCLUDED_CATEGORIES');
});

test('no deny-tag card is ever eligible (absolute exclusion sweep)', () => {
  for (const tag of DENY_TAGS) {
    for (const category of ['Product', 'Admin', ...EXCLUDED_CATEGORIES]) {
      const r = isCardEligible({ name: 'A perfectly reasonable tooling card', category, tags: [tag] });
      assert.equal(r.eligible, false, `tag=${tag} category=${category}`);
    }
  }
});

test('growth round 1: outlet-canonicalize + auto-triage-cross-production allowed; siblings still refused', () => {
  assert.equal(isPathAllowed('scripts/lib/outlet-canonicalize.js'), true);
  assert.equal(isPathAllowed('scripts/auto-triage-cross-production.js'), true);
  assert.equal(isPathAllowed('scripts/lib/scraper.js'), false);        // still excluded
  assert.equal(isPathAllowed('scripts/gather-reviews.js'), false);     // not granted by sibling growth
});

// ── Deterministic-green class (Sprint 3) ────────────────────────────────────

test('all-test-only diff is deterministic-green', () => {
  assert.equal(isDiffDeterministicGreen(['tests/unit/provisional-outlet-onboarding.test.mjs']), true);
  assert.equal(isDiffDeterministicGreen([
    'scripts/bsc-next.test.mjs',
    'tests/unit/foo.test.mjs',
    'docs/some-note.md',
  ]), true);
});

test('tonight\'s real garbage-slugs diff classifies deterministic-green (fixture from Sprint-2 live-fire)', () => {
  assert.equal(isDiffDeterministicGreen(['tests/unit/provisional-outlet-onboarding.test.mjs']), true);
});

test('a diff adding one non-test file is never deterministic-green', () => {
  assert.equal(isDiffDeterministicGreen(['scripts/lib/outlet-canonicalize.js']), false);
  assert.equal(isDiffDeterministicGreen([
    'tests/unit/foo.test.mjs',
    'scripts/lib/outlet-canonicalize.js',
  ]), false);
  // memory/** is Tier-1-allowed but deliberately NOT deterministic-green —
  // it's prose a human should skim, not inert test code.
  assert.equal(isDiffDeterministicGreen(['memory/autonomous-loop-runbook.md']), false);
});

test('empty diff is never deterministic-green', () => {
  assert.equal(isDiffDeterministicGreen([]), false);
  assert.equal(isDiffDeterministicGreen(null), false);
});

test('isDeterministicGreenPath matches the same set isDiffDeterministicGreen requires whole', () => {
  assert.equal(isDeterministicGreenPath('tests/fixtures/some.json'), true);
  assert.equal(isDeterministicGreenPath('docs/runbook.md'), true);
  assert.equal(isDeterministicGreenPath('src/app/page.tsx'), false);
  assert.equal(isDeterministicGreenPath('data/shows.json'), false);
});

// ── Tier 2: data-pipeline card classification (Sprint 4) ────────────────────
// Fixtures are REAL card shapes pulled from Notion 2026-07-14 (batch #109
// missing-show cards + open backlog #27/#55/#56) — not invented examples.

test('missing-show class: tag wins even if the title were generic', () => {
  const card = { name: 'Missing show: King Hedley II', tags: ['friction', 'missing-show', 'fhash:53776abb', 'auto-fix-attempted', 'auto-fix-skipped'] };
  assert.equal(classifyDataCard(card), 'missing-show');
});

test('missing-show class: title prefix alone (no tag) still classifies', () => {
  assert.equal(classifyDataCard({ name: 'Missing show: Vanya (Andrew Scott solo, Lucille Lortel 2025)', tags: ['data-quality'] }), 'missing-show');
});

test('byline-recovery class: real open card #27', () => {
  const card = { name: 'Byline recovery: outlet--unknown entries in reviews.json where a named sibling file exists', tags: ['review-recovery', 'bylines'] };
  assert.equal(classifyDataCard(card), 'byline-recovery');
});

test('cluster-cleanup class: real open cards #55/#56', () => {
  assert.equal(classifyDataCard({ name: "Clean up 10 byline-explosion review clusters (buried/unscored reviews)", tags: ['data-quality', 'reviews', 'dedup', 'west-end'] }), 'cluster-cleanup');
  assert.equal(classifyDataCard({ name: 'Run title-fragment/empty-stub duplicate detector across Broadway + Off-Broadway', tags: [] }), 'cluster-cleanup');
});

test('re-gather class: real completed card wording', () => {
  assert.equal(classifyDataCard({ name: "Delete and re-gather Teeth 'n' Smiles reviews from scratch", tags: [] }), 're-gather');
});

test('unknown card shape default-denies (null), never guesses', () => {
  assert.equal(classifyDataCard({ name: 'Rage clicks on Hamilton show page', tags: [] }), null);
  assert.equal(classifyDataCard({ name: 'CI red: NEWSLETTER_PATTERNS[4] content-quality regex FP rate over threshold', tags: [] }), null);
  assert.equal(classifyDataCard({ name: '', tags: [] }), null);
  assert.equal(classifyDataCard({}), null);
});

test('missing-show title pattern beats a coincidental re-gather-shaped card, order matters', () => {
  // A missing-show card's tag is checked first regardless of title wording.
  assert.equal(classifyDataCard({ name: 'Missing show: Some Re-gather Sounding Title', tags: ['missing-show'] }), 'missing-show');
});

// ── Tier 2: private-repo path allow-lists ────────────────────────────────────

test('scorecard-data repo: only shows.json is writable', () => {
  assert.equal(isScorecardDataPathAllowed('shows.json'), true);
  assert.equal(isScorecardDataPathAllowed('reviews.json'), false); // derived, never hand-edited
  assert.equal(isScorecardDataPathAllowed('commercial.json'), false);
  assert.equal(isScorecardDataPathAllowed('outlet-registry.json'), false);
});

test('review-texts repo: per-show json files allowed, repo-root junk refused', () => {
  assert.equal(isReviewTextsPathAllowed('hamilton-2015/nytg--austin-fimmano.json'), true);
  assert.equal(isReviewTextsPathAllowed('_pending/some-show-2026/outlet--critic.json'), true);
  assert.equal(isReviewTextsPathAllowed('failed-fetches.json'), false); // repo-root file, 1 path segment
  assert.equal(isReviewTextsPathAllowed('tony-hub-desktop.png'), false); // not .json
  assert.equal(isReviewTextsPathAllowed('some-show/nested/deep/file.json'), false); // too deep
  assert.equal(isReviewTextsPathAllowed('../outside.json'), false);
});

test('isDataRepoPathAllowed dispatches to the right repo predicate', () => {
  assert.equal(isDataRepoPathAllowed('scorecard-data', 'shows.json'), true);
  assert.equal(isDataRepoPathAllowed('review-texts', 'hamilton-2015/x.json'), true);
  assert.equal(isDataRepoPathAllowed('review-texts', 'shows.json'), false);
});

test('isDataRepoDiffAllowed refuses unknown repoKey and reports refused files', () => {
  assert.equal(isDataRepoDiffAllowed('scorecard-data', ['shows.json']).allowed, true);
  const bad = isDataRepoDiffAllowed('scorecard-data', ['shows.json', 'reviews.json']);
  assert.equal(bad.allowed, false);
  assert.deepEqual(bad.refused, ['reviews.json']);
  assert.equal(isDataRepoDiffAllowed('review-texts', ['hamilton-2015/nytg--x.json']).allowed, true);
  assert.equal(isDataRepoDiffAllowed('nonsense-repo', ['shows.json']).allowed, false);
});

test('owner-action deny-tag: personal-queue cards never reach the loop (2026-07-19)', () => {
  const r = isCardEligible({ id: 'x', name: 'Follow up with TodayTix on affiliate approval', status: 'Not started', category: 'Product', tags: ['owner-action'] });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /deny-tag "owner-action"/);
});
