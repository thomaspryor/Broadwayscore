import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideByline, isUnnamed } = require('./fix-printed-bylines.js');

const SL = 'To the Old Vic for ninety minutes of quality theatre. The Old Vic never disappoints, writes Lizzie Paul. I knew this would be something special.';

test('a stored staff-account name is overridden by the printed credit', () => {
  const d = { criticName: 'Michael Holland', fullText: SL, url: 'https://southlondon.co.uk/area/southwark/review-martin-guerre-old-vic/' };
  assert.deepEqual(decideByline('south-london', d, null), { kind: 'override', name: 'Lizzie Paul' });
});

test('an Unknown or junk-named file takes the credit through the guarded fill path', () => {
  assert.deepEqual(decideByline('south-london', { criticName: 'Unknown', fullText: SL, url: 'u' }, null), { kind: 'fill', name: 'Lizzie Paul' });
  assert.deepEqual(decideByline('all-that-dazzles-uk', { criticName: 'Sam - Admin', fullText: 'Review by Daz Gale ⭐⭐⭐⭐ Opening', url: 'u' }, null), { kind: 'fill', name: 'Daz Gale' });
  assert.equal(isUnnamed('Unknown'), true);
  assert.equal(isUnnamed('Lizzie Paul'), false);
});

test('fill-only outlets never replace a real stored name', () => {
  const d = { criticName: 'Adam Feldman', fullText: 'Reviewed. Written by David CoteTheater Editor, Time Out', url: 'u' };
  assert.equal(decideByline('timeout', d, null), null);
  assert.deepEqual(decideByline('timeout', { ...d, criticName: 'Unknown' }, null), { kind: 'fill', name: 'David Cote' });
});

test('flagged, duplicate, manual and locked files are left alone', () => {
  for (const flag of [{ wrongProduction: true }, { duplicateOf: 'x.json' }, { criticNameManual: true }, { _locked: true }]) {
    assert.equal(decideByline('south-london', { criticName: 'Michael Holland', fullText: SL, url: 'u', ...flag }, null), null);
  }
});

test('page-only outlets use the fetched HTML, never the stored text', () => {
  const page = '<h4>Reviewed on 20th October 2026</h4><h4>by Jonathan Evans</h4>';
  const d = { criticName: 'Unknown', fullText: 'They say that a musical is never truly finished.', url: 'https://thespyinthestalls.com/2026/10/martin-guerre/' };
  assert.equal(decideByline('the-spy-in-the-stalls', d, null), null);
  assert.deepEqual(decideByline('the-spy-in-the-stalls', d, page), { kind: 'page', name: 'Jonathan Evans' });
});
