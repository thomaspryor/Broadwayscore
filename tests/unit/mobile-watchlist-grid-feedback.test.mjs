/**
 * BRO-3175: setting a planned date on a My Shows watchlist card closed the
 * picker with no confirmation, so users could not tell the date was saved.
 * handlePlannedDateChange now toasts on success (and still toasts on error).
 * Source guard in the style of watchlist-grid-remove-affordance.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(ROOT, 'src/app/my-shows/MyShowsClient.tsx'), 'utf8');

function handlerBody(name) {
  const start = SOURCE.indexOf(`const ${name} = useCallback(`);
  assert.ok(start !== -1, `${name} not found in MyShowsClient.tsx`);
  const end = SOURCE.indexOf('}, [', start);
  assert.ok(end !== -1, `could not find the end of ${name}`);
  return SOURCE.slice(start, end);
}

test('saving or clearing a planned date confirms with a success toast', () => {
  const body = handlerBody('handlePlannedDateChange');
  const tryBlock = body.slice(body.indexOf('try {'), body.indexOf('} catch'));
  assert.match(tryBlock, /await effectiveUpdatePlannedDate\(showId, date\)/);
  assert.match(tryBlock, /showToast\?\.\([^)]*'Date saved\.'[^)]*'success'\)/, 'success path must toast "Date saved."');
  assert.match(tryBlock, /'Date cleared\.'/, 'clearing a date must also confirm');
  // The toast must come after the awaited write, so a failed write never
  // reports success.
  assert.ok(tryBlock.indexOf('effectiveUpdatePlannedDate') < tryBlock.indexOf('Date saved.'));
});

test('a failed date write still reports an error', () => {
  const body = handlerBody('handlePlannedDateChange');
  const catchBlock = body.slice(body.indexOf('} catch'));
  assert.match(catchBlock, /showToast\?\.\('Failed to save date\.', 'error'\)/);
});
