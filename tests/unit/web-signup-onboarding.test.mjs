/**
 * BRO-6917 (Option A) web sign-up onboarding. Locks the three behaviours the
 * card's acceptance names, against the real modules (no copied logic):
 *   1. rating migration: signed-out ratings are copied into the account on sign-in
 *   2. bookmark prompt: quiet on saves 1 and 2, the sign-in sheet on the 3rd
 *   3. quiz presentation: only Sign in button sign-ups see it, side panel on
 *      desktop / full screen on phone, every step skippable, no import step
 * plus the Want grid picker and the Google One Tap gate (Part 5).
 *
 * Run: node --test tests/unit/web-signup-onboarding.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUIZ_SOURCES,
  QUIZ_STEPS,
  QUIZ_SIDE_PANEL_MIN_WIDTH,
  SIGNUP_SOURCE_KEY,
  SIGNUP_SOURCE_TTL_MS,
  ONE_TAP_SOURCE,
  isQuizSource,
  recordSignUpSource,
  signUpSourceFor,
  clearSignUpSource,
  signupOnboardingFor,
  quizLayoutFor,
  nextQuizStep,
  quizStepNumber,
  wantCandidates,
  quizDoneMessage,
  pickWantShows,
  shouldShowOneTap,
} from '../../src/lib/web-signup-onboarding.ts';
import { ratingsToMigrate, upsertRating, parseLocalRatings } from '../../src/lib/local-ratings.ts';
import { PROMPT_AT_COUNT, PROMPT_COOLDOWN_MS, shouldPromptAfterSave, showsToMigrate } from '../../src/lib/local-watchlist.ts';
import { isMidFlowContext } from '../../src/lib/signin-intent.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = p => readFileSync(ROOT + p, 'utf8');

function memStore() {
  const data = {};
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: k => { delete data[k]; },
  };
}
const NOW = Date.UTC(2026, 10, 11, 12);

// ─── 1. Rating migration ────────────────────────────────────────────────

test('rating migration: every signed-out rating is copied, oldest first', () => {
  let list = [];
  list = upsertRating(list, { showId: 'hamilton', rating: 4.5 }, NOW - 3000);
  list = upsertRating(list, { showId: 'wicked', rating: 3 }, NOW - 2000);
  list = upsertRating(list, { showId: 'chicago', rating: 5 }, NOW - 1000);
  assert.deepEqual(ratingsToMigrate(list, []).map(r => r.showId), ['hamilton', 'wicked', 'chicago']);
});

test('rating migration: a retry skips only the identical rating; a different one is a new viewing', () => {
  let list = [];
  list = upsertRating(list, { showId: 'hamilton', rating: 4.5 }, NOW - 2000);
  list = upsertRating(list, { showId: 'wicked', rating: 3 }, NOW - 1000);
  const account = [{ showId: 'hamilton', rating: 4.5 }, { showId: 'wicked', rating: 4 }];
  assert.deepEqual(ratingsToMigrate(list, account).map(r => `${r.showId}:${r.rating}`), ['wicked:3']);
});

test('rating migration: rating the same show twice while signed out keeps the latest only', () => {
  let list = upsertRating([], { showId: 'hamilton', rating: 2 }, NOW - 2000);
  list = upsertRating(list, { showId: 'hamilton', rating: 4 }, NOW - 1000);
  assert.deepEqual(ratingsToMigrate(list, []).map(r => r.rating), [4]);
});

test('rating migration: corrupt or invalid storage migrates nothing rather than throwing', () => {
  assert.deepEqual(parseLocalRatings('{not json'), []);
  assert.deepEqual(parseLocalRatings(JSON.stringify([{ showId: 'x', rating: 9 }])), []);
  assert.deepEqual(upsertRating([], { showId: 'x', rating: 0 }, NOW), []);
});

test('bookmark migration: only shows the account does not have yet', () => {
  const local = [{ showId: 'b', addedAt: 2 }, { showId: 'a', addedAt: 1 }];
  assert.deepEqual(showsToMigrate(local, ['a']), ['b']);
});

// ─── 2. Bookmark prompt count ───────────────────────────────────────────

test('bookmark prompt: quiet on saves 1 and 2, the sign-in sheet on the 3rd', () => {
  assert.equal(PROMPT_AT_COUNT, 3);
  assert.equal(shouldPromptAfterSave(1, null, NOW), false);
  assert.equal(shouldPromptAfterSave(2, null, NOW), false);
  assert.equal(shouldPromptAfterSave(3, null, NOW), true);
  assert.equal(shouldPromptAfterSave(4, null, NOW), true);
});

test('bookmark prompt: not again within the cooldown, again after it', () => {
  assert.equal(shouldPromptAfterSave(5, NOW - 1000, NOW), false);
  assert.equal(shouldPromptAfterSave(5, NOW - PROMPT_COOLDOWN_MS - 1, NOW), true);
});

// ─── 3. Quiz presentation: who sees it ──────────────────────────────────

test('who: header, menu and My Shows sign-in buttons get the quiz; nothing else does', () => {
  assert.deepEqual([...QUIZ_SOURCES].sort(), ['header', 'menu', 'my_shows']);
  for (const s of QUIZ_SOURCES) {
    assert.equal(signupOnboardingFor({ owedWelcome: true, source: s }), 'quiz', s);
  }
  for (const s of ['show_rating_save', 'show_rate_link', 'watchlist_saved', 'watchlist_toast', 'diary',
    'footer_account_box', 'money_gate:biz', ONE_TAP_SOURCE, 'unknown', '', null]) {
    assert.equal(signupOnboardingFor({ owedWelcome: true, source: s }), 'quiet', String(s));
  }
});

test('who: mid-flow sign-in contexts never come from a quiz source', () => {
  // The rating and bookmark prompts pass these contexts with their own sources.
  for (const c of ['rating', 'watchlist', 'watchlist_local']) assert.equal(isMidFlowContext(c), true);
  for (const s of ['show_rating_save', 'show_rate_link', 'watchlist_saved', 'watchlist_toast']) assert.equal(isQuizSource(s), false);
});

test('who: an account not owed a welcome (older, or already seen) gets nothing', () => {
  assert.equal(signupOnboardingFor({ owedWelcome: false, source: 'header' }), 'none');
  assert.equal(signupOnboardingFor({ owedWelcome: false, source: 'show_rating_save' }), 'none');
});

test('source marker: survives the Google redirect and is tied to the account that finishes', () => {
  const store = memStore();
  recordSignUpSource('header', NOW, store);
  assert.equal(signUpSourceFor('u1', NOW + 5000, store), 'header');
  assert.equal(JSON.parse(store.data[SIGNUP_SOURCE_KEY]).userId, 'u1');
  // Later page loads (past the TTL) still know it for this account...
  assert.equal(signUpSourceFor('u1', NOW + SIGNUP_SOURCE_TTL_MS * 4, store), 'header');
  // ...but another account on this device never inherits it.
  assert.equal(signUpSourceFor('u2', NOW + 6000, store), null);
});

test('source marker: stale, missing, corrupt or blocked storage means quiet', () => {
  const store = memStore();
  recordSignUpSource('menu', NOW, store);
  assert.equal(signUpSourceFor('u1', NOW + SIGNUP_SOURCE_TTL_MS + 1, store), null);
  assert.equal(signUpSourceFor('u1', NOW, memStore()), null);
  const bad = memStore();
  bad.data[SIGNUP_SOURCE_KEY] = '{oops';
  assert.equal(signUpSourceFor('u1', NOW, bad), null);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => recordSignUpSource('header', NOW, throwing));
  assert.equal(signUpSourceFor('u1', NOW, throwing), null);
  assert.doesNotThrow(() => clearSignUpSource(throwing));
  assert.equal(signUpSourceFor('u1', NOW, null), null);
});

test('source marker: a later mid-flow sign-in replaces an abandoned header one', () => {
  const store = memStore();
  recordSignUpSource('header', NOW, store);
  recordSignUpSource('show_rating_save', NOW + 1000, store);
  const src = signUpSourceFor('u1', NOW + 2000, store);
  assert.equal(signupOnboardingFor({ owedWelcome: true, source: src }), 'quiet');
  clearSignUpSource(store);
  assert.equal(store.data[SIGNUP_SOURCE_KEY], undefined);
});

// ─── 3. Quiz presentation: desktop vs phone ─────────────────────────────

test('layout: side panel on desktop, full screen on phone and tablet', () => {
  assert.equal(QUIZ_SIDE_PANEL_MIN_WIDTH, 1024);
  assert.equal(quizLayoutFor(1440), 'side-panel');
  assert.equal(quizLayoutFor(1024), 'side-panel');
  assert.equal(quizLayoutFor(1023), 'full-screen');
  assert.equal(quizLayoutFor(390), 'full-screen');
  assert.equal(quizLayoutFor(null), 'full-screen');
});

// ─── 3. Quiz presentation: steps and skip ───────────────────────────────

test('steps: Seen then Want then done; no import step', () => {
  assert.deepEqual([...QUIZ_STEPS], ['shows', 'want', 'done']);
  assert.equal(QUIZ_STEPS.includes('import'), false);
  assert.equal(nextQuizStep('shows', 'continue'), 'want');
  assert.equal(nextQuizStep('want', 'continue'), 'done');
  assert.equal(nextQuizStep('done', 'continue'), 'closed');
  assert.deepEqual(QUIZ_STEPS.map(quizStepNumber), [1, 2, 3]);
});

test('skip: every step can be skipped or closed', () => {
  assert.equal(nextQuizStep('shows', 'skip'), 'want');
  assert.equal(nextQuizStep('want', 'skip'), 'done');
  for (const s of QUIZ_STEPS) assert.equal(nextQuizStep(s, 'close'), 'closed', s);
});

test('want grid: leaves out shows already seen, just picked as seen, or on the watchlist', () => {
  const shows = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  assert.deepEqual(wantCandidates(shows, { seen: ['a'], watchlist: new Set(['c']) }).map(s => s.id), ['b', 'd']);
});

test('done message counts both grids and names the unrated ones', () => {
  assert.equal(quizDoneMessage({ seenAdded: 0, unratedAdded: 0, wantAdded: 0 }), 'Rate a show from its page any time, and it lands in Seen.');
  assert.equal(quizDoneMessage({ seenAdded: 2, unratedAdded: 0, wantAdded: 3 }), '2 shows in Seen and 3 in Want to See.');
  assert.equal(quizDoneMessage({ seenAdded: 1, unratedAdded: 0, wantAdded: 0 }), '1 show in Seen.');
  assert.equal(quizDoneMessage({ seenAdded: 0, unratedAdded: 0, wantAdded: 1 }), '1 in Want to See.');
  assert.match(quizDoneMessage({ seenAdded: 3, unratedAdded: 2, wantAdded: 0 }), /The 2 without stars wait under To Be Rated/);
  assert.match(quizDoneMessage({ seenAdded: 1, unratedAdded: 5, wantAdded: 0 }), /The one without stars waits/);
});

test('want picker: open and preview shows with posters, most reviewed first, one per title', () => {
  const base = { category: 'broadway', images: { poster: 'p.jpg' }, openingDate: '2024-01-01' };
  const shows = [
    { ...base, id: 'big', title: 'Big', slug: 'big', status: 'open', reviewCount: 90 },
    { ...base, id: 'small', title: 'Small', slug: 'small', status: 'open', reviewCount: 10 },
    { ...base, id: 'prev', title: 'Prev', slug: 'prev', status: 'previews', reviewCount: 0, openingDate: '2026-12-01' },
    { ...base, id: 'shut', title: 'Shut', slug: 'shut', status: 'closed', reviewCount: 99 },
    { ...base, id: 'gone', title: 'Gone', slug: 'gone', status: 'open', reviewCount: 80, closingDate: '2026-01-01' },
    { ...base, id: 'noimg', title: 'No Img', slug: 'noimg', status: 'open', reviewCount: 70, images: {} },
    { ...base, id: 'big-2', title: 'BIG', slug: 'big-2', status: 'open', reviewCount: 5 },
    { ...base, id: 'london', title: 'London', slug: 'london', status: 'open', reviewCount: 50, category: 'west-end' },
  ];
  assert.deepEqual(pickWantShows(shows, '2026-11-11').map(s => s.id), ['big', 'small', 'prev']);
  assert.deepEqual(pickWantShows(shows, '2026-11-11', { category: 'west-end' }).map(s => s.id), ['london']);
  assert.equal(pickWantShows(shows, '2026-11-11', { count: 1 }).length, 1);
});

// ─── Google One Tap gate (Part 5) ───────────────────────────────────────

test('one tap: dormant without a client id; desktop, signed-out, mouse only', () => {
  const ok = { clientId: 'abc.apps.googleusercontent.com', signedIn: false, authLoading: false, pathname: '/', viewportWidth: 1440, finePointer: true };
  assert.equal(shouldShowOneTap(ok), true);
  assert.equal(shouldShowOneTap({ ...ok, clientId: undefined }), false);
  assert.equal(shouldShowOneTap({ ...ok, clientId: '  ' }), false);
  assert.equal(shouldShowOneTap({ ...ok, signedIn: true }), false);
  assert.equal(shouldShowOneTap({ ...ok, authLoading: true }), false);
  assert.equal(shouldShowOneTap({ ...ok, pathname: '/auth/callback' }), false);
  assert.equal(shouldShowOneTap({ ...ok, viewportWidth: 390 }), false);
  assert.equal(shouldShowOneTap({ ...ok, finePointer: false }), false);
  assert.equal(isQuizSource(ONE_TAP_SOURCE), false);
});

// ─── Wiring (the pure decisions are actually used) ──────────────────────

test('wiring: sign-in records its source; the gate and sheet use the decisions', () => {
  const auth = read('src/contexts/AuthContext.tsx');
  assert.equal((auth.match(/recordSignUpSource\(source\)/g) || []).length, 2, 'Google/Apple and email both record the source');
  const gate = read('src/components/onboarding/WelcomeGate.tsx');
  assert.match(gate, /signupOnboardingFor\(/);
  assert.match(gate, /decide\(userId\) !== 'quiz'/, 'the sheet only opens for the quiz decision');
  const sheet = read('src/components/onboarding/WelcomeSheet.tsx');
  assert.match(sheet, /quizLayoutFor\(/);
  assert.match(sheet, /layout=\{layout\}/);
  assert.doesNotMatch(sheet, /ImportShows/, 'import step dropped');
  const route = read('src/app/welcome-shows.json/route.ts');
  assert.match(route, /pickWantShows\(/);
  const oneTap = read('src/components/auth/GoogleOneTap.tsx');
  assert.match(oneTap, /NEXT_PUBLIC_GOOGLE_CLIENT_ID/);
  assert.match(oneTap, /shouldShowOneTap\(/);
  assert.match(read('src/components/UserProviders.tsx'), /<GoogleOneTap \/>/);
});
