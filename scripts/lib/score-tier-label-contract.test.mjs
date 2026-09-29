/**
 * Contract guard for the score-tier label split (Skippable→Mixed rename, 2026-06-30).
 *
 * The 55-64 band has TWO distinct labels by design:
 *   - DATA / wire key  = "Skippable"  (scoring.ts getCriticLabel → engine.ts → mobile-shows.json
 *     cr.l, fantasy points). NEVER rename without coordinating the iOS app + fantasy data.
 *   - DISPLAY label     = "Mixed"      (score-buckets SCORE_BUCKETS, ScoreBadge SCORE_TIERS,
 *     route handlers, email, methodology, etc. — what humans see).
 *
 * Plan-review (2026-06-30) found that a blind rename would (a) desync the iOS app, (b) zero out
 * 55-64 fantasy points (undefined map key), and (c) silently render the wrong red color
 * (ScoreBadge `?? 'score-skip'` fallback) — all passing tsc/lint. This test pins the invariants
 * so none of those classes can come back. Source-string structural checks (no React import).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

test('DATA/wire label stays "Skippable" (iOS + fantasy contract)', () => {
  // scoring.ts getCriticLabel feeds engine.ts -> mobile-shows.json cr.l, read by the iOS app.
  assert.match(read('src/config/scoring.ts'), /score >= 55\) return 'Skippable'/,
    'scoring.ts getCriticLabel must still emit "Skippable" — renaming desyncs mobile-shows.json/iOS');
  // The same wire label is the key in the fantasy points map. Since the
  // 2026-27 relaunch the map lives in fantasy-season.json (one file read by
  // the site, the API and the weekly scripts) and fantasy.ts re-exports it.
  assert.match(read('src/config/fantasy-season.json'), /"Skippable":\s*\d/,
    'fantasy-season.json scoring.criticScore must keep the "Skippable" key or 55-64 shows score undefined points');
  assert.match(read('src/config/fantasy.ts'), /CRITIC_SCORE_POINTS[^\n]*seasonConfig\.scoring\.criticScore/,
    'fantasy.ts CRITIC_SCORE_POINTS must come from fantasy-season.json (the file the guard above pins)');
  // The mobile-data generator and the shared fantasy scorer emit the same wire key.
  assert.match(read('scripts/generate-mobile-data.js'), /score >= 55\) return 'Skippable'/);
  assert.match(read('scripts/lib/fantasy-helpers.js'), /score >= 55\) return 'Skippable'/,
    'fantasy-helpers.js criticLabelForScore must still emit "Skippable" — it keys the points map for the weekly scorer');
  assert.match(read('scripts/compute-fantasy-scores.js'), /criticLabelForScore/,
    'compute-fantasy-scores.js must use the shared criticLabelForScore (no local copy to drift)');
});

test('DISPLAY label is "Mixed" everywhere a human sees the 55-64 tier', () => {
  const sb = read('src/config/score-buckets.ts');
  assert.match(sb, /id: 'skippable',\s*\n\s*label: 'Mixed',\s*\n\s*shortLabel: 'Mixed'/,
    'score-buckets SCORE_BUCKETS 55-64 label must display "Mixed"');
  assert.match(read('src/components/show-cards/ScoreBadge.tsx'), /skippable: \{\s*\n\s*label: 'Mixed'/,
    'ScoreBadge SCORE_TIERS.skippable.label must display "Mixed"');
  // The fantasy guide ScorePill must render the DISPLAY label, not the data label.
  assert.match(read('src/app/fantasy/guide/page.tsx'), /getScoreLabel\(score\)/,
    'fantasy/guide ScorePill must use getScoreLabel (display), not getCriticLabel (data)');
});

test('ScoreBadge color/text maps are keyed in lockstep with the display label (no silent red fallback)', () => {
  const sb = read('src/components/show-cards/ScoreBadge.tsx');
  // getColorClass does TIER_COLOR_CLASS[tier.label] ?? 'score-skip'. tier.label is now "Mixed",
  // so the map MUST have a "Mixed" key or every 55-64 show renders the danger red color.
  assert.match(sb, /'Mixed': 'score-tepid'/, 'TIER_COLOR_CLASS missing "Mixed" key → wrong color');
  assert.match(sb, /'Mixed': 'text-score-tepid'/, 'TIER_TEXT_CLASS missing "Mixed" key → wrong text color');
  assert.doesNotMatch(sb, /'Skippable':/, 'ScoreBadge must not retain a stale "Skippable" map key');
});

test('show/[slug] sentiment maps keyed by the display label resolve for the Mixed tier', () => {
  const pg = read('src/app/show/[slug]/page.tsx');
  // Keyed by getScoreTier().label === "Mixed"; a stale "Skippable" key would silently drop the phrase.
  assert.match(pg, /'Mixed': 'Mixed Reviews'/);
  assert.match(pg, /'Mixed': `Critics are mixed on/);
});

test('no user-facing "Skippable" remains in display surfaces', () => {
  const displayFiles = [
    'src/config/score-buckets.ts', 'src/components/show-cards/ScoreBadge.tsx',
    'src/app/api/og/route.tsx', 'src/app/api/badge/[slug]/route.ts', 'src/app/embed/[slug]/route.ts',
    'src/app/show/[slug]/opengraph-image.tsx', 'src/app/show/[slug]/page.tsx',
    'src/app/methodology/page.tsx', 'src/app/west-end/methodology/page.tsx',
    'src/app/brand/BrandPageClient.tsx', 'src/components/ReviewsList.tsx',
    'src/components/filters/filter-ui-config.ts', 'src/lib/seo.ts',
    'scripts/lib/email-templates.js', 'scripts/lib/email-components.js',
  ];
  for (const f of displayFiles) {
    assert.doesNotMatch(read(f), /Skippable/, `${f} still shows "Skippable" to users — should be "Mixed"`);
  }
});
