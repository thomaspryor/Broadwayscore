import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = fs.readFileSync(fileURLToPath(new URL('../supabase/migrations/20261028_diary_photo_limits.sql', import.meta.url)), 'utf8');
const model = fs.readFileSync(fileURLToPath(new URL('../src/lib/review-photo-model.ts', import.meta.url)), 'utf8');

test('migration cap equals the client MAX_PHOTOS_PER_REVIEW', () => {
  const clientMax = Number(/MAX_PHOTOS_PER_REVIEW = (\d+)/.exec(model)[1]);
  const dbMax = Number(/count\(\*\)[^;]*>= (\d+) then/s.exec(sql)[1]);
  assert.equal(dbMax, clientMax);
});

test('before-insert trigger is bound to user_review_photos and serialises per review', () => {
  assert.match(sql, /create trigger user_review_photos_limit\s+before insert on public\.user_review_photos/);
  assert.match(sql, /pg_advisory_xact_lock/);
});

test('diary-photos bucket is limited to JPEG and a size ceiling that fits a 2048px JPEG', () => {
  assert.match(sql, /allowed_mime_types = array\['image\/jpeg'\]/);
  const bytes = Number(/file_size_limit = (\d+)/.exec(sql)[1]);
  assert.ok(bytes >= 5 * 1024 * 1024 && bytes <= 25 * 1024 * 1024, `size limit ${bytes}`);
  assert.match(sql, /where id = 'diary-photos'/);
});
