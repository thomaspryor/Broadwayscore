/**
 * Show-page "your plans" card (owner, 2026-10-03: the 10px Matinee / Evening /
 * Custom chips were "tiny and unprofessional", and watched shows had no
 * matching card). Guards:
 *  - both show-page surfaces render WatchlistPlanCard, not inline chips;
 *  - every control in the card and sheet is at least 44px tall;
 *  - no sub-12px text (text-[10px] / text-[11px]) in the card;
 *  - the rating rows share the same PlanRow look, with no buttons nested inside
 *    the row button (StarRating renders buttons even when read-only);
 *  - every sheet control is locked while a save runs;
 *  - the diary-only show page can delete a rating, since My Shows posters
 *    no longer carry a delete button (ship-check 2026-10-04).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const CARD = read('src/components/user/WatchlistPlanCard.tsx');
const HERO = read('src/components/show-page/ShowHeroRedesign.tsx');
const BUTTON = read('src/components/user/ShowPageWatchlistButton.tsx');

test('both show-page surfaces use WatchlistPlanCard', () => {
  for (const [name, src] of [['ShowHeroRedesign', HERO], ['ShowPageWatchlistButton', BUTTON]]) {
    assert.match(src, /<WatchlistPlanCard\b/, `${name} lost the plan card`);
    assert.doesNotMatch(src, /ShowtimePicker|DatePickerButton/, `${name} renders date/showtime controls inline again`);
  }
});

test('plan card and sheet controls are at least 44px tall', () => {
  assert.match(CARD, /function slotClass[\s\S]*?h-16/, 'showtime buttons must stay h-16');
  assert.match(CARD, /ariaLabel="Planned date"[\s\S]*?className="w-full h-12/, 'date field must stay h-12');
  assert.match(CARD, /Remove from watchlist/);
  assert.match(CARD, /className="btn btn-secondary w-full h-12 text-score-skip"/);
  assert.match(CARD, /className="card-interactive w-full flex items-center gap-3 p-3/, 'row is a full-width card');
});

test('no sub-12px text in the plan card', () => {
  assert.doesNotMatch(CARD, /text-\[(?:9|10|11)px\]/);
});

test('rating rows reuse PlanRow with no nested buttons', () => {
  const start = HERO.indexOf('function YourRatingInline(');
  const body = HERO.slice(start, HERO.indexOf('\nfunction ', start + 10));
  assert.match(body, /<PlanRow\b/);
  assert.doesNotMatch(body, /<StarRating\b|<button\b/, 'interactive element inside the row button');
  assert.match(body, /<MiniStars\b/);
  assert.match(body, /sr-only">Edit</, 'screen readers need to hear the row is editable');
});

test('every sheet control is locked while saving', () => {
  const sheet = CARD.slice(CARD.indexOf('function PlanSheet('));
  assert.match(sheet, /if \(saving\) return;/, 'guarded() must drop re-entrant taps');
  assert.match(sheet, /ariaLabel="Planned date"\s*disabled=\{saving\}/);
  assert.match(sheet, /disabled=\{!date \|\| saving\}/, 'Other must be disabled without a date');
  assert.equal((sheet.match(/disabled=\{saving\}/g) || []).length, 3, 'date, Clear showtime and Remove each need disabled={saving}');
});

test('diary-only show page can delete a rating', () => {
  const diary = read('src/app/diary-show/[id]/DiaryShowClient.tsx');
  assert.match(diary, /<RatingEditor[\s\S]*?onDelete=\{editingReview \? handleDeleteRating : undefined\}/);
});
