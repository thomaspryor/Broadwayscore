import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/app/diary-show/[id]/DiaryShowClient.tsx', 'utf8');

test('diary ratings save locally before the sign-in prompt', () => {
  const save = source.split('const handleSaveReview =')[1].split('if (data.reviewId)')[0];
  assert.match(save, /saveLocalRating\(/);
  assert.match(save, /removeLocalShow\(show\.id\)/);
  assert.ok(save.indexOf('saveLocalRating(') < save.indexOf('showSignIn('));
  assert.match(save, /return 'saved-local'/);
  assert.doesNotMatch(save, /saveDraft\(data\)/);
});

test('signed-out rate links open the editor without requiring sign-in', () => {
  const effect = source.split('// ?rate=1 / ?edit=1')[1].split('const handleSaveReview =')[0];
  assert.doesNotMatch(effect, /showSignIn\(/);
  assert.match(effect, /wantsEdit && isAuthenticated && !reviewsSynced/);
});
