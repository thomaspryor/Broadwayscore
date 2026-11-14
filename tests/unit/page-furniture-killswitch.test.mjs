// BRO-7171 Stage 5 follow-up: PAGE_FURNITURE_DISABLED (and the older
// TRAILER_FIXES_DISABLED) turns off EVERY Stage 5 extraction change, not only
// stripPageFurniture: the paragraph-keeping HTML strip and The Stage's
// author-card cut fall back to their pre-Stage-5 behaviour.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractArticleText, stripHtmlKeepParagraphs } = require('../../scripts/lib/article-extractor.js');

const SWITCHES = ['PAGE_FURNITURE_DISABLED', 'TRAILER_FIXES_DISABLED'];
afterEach(() => { for (const k of SWITCHES) delete process.env[k]; });

const para = (n) => `<p>Paragraph ${n} of the review body runs long enough to count as real prose for the extractor, with a closing full stop.</p>`;
// The Stage's logged-in article shape: intro div, body paragraphs, then the
// author card whose biography has no article before "editor".
const STAGE_HTML = `<html><body><div class="aos-Article-IntroText">${para(1)}</div>
<div class="aos-DS32-WYSEdit">${para(2)}${para(3)}${para(4)}</div>
<div class="aos-ContactJobTitle">Reviews editor</div>
<div class="aos-ContactBiog"><p>Pat Example is reviews editor for The Stage and has written about theatre for many years.</p></div>
</body></html>`;

test('Stage author card is cut while the switch is on', () => {
  const t = extractArticleText(STAGE_HTML, 'thestage.co.uk');
  assert.ok(t && t.includes('Paragraph 4'), 'body kept');
  assert.ok(!/reviews editor for The Stage/.test(t), 'author card removed');
});

for (const sw of SWITCHES) {
  test(`${sw}=true restores the pre-Stage-5 Stage body (author card kept)`, () => {
    process.env[sw] = 'true';
    const t = extractArticleText(STAGE_HTML, 'thestage.co.uk');
    assert.ok(t && /reviews editor for The Stage/.test(t), 'card cut is off under the switch');
  });

  test(`${sw}=true makes stripHtmlKeepParagraphs the single-line stripHtml`, () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    assert.strictEqual(stripHtmlKeepParagraphs(html), 'First paragraph.\n\nSecond paragraph.');
    process.env[sw] = 'true';
    assert.strictEqual(stripHtmlKeepParagraphs(html), 'First paragraph. Second paragraph.');
  });
}
