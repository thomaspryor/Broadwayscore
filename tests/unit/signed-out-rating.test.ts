/**
 * BRO-7690: one signed-out rating save for every rating page.
 *
 * The diary-show page still hid a signed-out rating behind the sign-in modal as
 * a one-hour draft (saveDraft + 'auth-gated') after the show page moved to
 * "save on this device first" (BRO-6917). Locks: the shared helper keeps the
 * rating on the device and clears the want-to-see entry; every page that
 * renders RatingEditor routes its signed-out save through it; and the dead
 * welcome-sheet import residue stays gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { saveSignedOutRating, toLocalRatingInput } from '../../src/lib/signed-out-rating';
import { RATINGS_KEY } from '../../src/lib/local-ratings';
import { LIST_KEY } from '../../src/lib/local-watchlist';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function withStorage(fn: (store: Map<string, string>) => void) {
  const g = globalThis as Record<string, unknown>;
  const had = 'localStorage' in g;
  const prev = g.localStorage;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  try { fn(store); } finally { if (had) g.localStorage = prev; else delete g.localStorage; }
}

test('toLocalRatingInput keeps filled fields only', () => {
  assert.deepEqual(
    toLocalRatingInput('s', { rating: 4, reviewText: '', dateSeen: null, timeSlot: 'evening', curtainTime: null, seat: 'B12' }),
    { showId: 's', rating: 4, timeSlot: 'evening', seat: 'B12' },
  );
  assert.deepEqual(toLocalRatingInput('s', { rating: 0 }), { showId: 's', rating: 0 });
});

test('saveSignedOutRating stores the rating on the device and drops the want-to-see entry', () => {
  withStorage((store) => {
    store.set(LIST_KEY, JSON.stringify([{ showId: 'diary-x', savedAt: 1 }, { showId: 'other', savedAt: 2 }]));
    const next = saveSignedOutRating('diary-x', { rating: 3.5, reviewText: 'Loved act two', dateSeen: '2026-11-01' }, 'diary_page');
    assert.equal(next.length, 1);
    const saved = JSON.parse(store.get(RATINGS_KEY) ?? '[]');
    assert.equal(saved[0].showId, 'diary-x');
    assert.equal(saved[0].rating, 3.5);
    assert.equal(saved[0].reviewText, 'Loved act two');
    const watch = JSON.parse(store.get(LIST_KEY) ?? '[]') as { showId: string }[];
    assert.deepEqual(watch.map(e => e.showId), ['other']);
  });
});

/** The signed-out branch of a page's handleSaveReview (up to the authed paths). */
function signedOutBranch(rel: string): string {
  const src = read(rel);
  const start = src.indexOf('const handleSaveReview');
  assert.ok(start >= 0, `${rel}: handleSaveReview not found`);
  const end = src.indexOf('if (data.reviewId)', start);
  assert.ok(end > start, `${rel}: authed branch not found`);
  return src.slice(start, end);
}

// Every page that renders RatingEditor with a real save (the test fixture is a stub).
function ratingEditorPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.tsx$/.test(name)) continue;
      const rel = relative(ROOT, p);
      if (rel.startsWith(join('src', 'app', 'test'))) continue;
      const src = readFileSync(p, 'utf8');
      if (/<RatingEditor\b/.test(src) && /onSave=\{handleSaveReview\}/.test(src)) out.push(rel);
    }
  };
  walk(join(ROOT, 'src'));
  return out.sort();
}

test('every rating page saves signed-out ratings on the device, never as a sign-in draft', () => {
  const pages = ratingEditorPages();
  for (const must of [join('src', 'app', 'diary-show', '[id]', 'DiaryShowClient.tsx'), join('src', 'components', 'show-page', 'ShowHeroRedesign.tsx')]) {
    assert.ok(pages.includes(must), `${must} should render RatingEditor (scan found: ${pages.join(', ')})`);
  }
  for (const rel of pages) {
    const branch = signedOutBranch(rel);
    assert.match(branch, /saveSignedOutRating\(show\.id, data, '[a-z_]+'\)/, `${rel}: signed-out save must use saveSignedOutRating`);
    assert.ok(branch.indexOf('saveSignedOutRating(') < branch.indexOf('showSignIn('), `${rel}: save before offering sign-in`);
    assert.match(branch, /return 'saved-local'/, `${rel}: tell RatingEditor the rating is saved`);
    assert.doesNotMatch(branch, /saveDraft\(data\)|return 'auth-gated'/, `${rel}: no one-hour draft behind the sign-in modal`);
  }
});

test('welcome-sheet import residue stays removed', () => {
  assert.doesNotMatch(read('src/lib/ugc-analytics.ts'), /onboarding_import_source/);
  const metrics = read('scripts/lib/account-metrics.js');
  assert.doesNotMatch(metrics, /onboarding_import_source|n_import_tapped|n_imported|import_tapped/);
  assert.doesNotMatch(read('src/app/admin/accounts/Dashboard.tsx'), /import_tapped|step\.imported/);
  const importShows = read('src/app/my-shows/ImportShows.tsx');
  assert.doesNotMatch(importShows, /'onboarding'/);
  assert.doesNotMatch(importShows, /initialSource|onlySource|initialOpen/);
});
