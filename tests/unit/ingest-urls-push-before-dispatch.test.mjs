// BRO-5890: ingest-urls.yml run 39714821272 dispatched scoring + rebuild
// 50s before its review files reached the private repo. The script's own push
// failed ("Author identity unknown") and it dispatched anyway. Pins the three
// pieces of the fix in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('ingest-urls.js does not dispatch downstream after a failed push', () => {
  const src = read('scripts/ingest-urls.js');
  assert.match(src, /if \(!push\.pushed\) \{[\s\S]*?pushFailed = true;/);
  assert.match(src, /if \(newReviews > 0 && !noRebuild && !dryRun && !pushFailed\) \{/);
});

test('ingest-urls.yml pushes a committed-but-unpushed review-texts HEAD', () => {
  const yml = read('.github/workflows/ingest-urls.yml');
  assert.match(yml, /AHEAD=\$\(git rev-list --count origin\/main\.\.HEAD/);
  assert.match(yml, /\[ "\$AHEAD" = "0" \]/);
});

test('ingest-urls.yml dispatches scoring after pushing a commit the script could not push', () => {
  const yml = read('.github/workflows/ingest-urls.yml');
  const src = read('scripts/ingest-urls.js');
  assert.match(src, /fs\.writeFileSync\(process\.env\.INGEST_DISPATCH_MARKER, String\(newReviews\)\)/);
  assert.equal((yml.match(/INGEST_DISPATCH_MARKER: \$\{\{ runner\.temp \}\}\/ingest-dispatch-pending/g) || []).length, 2);
  assert.match(yml, /if \[ -f "\$INGEST_DISPATCH_MARKER" \]; then[\s\S]*?dispatchDownstream\(/);
});

test('checkout-review-texts sets a git identity inside the clone when unset', () => {
  const action = read('.github/actions/checkout-review-texts/action.yml');
  assert.match(action, /git -C data\/review-texts config user\.name >\/dev\/null \|\| git -C data\/review-texts config user\.name /);
  assert.match(action, /git -C data\/review-texts config user\.email >\/dev\/null \|\| git -C data\/review-texts config user\.email /);
});
