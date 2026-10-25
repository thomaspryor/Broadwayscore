/**
 * My Shows toolbar consistency (owner, 2026-10-03: "Why is the share
 * button, filter button, and view type selector all different heights and
 * design styles?"). Share was a btn-secondary, the sort a raw select, the
 * grid/list toggle its own box: three heights, three radii, three fills.
 *
 * Regression guard: every toolbar control uses the shared .toolbar-control
 * class, and ViewModeToggle draws the same height, radius, fill and ring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const PAGE = read('src/app/my-shows/MyShowsClient.tsx');
const CARDS = read('src/components/user/upcoming-cards.tsx');
const CSS = read('src/app/globals.css');

/** The opening tag (up to its first `>`) of each element carrying `marker`. */
function tagsWith(marker) {
  const out = [];
  let i = 0;
  while ((i = PAGE.indexOf(marker, i)) !== -1) {
    const start = PAGE.lastIndexOf('<', i);
    out.push(PAGE.slice(start, PAGE.indexOf('>', i) + 1));
    i += marker.length;
  }
  return out;
}

test('sort selects and Share buttons use .toolbar-control', () => {
  const tags = [
    ...tagsWith('aria-label="Sort diary"'),
    ...tagsWith('aria-label="Sort watchlist"'),
    ...tagsWith('data-testid="share-plans-open'),
  ];
  assert.equal(tags.length, 6, 'desktop + mobile copies of 2 selects and Share');
  for (const tag of tags) {
    assert.match(tag, /className="toolbar-control(?: [^"]*)?"/, `not a toolbar-control: ${tag.slice(0, 120)}`);
  }
});

test('.toolbar-control and ViewModeToggle share height, radius, fill and outline', () => {
  const rule = CSS.slice(CSS.indexOf('.toolbar-control {'), CSS.indexOf('}', CSS.indexOf('.toolbar-control {')));
  const start = CARDS.indexOf('export function ViewModeToggle(');
  const toggle = CARDS.slice(start, CARDS.indexOf('\nexport function ', start + 1));
  for (const token of ['h-11', 'sm:h-9', 'rounded-badge', 'bg-white/[0.06]', 'ring-1', 'ring-inset', 'ring-white/10']) {
    assert.ok(rule.includes(token), `.toolbar-control lacks ${token}`);
    assert.ok(toggle.includes(token), `ViewModeToggle lacks ${token}`);
  }
});

test('My Shows has no Matinee/Evening/Custom picker (show page only)', () => {
  // Owner, 2026-10-03: the showtime chips pushed the watchlist down on
  // phones. Showtimes are set on the show page, never in the My Shows list.
  assert.doesNotMatch(PAGE, /ShowtimePicker/);
  assert.doesNotMatch(PAGE, /onShowtimeChange/);
});

test('Lists panel has its own top gap on phones (no toolbar row above it)', () => {
  // Owner, 2026-10-03: the first list card touched the tab hairline. The
  // tab bar has no bottom margin on phones because Diary/Watchlist put the
  // toolbar row there; Lists has no toolbar, so its panel pads itself.
  assert.match(PAGE, /role="tablist" className="[^"]*\bmb-0 sm:mb-6/);
  assert.match(PAGE, /id="panel-lists"[^>]*className="pt-4 sm:pt-0"/);
});
