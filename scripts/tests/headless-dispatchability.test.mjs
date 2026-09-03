// Acceptance test for task #1004 — the backlog drain must refuse, at SELECTION
// time, cards an unattended session structurally cannot finish.
//
// Per CLAUDE.md §15 the decision logic is NOT copied here: every assertion runs
// the real exported classifier from scripts/lib/headless-dispatchability.js, so
// a production change that widens or narrows the gate fails this test.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  BLOCKERS,
  UI_PATH_RE,
  PARKED_SENTINEL_RE,
  classifyHeadlessDispatchability,
  looksLikeUiPath,
  uiPathsIn,
} = require(path.join(REPO, 'scripts', 'lib', 'headless-dispatchability.js'));

const codes = (r) => r.blockers.map(b => b.code);

describe('(a) a card touching src/**/*.tsx is NOT headless-dispatchable', () => {
  test('explicit .tsx path in the notes blocks on the visual-qa gate', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Sort labels: add click affordance',
      notes: [
        'The fix lives in src/components/show-cards/ToggleBar.tsx.',
        '## Acceptance criteria',
        '`node --test tests/unit/audience-label-affordance.test.mjs`',
      ].join('\n'),
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.VISUAL_QA_GATE), `expected VISUAL_QA_GATE, got ${codes(r).join(',')}`);
    assert.match(r.reason, /ToggleBar\.tsx/);
  });

  test('a glob written as src/**/*.{tsx,jsx,css} blocks too', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Homepage polish',
      notes: 'Any UI change under src/**/*.{tsx,jsx,css} needs the gate.\n`node --test tests/unit/x.test.mjs`',
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.VISUAL_QA_GATE));
  });

  test('task #30 — the real rage-click card the drain should never have picked', () => {
    // Subject verbatim from the shared task list; the card body named no file,
    // which is exactly why a path-only check would have let it through.
    const r = classifyHeadlessDispatchability({
      subject: "Rage clicks on 'AUDIENCE ↑' homepage label (new variant)",
      notes: 'PostHog recorded repeated clicks on the AUDIENCE sort label.\n## Acceptance criteria\n`node --test tests/unit/audience-label-affordance.test.mjs`',
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.VISUAL_QA_GATE));
  });

  test('task #63 — the rage-click phrase is not always the title prefix', () => {
    // Real pending subject Codex found slipping through an anchored regex.
    const r = classifyHeadlessDispatchability({
      subject: 'Homepage rage clicks persist beyond known labeled issues',
      notes: '## Acceptance criteria\n`node --test tests/unit/x.test.mjs`',
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.VISUAL_QA_GATE));
  });

  test('the card-class match is SUBJECT-scoped — a backend card citing a rage-click card stays dispatchable', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Wire WET + The Stage roundups into review-census.js',
      notes: 'Context: the rage clicks card #63 is unrelated.\n\n## Acceptance criteria\n`node --test scripts/lib/x.test.mjs`',
    });
    assert.strictEqual(r.dispatchable, true, r.reason || '');
  });

  test('UX audit cards are the same class', () => {
    const r = classifyHeadlessDispatchability({
      subject: "UX audit: Dead end on 'desktop__lists_tab'. No obvious next action.",
      notes: '`node --test tests/unit/x.test.mjs`',
    });
    assert.ok(codes(r).includes(BLOCKERS.VISUAL_QA_GATE));
  });
});

describe('(b) a card with a pure `node --test` verify IS dispatchable', () => {
  test('script-only card with a runnable acceptance command passes', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Route discover-outlet-reviews-serp.js SERP calls through url-discovery.js',
      notes: [
        'scripts/discover-outlet-reviews-serp.js calls the SERP endpoint directly,',
        'so its spend never reaches data/audit/scraper-spend-ledger.jsonl.',
        '',
        '## Acceptance criteria',
        '`node --test scripts/lib/url-discovery.test.mjs`',
      ].join('\n'),
    });
    assert.deepStrictEqual(r.blockers, [], `expected no blockers, got ${r.reason}`);
    assert.strictEqual(r.dispatchable, true);
    assert.strictEqual(r.reason, null);
  });

  test('a caller that already extracted the verify command can pass it in', () => {
    const r = classifyHeadlessDispatchability(
      { subject: 'Fix run-budget threading', notes: 'acceptance criteria live in the Notion body' },
      { verifyCmd: 'node --test scripts/lib/run-budget.test.mjs' },
    );
    assert.strictEqual(r.dispatchable, true);
  });

  test('no runnable verify command is still a refusal', () => {
    const r = classifyHeadlessDispatchability({ subject: 'Make the pipeline better', notes: 'Investigate and improve.' });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.NO_VERIFY_CMD));
  });
});

describe('the other two gates that stranded real sessions', () => {
  test('task #57 class — completion deferred to a workflow run nobody resumes', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Audience-buzz title-collision sweep',
      notes: 'Wait for the next cron to re-scrape Reddit, then confirm the guard fires.\n`node --test scripts/audit-audience-buzz-contamination.test.mjs`',
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.ASYNC_WAIT_GATE));
  });

  test('a RECHECK-AFTER stamp is a deferred completion, not work for tonight', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Verify Social Pulse v3 before cancelling Apify',
      notes: 'RECHECK-AFTER: 2026-08-10\n`node --test scripts/tests/tm-gap-links.test.mjs`',
    });
    assert.ok(codes(r).includes(BLOCKERS.ASYNC_WAIT_GATE));
  });

  test('2 clean runs is an accumulation the session cannot wait out', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Seeded adversarial weekly probe',
      notes: '2 clean weeks = done.\n`node --test scripts/tests/tm-gap-links.test.mjs`',
    });
    assert.ok(codes(r).includes(BLOCKERS.ASYNC_WAIT_GATE));
  });

  test('an owner-judgment card is refused for headless even though it arms the verify gate', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Decide the policy for bannered newsletter HTML',
      notes: 'VERIFY: owner-judgment',
    });
    assert.strictEqual(r.dispatchable, false);
    assert.ok(codes(r).includes(BLOCKERS.OWNER_DECISION_GATE));
  });

  test('a DECISION NEEDED block is an owner gate', () => {
    const r = classifyHeadlessDispatchability({
      subject: 'Off-off-broadway category',
      notes: 'DECISION NEEDED: pick Option A or B.\n`node --test scripts/tests/tm-gap-links.test.mjs`',
    });
    assert.ok(codes(r).includes(BLOCKERS.OWNER_DECISION_GATE));
  });
});

describe('no false refusals on ordinary backend cards', () => {
  const armed = '\n## Acceptance criteria\n`node --test scripts/lib/x.test.mjs`';
  const cases = [
    ['scripts/lib path', 'Fix review-guards includability', 'scripts/lib/review-guards.js drops skippedSyndicated.' + armed],
    ['a src/ TypeScript lib is not a UI file', 'Canonical critic score helper', 'Use src/lib/scoring.ts only.' + armed],
    ['workflow file', 'Wire audit into test.yml', 'Add a step to .github/workflows/test.yml.' + armed],
    ['data path', 'Triage stale announced shows', 'Read data/shows.json and flip status.' + armed],
  ];
  for (const [name, subject, notes] of cases) {
    test(name, () => {
      const r = classifyHeadlessDispatchability({ subject, notes });
      assert.strictEqual(r.dispatchable, true, `${name} should be dispatchable, got ${r.reason}`);
    });
  }
});

describe('UI path matcher stays in lockstep with the hook that actually blocks the push', () => {
  test('UI_PATH_RE is byte-identical to pre-push-visual-gate.sh UI_PATTERN', () => {
    const hookPath = path.join(REPO, '.claude', 'hooks', 'pre-push-visual-gate.sh');
    const hook = fs.readFileSync(hookPath, 'utf8');
    const m = /^UI_PATTERN='([^']+)'/m.exec(hook);
    assert.ok(m, `could not find UI_PATTERN in ${hookPath} — if the hook was renamed, this drift guard is dead`);
    // The shell pattern is a POSIX ERE with unescaped '/'; JS requires the
    // slash escaped inside a literal. That is the ONLY permitted difference.
    assert.strictEqual(UI_PATH_RE.source.replace(/\\\//g, '/'), m[1]);
  });

  test('looksLikeUiPath agrees with the pattern on concrete files', () => {
    for (const p of ['src/components/Foo.tsx', 'src/app/page.tsx', 'src/styles/globals.css', 'tailwind.config.ts']) {
      assert.ok(looksLikeUiPath(p), `${p} should read as a UI path`);
    }
    for (const p of ['scripts/lib/foo.js', 'src/lib/scoring.ts', 'data/shows.json', 'tests/unit/x.test.mjs']) {
      assert.ok(!looksLikeUiPath(p), `${p} should NOT read as a UI path`);
    }
  });

  test('uiPathsIn strips markdown backticks and trailing punctuation', () => {
    assert.deepStrictEqual(uiPathsIn('see `src/components/Bar.tsx`, then stop.'), ['src/components/Bar.tsx']);
  });
});

// BRO-2753. Measured 2026-09-03 against all 432 live open P0/P1 issues: 160
// carried the sentinel at string start, but 200 carried it at a LINE start, and
// 158 of those 200 were classified dispatchable. The funnel had no knowledge of
// the sentinel at all (`grep -ic PARKED` returned 0), so 127-158 explicitly
// parked cards were being offered to headless workers.
describe('PARKED sentinel — the repo\'s own do-not-dispatch marker', () => {
  const parked = (notes) => classifyHeadlessDispatchability({ subject: 'Some card', notes });

  test('refuses the exact shape linear-issue-create.js writes on --park', () => {
    // `PARKED: ${reason}\n\n${description}` — linear-issue-create.js:141
    const r = parked('PARKED: needs an owner call\n\nrest of the description');
    assert.ok(!r.dispatchable, 'a parked card must not be dispatchable');
    assert.ok(codes(r).includes(BLOCKERS.PARKED_SENTINEL), `expected PARKED_SENTINEL, got ${codes(r)}`);
  });

  test('refuses a phrasing OWNER_DECISION_GATE does not catch', () => {
    // This exact wording slips past the phrase-brittle owner-judgment regex,
    // which is half of why the sentinel check has to exist independently.
    const r = parked('PARKED: Needs an owner-level choice between three fixes');
    assert.ok(!r.dispatchable);
    assert.ok(codes(r).includes(BLOCKERS.PARKED_SENTINEL));
  });

  test('refuses when Notion mirror headers precede the sentinel (the /m case)', () => {
    // Real shape, from BRO-2432 and 39 siblings: two generated header lines
    // before the marker. A string-anchored regex misses all of them.
    const r = parked([
      '[notion:3c8637c5-416f-8100-9535-e040f459a83c] P1 Next · Not started · Bug',
      '[https://app.notion.com/p/whatever](<https://app.notion.com/p/whatever>)',
      'PARKED: card owns this file and is In Progress in a live parallel session',
    ].join('\n'));
    assert.ok(!r.dispatchable, 'a Notion-mirrored parked card must not be dispatchable');
    assert.ok(codes(r).includes(BLOCKERS.PARKED_SENTINEL));
  });

  test('is case- and indent-insensitive', () => {
    assert.ok(codes(parked('  parked:  lowercase and indented')).includes(BLOCKERS.PARKED_SENTINEL));
  });

  test('does NOT fire on incidental prose mentioning parking', () => {
    // These are the 11 the anchor deliberately excludes. If any of them starts
    // failing, the regex has been loosened past line-start and is refusing
    // cards nobody parked.
    for (const notes of [
      'We parked this last week, then unparked it. VERIFY: node scripts/x.js',
      'Fix the parked-cars page. VERIFY: node scripts/x.js',
      'Auto-parked earlier by bsc-reconcile; now live again. VERIFY: node scripts/x.js',
      'See linear-drain-parked.js for context. VERIFY: node scripts/x.js',
    ]) {
      assert.ok(
        !codes(parked(notes)).includes(BLOCKERS.PARKED_SENTINEL),
        `should NOT read as parked: ${notes}`,
      );
    }
  });

  test('the gate is not constant-true — an ordinary card still dispatches', () => {
    const r = parked('Straightforward backend fix.\n\nVERIFY: node scripts/validate-data.js');
    assert.ok(r.dispatchable, `expected dispatchable, blocked by ${codes(r)}`);
    assert.deepStrictEqual(r.blockers, []);
  });

  test('the exported regex and the classifier agree, and keep the /m flag', () => {
    assert.ok(PARKED_SENTINEL_RE.multiline, 'the /m flag is load-bearing — 40 live cards depend on it');
    assert.ok(PARKED_SENTINEL_RE.ignoreCase, 'sentinel matching must be case-insensitive');
    // Assert AGREEMENT, not just the flags: a divergence between the exported
    // regex and whatever the classifier actually tests would otherwise pass.
    for (const notes of [
      'PARKED: at string start',
      'header line\nsecond header\nPARKED: after Notion mirror headers',
      '  parked: indented and lowercase',
      'We parked this last week. VERIFY: node scripts/x.js',
      'Fix the parked-cars page. VERIFY: node scripts/x.js',
    ]) {
      assert.strictEqual(
        codes(parked(notes)).includes(BLOCKERS.PARKED_SENTINEL),
        PARKED_SENTINEL_RE.test(notes),
        `classifier and exported regex disagree on: ${JSON.stringify(notes)}`,
      );
    }
  });
});
