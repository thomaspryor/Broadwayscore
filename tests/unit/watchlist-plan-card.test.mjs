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
// The sheet lives in PlanSheet.tsx (split out for first-load JS, BRO-7486); it is last so the slice below still starts at it.
const CARD = read('src/components/user/WatchlistPlanCard.tsx') + '\n' + read('src/components/user/PlanSheet.tsx');
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
  assert.match(CARD, /Remove from To See/);
  assert.match(CARD, /className="focus-ring rounded-lg h-11 px-3 text-sm font-semibold text-score-skip hover:underline/, 'Remove is a 44px red text action');
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

test('sheet has a primary Done button that closes it (BRO-7422)', () => {
  // Controls autosave, so with no Save/Done button owners could not tell their
  // change had stuck and had to hunt for the X. Done must stay, be the primary
  // button style, and call onClose.
  const sheet = CARD.slice(CARD.indexOf('function PlanSheet('));
  // Order-independent: find the Done button element, then check its parts.
  const done = sheet.match(/<button[^>]*data-testid="watchlist-plan-done"[^>]*>|<button(?:(?!<\/button>)[\s\S])*?data-testid="watchlist-plan-done"[\s\S]*?>/);
  assert.ok(done, 'Done button missing');
  assert.match(done[0], /onClick=\{onClose\}/, 'Done must close the sheet');
  assert.match(done[0], /className="btn btn-primary w-full h-12"/, 'Done is the primary 48px button');
  assert.match(sheet, /Changes save automatically/);
  assert.ok(
    sheet.indexOf('watchlist-plan-done') < sheet.indexOf('<AddToCalendarButtons'),
    'Done is the primary action and sits above the secondary actions',
  );
  // Owner 2026-11-12: "just one main CTA". Done is the only filled button;
  // Add to calendar is the quiet text look and Remove is red text.
  assert.equal((sheet.match(/btn-primary/g) || []).length, 1, 'exactly one primary button');
  assert.doesNotMatch(sheet, /btn btn-secondary/, 'no second filled button in the sheet');
  assert.match(sheet, /<AddToCalendarButtons event=\{event\} quiet \/>/, 'calendar uses the quiet look');
});

test('quiet text actions keep 44px targets and a keyboard focus ring (BRO-7422 ship-check)', () => {
  const sheet = CARD.slice(CARD.indexOf('function PlanSheet('));
  assert.match(sheet, /className="focus-ring rounded-lg h-11 px-3 [^"]*text-score-skip/, 'Remove: focus ring + 44px');
  assert.doesNotMatch(sheet, /aria-live/, 'a live region on static text announces nothing');
  const cal = read('src/components/user/AddToCalendarButtons.tsx');
  assert.match(cal, /'focus-ring rounded-lg inline-flex items-center justify-center h-11 [^']*text-white hover:underline'/, 'quiet calendar: focus ring + 44px');
  // Other callers (MyShowsClient, SharedPlansView) never pass quiet: their look must not drift.
  assert.match(cal, /'btn btn-secondary w-full min-h-\[44px\] px-1\.5 py-1 text-xs leading-tight'/, 'compact look unchanged');
  assert.match(cal, /'btn btn-secondary h-11 px-3 gap-1\.5 text-sm'/, 'default look unchanged');
});

test('diary-only show page can delete a rating', () => {
  const diary = read('src/app/diary-show/[id]/DiaryShowClient.tsx');
  assert.match(diary, /<RatingEditor[\s\S]*?onDelete=\{editingReview \? handleDeleteRating : undefined\}/);
});
