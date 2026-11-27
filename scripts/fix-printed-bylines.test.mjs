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

// BRO-8212: Islington Tribune prints "<date> — By <critic> <photo caption>"; sierz.co.uk is one critic's own site.
const IT = 'Toby Stephens plays a teacher Thursday, 10th October 2019 — By Catherine Usher Toby Stephens in A Day in the Death of Joe Egg WITH a cast';
test('Islington Tribune: a known critic in the dateline names an Unknown file, with or without a year', () => {
  assert.deepEqual(decideByline('islingtontribune', { criticName: 'Unknown', fullText: IT, url: 'u' }, null), { kind: 'fill', name: 'Catherine Usher' });
  assert.deepEqual(decideByline('islingtontribune', { criticName: 'Unknown', fullText: 'Plenty to admire\n\nThursday, 4th June — By Lucy Popescu\n\nDavid Hunter in Beetlejuice', url: 'u' }, null), { kind: 'fill', name: 'Lucy Popescu' });
});
test('Islington Tribune: an unlisted name or a missing dateline stays Unknown, and a real stored name is kept', () => {
  assert.equal(decideByline('islingtontribune', { criticName: 'Unknown', fullText: 'x 2019 — By Nobody Known here', url: 'u' }, null), null);
  assert.equal(decideByline('islingtontribune', { criticName: 'Unknown', fullText: 'A review with no byline line at all.', url: 'u' }, null), null);
  assert.equal(decideByline('islingtontribune', { criticName: 'Lucy Popescu', fullText: IT, url: 'u' }, null), null);
});
test('sierz.co.uk: every non-empty text is Aleks Sierz; an empty stub stays Unknown', () => {
  const body = 'A review of the play. '.repeat(30);
  assert.deepEqual(decideByline('sierz-co-uk', { criticName: 'Unknown', fullText: body, url: 'u' }, null), { kind: 'fill', name: 'Aleks Sierz' });
  assert.equal(decideByline('sierz-co-uk', { criticName: 'Unknown', fullText: '', url: 'u' }, null), null);
});
test('a self-branded outlet\'s own defaultCritic is not refused as an outlet name (Sierz), other outlet names still are', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { applyPageByline } = require('./lib/review-file-writer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8212-')); const show = path.join(dir, 'a-show-west-end-2019'); fs.mkdirSync(show);
  const f = path.join(show, 'sierz-co-uk--unknown.json');
  const rec = { showId: 'a-show-west-end-2019', outletId: 'sierz-co-uk', outlet: 'Aleks Sierz', criticName: 'Unknown', url: 'https://sierz.co.uk/x', fullText: 'x'.repeat(400) };
  fs.writeFileSync(f, JSON.stringify(rec));
  const ok = applyPageByline(f, rec, { showId: 'a-show-west-end-2019', criticName: 'Aleks Sierz', source: 'printed-text', dryRun: true });
  assert.equal(ok.applied, true, JSON.stringify(ok));
  const bad = applyPageByline(f, rec, { showId: 'a-show-west-end-2019', criticName: 'Islington Tribune', source: 'printed-text', dryRun: true });
  assert.deepEqual([bad.applied, bad.reason], [false, 'outlet-name']);
  fs.rmSync(dir, { recursive: true, force: true });
});
