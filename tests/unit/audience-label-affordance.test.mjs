/**
 * Homepage 'AUDIENCE ↑' rage-click fix (task #30, mirrors 'CRITICS ↑' task #78
 * and 'NEWEST ↓' task #929 — all three are the same ToggleBar component, so
 * the same shared-component fix resolves all three labels at once).
 *
 * The label was already a functional sort trigger (clicking it calls
 * updateParams to re-sort by audienceCombinedScore) — the rage clicks came
 * from a lack of feedback that the click had registered, not from the
 * control being dead. Regression guard: read the real ToggleBar source and
 * HomePageClient's SORT row and assert (a) the AUDIENCE option is wired to a
 * real onChange handler that changes the sort param, and (b) the rendered
 * button carries the affordance fix — cursor-pointer, a tooltip describing
 * what the click does, and pressed-state visual feedback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOGGLE_BAR_SRC = readFileSync(
  join(ROOT, 'src/components/show-cards/ToggleBar.tsx'),
  'utf8'
);
const HOME_CLIENT_SRC = readFileSync(
  join(ROOT, 'src/components/HomePageClient.tsx'),
  'utf8'
);

test('ToggleBar option supports a tooltip (title) describing the click action', () => {
  assert.match(TOGGLE_BAR_SRC, /title\?:\s*string/, 'ToggleBarOption must declare an optional title field');
  assert.match(TOGGLE_BAR_SRC, /title=\{option\.title\}/, 'the rendered <button> must pass option.title through as its title attribute');
});

test('ToggleBar default-variant button signals interactivity (cursor + press feedback)', () => {
  // Isolate the default-variant button (after the pill-variant early return).
  const defaultVariantSrc = TOGGLE_BAR_SRC.slice(TOGGLE_BAR_SRC.indexOf("if (variant === 'pill')") + 1);
  assert.match(defaultVariantSrc, /cursor-pointer/, 'default-variant sort button must show a pointer cursor');
  assert.match(defaultVariantSrc, /active:scale-95/, 'default-variant sort button must give tactile press feedback');
});

function extractSortBlock(src) {
  const sortBlockStart = src.indexOf('label="SORT:"');
  assert.ok(sortBlockStart !== -1, 'SORT ToggleBar not found in HomePageClient');
  const sortBlockEnd = src.indexOf('ariaLabel="Sort shows"', sortBlockStart);
  assert.ok(sortBlockEnd !== -1, 'end of SORT ToggleBar (ariaLabel="Sort shows") not found');
  return src.slice(sortBlockStart, sortBlockEnd);
}

test('homepage SORT row wires the AUDIENCE option to a real sort-changing handler', () => {
  const sortBlock = extractSortBlock(HOME_CLIENT_SRC);

  assert.match(sortBlock, /value: 'audience_buzz' as SortParam/, 'AUDIENCE option must map to the audience_buzz sort value');
  assert.match(sortBlock, /updateParams\(\{ sort: next \}\)/, 'clicking a sort option must call updateParams to actually change the sort');
});

test('homepage AUDIENCE sort option carries a title tooltip for every direction state', () => {
  const sortBlock = extractSortBlock(HOME_CLIENT_SRC);

  const audienceOptionMatch = sortBlock.match(
    /value: 'audience_buzz' as SortParam,\s*\n\s*label:[^\n]*\n\s*title:\s*([^\n]*)\n/
  );
  assert.ok(audienceOptionMatch, 'AUDIENCE option block with a title line not found');
  const titleExpr = audienceOptionMatch[1];

  assert.match(titleExpr, /audience score, highest first/i);
  assert.match(titleExpr, /audience score, lowest first/i);
  assert.match(titleExpr, /click to sort by audience score/i);
  // No em dashes in user-facing tooltip copy.
  assert.doesNotMatch(titleExpr, /—/);
});

test('switching Score Mode to audience lands on the audience_buzz sort, not score_desc', () => {
  // Root cause behind the AUDIENCE rage clicks: score_desc/score_asc adapt to
  // scoreMode (see the sort switch), so forcing sort:'score_desc' on mode-switch
  // left CRITICS visually active while the list was already audience-sorted —
  // clicking AUDIENCE couldn't change anything already displayed. Guard against
  // regressing back to that state.
  const scoreToggleStart = HOME_CLIENT_SRC.indexOf('<ScoreToggle');
  assert.ok(scoreToggleStart !== -1, 'ScoreToggle usage not found in HomePageClient');
  const scoreToggleEnd = HOME_CLIENT_SRC.indexOf('className="flex-shrink-0"', scoreToggleStart);
  assert.ok(scoreToggleEnd !== -1, 'end of ScoreToggle usage not found');
  const scoreToggleBlock = HOME_CLIENT_SRC.slice(scoreToggleStart, scoreToggleEnd);

  assert.match(
    scoreToggleBlock,
    /updateParams\(\{ scoreMode: key, sort: 'audience_buzz' \}\)/,
    "switching to audience scoreMode must set sort:'audience_buzz' so AUDIENCE (not CRITICS) shows as active"
  );
});
