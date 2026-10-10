// The privacy page promises session replays hide the text on My Shows and
// diary pages, the signed-in name in the menu, and saved notes on show
// pages. The recorder hides any element carrying its default `ph-mask`
// class (and everything inside it), so each of those spots must keep it.
// Without this, a markup refactor would quietly drop the class and the
// privacy copy would stop being true (BRO-4525).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MASKED = [
  // [file, a fragment that must sit on a ph-mask element, what it hides]
  ['src/app/my-shows/MyShowsClient.tsx', 'data-testid="my-shows-content" className="ph-mask', 'the signed-in My Shows page'],
  ['src/app/diary-show/[id]/DiaryShowClient.tsx', 'className="ph-mask max-w-2xl', 'the diary page'],
  ['src/components/HamburgerMenu.tsx', 'className="ph-mask text-sm font-semibold text-white truncate">{profile?.display_name || email', 'the menu name/email'],
  ['src/components/show-page/ShowHeroRedesign.tsx', 'className="ph-mask text-sm text-gray-400 italic', 'saved notes on show pages'],
  ['src/app/unsubscribe/UnsubscribeClient.tsx', 'className="ph-mask text-gray-500 text-sm mb-8">', 'the unsubscribe email'],
];

for (const [file, fragment, what] of MASKED) {
  test(`replays hide ${what}`, () => {
    assert.ok(read(file).includes(fragment), `${file} lost its ph-mask class (privacy page promises replays hide ${what})`);
  });
}

test('the recorder keeps its default mask class', () => {
  const src = read('src/components/AnalyticsWrapper.tsx');
  assert.ok(!/maskTextClass\s*:/.test(src), 'AnalyticsWrapper overrides maskTextClass; the ph-mask markup would stop working');
});
