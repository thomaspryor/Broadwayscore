import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { classify, audit, DEFAULT_REASON } = createRequire(import.meta.url)('./audit-stale-review-texts.js');

const body = (t) => `${t} `.repeat(200);

test('classify: OK when body names the show, SUSPECT when not, NO-BODY when empty', () => {
  assert.equal(classify({ fullText: body('Dracula is bold') }, 'Dracula').verdict, 'OK');
  assert.equal(classify({ fullText: body('Paddington is lovely') }, 'Moulin Rouge! The Musical').verdict, 'SUSPECT');
  assert.equal(classify({ fullText: '' }, 'Dracula').verdict, 'NO-BODY');
});

test('audit: finds only files carrying the stale reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2395-'));
  fs.mkdirSync(path.join(dir, 'show-a'));
  const w = (n, o) => fs.writeFileSync(path.join(dir, 'show-a', n), JSON.stringify(o));
  w('a.json', { showId: 'show-a', fullText: body('Dracula'), wrongProductionManualClear: DEFAULT_REASON });
  w('b.json', { showId: 'show-a', fullText: body('Dracula'), wrongProductionManualClear: 'other' });
  const rows = audit({ dir, reason: DEFAULT_REASON, field: 'wrongProductionManualClear', titles: new Map([['show-a', 'Dracula']]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'OK');
});

test('classify: word boundary, "cats" must not match "indicates"', () => {
  assert.equal(classify({ fullText: body('this indicates things') }, 'Cats').verdict, 'SUSPECT');
});
