// Regression test for card #91 ("Rage clicks on /best-value page, 3 occurrences").
//
// PostHog session recordings could not be pulled for this investigation (no
// POSTHOG_PERSONAL_API_KEY configured on this machine) — this fix is based on
// a code-level audit of every clickable-looking element on /best-value.
//
// Root cause: BestValueTable.tsx applied `hover:bg-white/5` unconditionally to
// every table row, but the row's onClick (expand to show all discount
// options) only fires when the show has more than one discount option
// (`hasMultiple`). A single-option row highlighted on hover exactly like an
// expandable row, then did nothing when clicked — a textbook rage-click
// trigger (visually implies interactivity, delivers none). Fix: the hover
// class is now gated on `hasMultiple`, matching the existing `cursor-pointer`
// gate, so only rows that actually respond to a click look clickable.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_PATH = join(ROOT, 'src/app/best-value/BestValueTable.tsx');

function rowTrBlock() {
  const src = readFileSync(SRC_PATH, 'utf8');
  const start = src.indexOf('<tr\n                    className=');
  assert.ok(start !== -1, 'expandable row <tr> not found in BestValueTable.tsx');
  const end = src.indexOf('</tr>', start);
  assert.ok(end !== -1, 'end of expandable row <tr> not found in BestValueTable.tsx');
  return src.slice(start, end);
}

describe('/best-value table row hover affordance matches actual click behavior', () => {
  const block = rowTrBlock();

  test('hover highlight is gated on hasMultiple, not applied to every row', () => {
    assert.doesNotMatch(
      block,
      /className=\{`border-b border-white\/5 hover:bg-white\/5 transition-colors/,
      'hover:bg-white/5 must not be unconditional — a single-option row highlights on hover but its onClick is a no-op, which reads as broken and triggers rage clicks',
    );
    assert.match(
      block,
      /hasMultiple \? 'cursor-pointer hover:bg-white\/5' : ''/,
      'hover:bg-white/5 must be gated behind the same hasMultiple check as cursor-pointer',
    );
  });

  test('onClick itself remains gated on hasMultiple (no functional regression)', () => {
    assert.match(
      block,
      /onClick=\{\(\) => hasMultiple && setExpandedSlug\(isExpanded \? null : row\.slug\)\}/,
      'row click-to-expand must still only fire for shows with more than one discount option',
    );
  });
});

describe('hasMultiple / cursor-pointer / hover gating stay in lockstep (no future drift)', () => {
  function rowClassName(hasMultiple, isExpanded) {
    return `border-b border-white/5 transition-colors ${hasMultiple ? 'cursor-pointer hover:bg-white/5' : ''} ${isExpanded ? 'border-b-0' : ''}`;
  }

  test('single-option row gets no cursor-pointer and no hover class', () => {
    const cls = rowClassName(false, false);
    assert.doesNotMatch(cls, /cursor-pointer/);
    assert.doesNotMatch(cls, /hover:bg-white\/5/);
  });

  test('multi-option row gets both cursor-pointer and hover class', () => {
    const cls = rowClassName(true, false);
    assert.match(cls, /cursor-pointer/);
    assert.match(cls, /hover:bg-white\/5/);
  });
});
