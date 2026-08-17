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
  isCodePathAllowed,
  isCodeDiffAllowed,
  isDeterministicGreenPath,
  isDiffDeterministicGreen,
  classifyDataCard,
  isScorecardDataPathAllowed,
  isReviewTextsPathAllowed,
  isDataRepoPathAllowed,
  isDataRepoDiffAllowed,
} = require('./autonomous-eligibility.js');
const { decideChecks } = require('./autonomous-checks.js');

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

// ── Tier 3: code cards (owner-approved 2026-07-25) ─────────────────────────

test('tier3: src/ and scripts/ are allowed; tier 1 stays refused for both', () => {
  for (const p of ['src/components/Foo.tsx', 'src/app/page.tsx', 'scripts/lib/foo.js', 'scripts/query.js']) {
    assert.equal(isCodePathAllowed(p), true, p);
    assert.equal(isPathAllowed(p), false, `tier1 must not allow ${p}`);
  }
});

test('tier3: scoring watchlists stay refused (drift-mirrored set)', () => {
  for (const p of ['src/lib/scoring.ts', 'src/lib/engine.ts', 'src/lib/data-core.ts',
    'scripts/lib/review-guards.js', 'scripts/rebuild-all-reviews.js', 'scripts/lib/score-extractors.js']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
});

test('tier3: the scoring GATES themselves are refused, not just what they guard', () => {
  // Every watchlist file is refused because rule 12.7 requires these gates to
  // run first — but the gates were self-servable, so an unattended agent could
  // weaken the check protecting all of them. The drift guard asserts
  // watchlist ⊆ refused, so it structurally cannot catch the gate's absence;
  // only probing the predicate did.
  for (const p of ['scripts/scoring-delta.js', 'scripts/test-temporal-override-regression.js']) {
    assert.equal(isCodePathAllowed(p), false, `${p} must not be self-servable`);
  }
});

test('tier3: the canonical critic-score reader is refused', () => {
  // CLAUDE.md rule 3: the ONLY sanctioned source for external score claims.
  // Changing it changes what the site tells people its scores are without
  // altering any computation, so no scoring watchlist covers it.
  assert.equal(isCodePathAllowed('scripts/lib/canonical-critic-scores.ts'), false);
});

test('tier3: email senders, brain, dispatcher, audit, self, scraper, gates refused', () => {
  for (const p of ['scripts/send-opening-night-broadcast.js', 'scripts/lib/email-worker.js',
    'scripts/notion-brain.js', 'scripts/notion-tasks-sync.js', 'scripts/bsc-prune.js',
    'scripts/bsc-conductor.js', 'scripts/audit-closing-dates.js', 'scripts/autonomous-run.js',
    'scripts/autonomous-acceptance-recheck.js', 'scripts/lib/autonomous-eligibility.js',
    'scripts/lib/scraper.js', 'scripts/lib/should-deploy-gate.js', 'scripts/finish-line-gate.js']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
});

test('tier3: dependency/deploy/config manifests refused', () => {
  for (const p of ['package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json',
    'vercel.json', 'middleware.ts', 'src/middleware.ts', 'supabase/migrations/x.sql']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
});

test('tier3: workflows and data stay refused; tier-1 territory still allowed', () => {
  assert.equal(isCodePathAllowed('.github/workflows/test.yml'), false);
  assert.equal(isCodePathAllowed('data/shows.json'), false);
  for (const p of ['tests/foo.test.mjs', 'docs/x.md', 'memory/y.md', 'scripts/bsc-next.js', 'scripts/bsc-next.test.mjs']) {
    assert.equal(isCodePathAllowed(p), true, p);
  }
});

test('tier3: traversal and backslash defenses hold', () => {
  assert.equal(isCodePathAllowed('src/../scripts/send-x.js'), false);
  assert.equal(isCodePathAllowed('scripts\\send-x.js'), false);
  assert.equal(isCodePathAllowed(''), false);
});

test('tier3: isCodeDiffAllowed names every refused file', () => {
  const { allowed, refused } = isCodeDiffAllowed(['src/components/Foo.tsx', 'package.json', 'scripts/notion-brain.js']);
  assert.equal(allowed, false);
  assert.deepEqual(refused.sort(), ['package.json', 'scripts/notion-brain.js']);
  assert.deepEqual(isCodeDiffAllowed(['src/a.tsx', 'scripts/lib/b.js']), { allowed: true, refused: [] });
});

test('tier3: NO tier-3 path is deterministic-green (merge tap preserved)', () => {
  for (const p of ['src/components/Foo.tsx', 'scripts/lib/foo.js', 'scripts/query.js']) {
    assert.equal(isDeterministicGreenPath(p), false, p);
  }
  // colocated .test.mjs files remain green — unchanged behavior
  assert.equal(isDeterministicGreenPath('scripts/lib/foo.test.mjs'), true);
});

test('tier3: email-basename, dispatch control-plane, and cmux libs refused (ship-check round)', () => {
  for (const p of ['scripts/lib/affiliate-email.js', 'scripts/lib/brand-mention-email.js',
    'scripts/lib/send-lock.js', 'scripts/lib/email-templates.js',
    'scripts/lib/bsc-next-model.js', 'scripts/lib/cmux-launch.js', 'scripts/lib/cmux-workspaces.js',
    'scripts/lib/dispatch-ledger.js', 'scripts/lib/workspace-naming.js']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
  // basename rule is .js-executable-scoped: test files + non-email libs unaffected
  assert.equal(isCodePathAllowed('scripts/lib/dispatch-ledger.test.mjs'), true);
  assert.equal(isCodePathAllowed('scripts/lib/title-match.js'), true);
});

test('tier3: manifests refused by basename anywhere, not just repo root', () => {
  for (const p of ['scripts/package.json', 'src/package.json', 'scripts/lib/tsconfig.json', 'src/app/middleware.ts']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
});

// ── #454: scripts/ paths the check planner can never verify are refused ────

test('tier3: scripts/ paths with unverifiable extensions are refused before a card is ever planned', () => {
  for (const p of ['scripts/foo.py', 'scripts/lib/bar.sh', 'scripts/lib/config.json', 'scripts/data.yaml', 'scripts/README']) {
    assert.equal(isCodePathAllowed(p), false, p);
  }
});

test('tier3: scripts/ paths with checkable extensions stay allowed', () => {
  for (const p of ['scripts/foo.js', 'scripts/lib/bar.mjs', 'scripts/lib/baz.cjs', 'scripts/lib/qux.ts', 'scripts/lib/quux.tsx']) {
    assert.equal(isCodePathAllowed(p), true, p);
  }
});

test('tier3: src/ paths stay allowed regardless of extension (lint/build cover them)', () => {
  for (const p of ['src/app/globals.css', 'src/data/config.json']) {
    assert.equal(isCodePathAllowed(p), true, p);
  }
});

// The invariant #454 exists to guarantee: every SUBSTANTIVE path (i.e. not
// docs/**, memory/** prose — those are checkless by design, same as
// autonomous-checks.js's own INERT_RE) that isCodePathAllowed() allows under
// Tier 3 must produce at least one runnable check from decideChecks(tier 3)
// — otherwise the loop plans a card it can never verify and burns a full
// implementer envelope discovering that after the fact.
test('tier3: allow-implies-checkable invariant over a representative path set', () => {
  const REPRESENTATIVE_PATHS = [
    'scripts/foo.js', 'scripts/lib/bar.mjs', 'scripts/lib/baz.cjs',
    'scripts/lib/qux.ts', 'scripts/lib/quux.tsx',
    'src/components/Foo.tsx', 'src/app/page.tsx', 'src/lib/util.ts',
    'src/app/globals.css',
    'tests/foo.test.mjs',
    'scripts/bsc-next.js', 'scripts/bsc-next.test.mjs',
  ];
  const existsFn = () => false; // no colocated-test fallback — check the file's OWN extension coverage
  for (const p of REPRESENTATIVE_PATHS) {
    assert.equal(isCodePathAllowed(p), true, `expected ${p} to be allowed`);
    const checks = decideChecks([p], existsFn, { tier: 3 });
    assert.ok(checks.length > 0, `${p} is allowed but decideChecks(tier 3) produced no checks`);
  }
});

test('tier3: refused unverifiable scripts/ paths would ALSO produce no checks (confirms the gate is necessary)', () => {
  const existsFn = () => false;
  for (const p of ['scripts/foo.py', 'scripts/lib/bar.sh', 'scripts/lib/config.json']) {
    assert.equal(isCodePathAllowed(p), false, p);
    const checks = decideChecks([p], existsFn, { tier: 3 });
    assert.equal(checks.length, 0, `${p} unexpectedly produced a check — gate may be over-restrictive`);
  }
});

// ── VERIFY: owner-judgment is a dispatch-time exclusion (task #1154) ────────
//
// The Sarah check-in card (Notion 369637c5-416f-8168-8bde-fa2996a5436e) was
// auto-dispatched twice — 2026-08-06 and 2026-08-09 — through the P0/P1
// backlog sweep in dispatch-watchdog-core.js, which gates on
// isExcludedCategory(). Every heuristic missed it independently: category
// "Admin" is not in EXCLUDED_CATEGORIES, tags social-media/auto-enriched are
// not in DENY_TAGS, and the subject does not lead with a human-action verb.
// The one signal that DID say "a human must do this" — the
// "VERIFY: owner-judgment" marker in its notes — was consulted only by the
// verify gate, where it ARMS a dispatch.

// Verbatim from the real card. If these fixtures start passing without the
// marker check, the card's shape changed — the bug did not.
const SARAH_SUBJECT = 'Sarah check-in: growth plan progress and metrics report';
const SARAH_CATEGORY = 'Admin';
const SARAH_TAGS = ['social-media', 'auto-enriched'];
const SARAH_NOTES = "RECHECK-AFTER: 2026-08-16\n\nDue 2026-05-23. Ask Sarah for status on the growth plan items and last week's metrics across Twitter, Instagram, Bluesky, Threads, Facebook. Pull from Buffer or platform insights. Compare to prior two-week baseline. Identify what's working and what to adjust. Email sarahjaeleiber@gmail.com.\n\nVERIFY: owner-judgment (personal check-in with Sarah Jae — owner must read/verify the report)";

function sarahMirror() {
  return {
    id: '382',
    subject: SARAH_SUBJECT,
    status: 'pending',
    description: [
      `[notion:369637c5-416f-8168-8bde-fa2996a5436e] P2 Later · Not started · ${SARAH_CATEGORY}`,
      'https://app.notion.com/p/x',
      SARAH_NOTES.replace(/\s+/g, ' ').trim().slice(0, 400),
    ].join('\n'),
  };
}

test('#1154: the real Sarah check-in card is excluded from the default pick', () => {
  const task = sarahMirror();
  // Every other heuristic genuinely passes it — that is why the marker check
  // has to exist rather than being redundant belt-and-braces.
  assert.equal(categoryOf(task), 'admin');
  assert.equal(EXCLUDED_CATEGORIES.has('admin'), false);
  assert.equal(SARAH_TAGS.some(t => DENY_TAGS.has(t)), false);
  assert.equal(isExcludedCategory(task), true);
});

test('#1154: the same card is ineligible at card level, with a reason naming the marker', () => {
  const r = isCardEligible({ name: SARAH_SUBJECT, category: SARAH_CATEGORY, tags: SARAH_TAGS, notes: SARAH_NOTES });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /owner-judgment/i);
  // Strip only the marker and the very same card is eligible again — proof the
  // exclusion comes from the marker, not from something else in the fixture.
  const withoutMarker = isCardEligible({
    name: SARAH_SUBJECT,
    category: SARAH_CATEGORY,
    tags: SARAH_TAGS,
    notes: SARAH_NOTES.replace(/VERIFY:\s*owner-judgment/i, 'VERIFY: nothing'),
  });
  assert.equal(withoutMarker.eligible, true);
});

test('#1154: marker matches case- and spacing-insensitively, anywhere in the text', () => {
  for (const notes of ['verify:owner-judgment', 'VERIFY:   Owner-Judgment', 'blah\n\nVERIFY: owner-judgment\n\nmore']) {
    assert.equal(isCardEligible({ name: 'Refactor the widget', category: 'Engineering', notes }).eligible, false, notes);
    assert.equal(isExcludedCategory({
      subject: 'Refactor the widget',
      description: `[notion:x] P1 Next · Not started · Engineering\n${notes}`,
    }), true, notes);
  }
});

test('#1154: cards WITHOUT the marker keep their existing behaviour exactly', () => {
  const eng = { subject: 'Fix the byline dedup', description: '[notion:x] P1 Next · Not started · Engineering\nsome notes' };
  assert.equal(isExcludedCategory(eng), false);
  assert.equal(isCardEligible({ name: 'Fix the byline dedup', category: 'Engineering', notes: 'some notes' }).eligible, true);
  // Pre-existing exclusions still fire for their OWN reasons, not the marker's.
  assert.match(isCardEligible({ name: 'x', category: 'Marketing' }).reason, /human territory/);
  assert.match(isCardEligible({ name: 'x', category: 'Engineering', tags: ['email'] }).reason, /deny-tag/);
  assert.match(isCardEligible({ name: 'Email volunteers', category: 'Admin' }).reason, /human action/);
});

test('#1154: absent/null notes and descriptions never throw and never exclude', () => {
  assert.equal(isCardEligible({ name: 'Fix the widget', category: 'Engineering' }).eligible, true);
  assert.equal(isCardEligible({ name: 'Fix the widget', category: 'Engineering', notes: null }).eligible, true);
  assert.equal(isExcludedCategory({ subject: 'Fix the widget' }), false);
  assert.equal(isExcludedCategory({ subject: 'Fix the widget', description: null }), false);
});

test('#1154: the marker regex has exactly one definition, in a dependency-free leaf', () => {
  // Three layers need it — verify-gate ARMS on it, headless-dispatchability
  // BLOCKS on it, this module EXCLUDES on it — and two of them had their own
  // handwritten copy before the leaf module existed.
  const { OWNER_JUDGMENT_RE } = require('./owner-judgment-marker.js');
  const { OWNER_JUDGMENT_RE: fromVerifyGate } = require('./verify-gate.js');
  const { OWNER_DECISION_RES } = require('./headless-dispatchability.js');
  assert.equal(fromVerifyGate, OWNER_JUDGMENT_RE, 'verify-gate.js re-declared the regex instead of importing it');
  assert.ok(Array.isArray(OWNER_DECISION_RES) && OWNER_DECISION_RES.includes(OWNER_JUDGMENT_RE),
    'headless-dispatchability.js OWNER_DECISION_RES no longer uses the shared regex object');
  // Leaf by construction: loading it must not pull in anything that could
  // require back into this file. That cycle (verify-gate -> triage-core ->
  // here) is what would leave isSafeCheckCommand undefined inside
  // evaluateVerifiability for autonomous-shadow-run.js's require order.
  // Checked against the loaded module record, not the source text — a source
  // grep also matches the word "require()" in the file's own prose.
  const leafPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-judgment-marker.js');
  delete require.cache[leafPath];
  require(leafPath);
  assert.deepEqual(require.cache[leafPath].children.map(c => c.filename), [],
    'owner-judgment-marker.js must stay dependency-free');
});

test('#1154: the require cycle stays broken in BOTH module load orders', () => {
  // autonomous-shadow-run.js requires triage-core before eligibility; other
  // callers do the reverse. Under a cycle one of these orders hands a module a
  // half-built exports object and the failure is silent + permanent.
  for (const order of [
    ['./autonomous-triage-core.js', './verify-gate.js', './autonomous-eligibility.js'],
    ['./autonomous-eligibility.js', './verify-gate.js', './autonomous-triage-core.js'],
  ]) {
    for (const m of order) delete require.cache[require.resolve(m)];
    for (const m of order) require(m);
    const vg = require('./verify-gate.js');
    assert.equal(typeof vg.isSafeCheckCommand, 'function', `isSafeCheckCommand undefined under order ${order.join(' -> ')}`);
    assert.equal(typeof require('./autonomous-triage-core.js').isSafeCheckCommand, 'function', order.join(' -> '));
    assert.equal(vg.evaluateVerifiability('VERIFY: owner-judgment').ownerJudgment, true, order.join(' -> '));
  }
});
