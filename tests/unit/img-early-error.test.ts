/**
 * An <img> that fails before React hydrates never reaches its onError, so the
 * fallback never shows (BRO-4616: broken outlet logos). Locks the detection
 * rule and requires every <img> with an onError fallback to also carry
 * catchEarlyImgError.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isFailedImage, catchEarlyImgError } from '../../src/lib/img-early-error';

const img = (complete: boolean, naturalWidth: number, src: string | null) =>
  ({ complete, naturalWidth, getAttribute: () => src }) as unknown as HTMLImageElement;

test('a finished load with no pixels is a failure', () => {
  assert.equal(isFailedImage(img(true, 0, 'https://x/logo.png')), true);
});

test('a loaded image, a pending load, or a missing src is not a failure', () => {
  assert.equal(isFailedImage(img(true, 64, 'https://x/logo.png')), false);
  assert.equal(isFailedImage(img(false, 0, 'https://x/logo.png')), false);
  assert.equal(isFailedImage(img(true, 0, null)), false);
});

test('the ref callback fires the fallback only for a failed image', () => {
  let calls = 0;
  const ref = catchEarlyImgError(() => { calls++; });
  ref(null);
  ref(img(true, 64, 'a'));
  assert.equal(calls, 0);
  ref(img(true, 0, 'a'));
  assert.equal(calls, 1);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every <img> with an onError fallback also catches pre-hydration errors', () => {
  const missing: string[] = [];
  for (const file of walk(join(__dirname, '../../src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of Array.from(src.matchAll(/<img\b(?:(?!<img\b|\/>)[\s\S]){0,800}?onError=/g))) {
      if (!m[0].includes('catchEarlyImgError')) missing.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, [], `add ref={catchEarlyImgError(...)} next to onError on: ${missing.join(', ')}`);
});
