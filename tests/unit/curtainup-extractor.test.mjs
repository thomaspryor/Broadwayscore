// BRO-6761: curtainup.com table-layout pages returned 0 chars from every generic pattern.
import { test } from 'node:test';
import assert from 'node:assert';
import { extractArticleText, extractCurtainUpBody } from '../../scripts/lib/article-extractor.js';

const para = (n) => `Synthetic review paragraph ${n} about the staging, the performances and the design, long enough to count as prose.`;
const PAGE = `<html><body><table><tr><td class=yellow><a href="index.html">HOME PAGE</a></td><td>
<table class="pic" align="left"><tr><td><img src="x.jpg"><div>Caption text</div></td></tr></table>
${[1, 2, 3, 4].map(para).join('\n\n')}
<table class = credit border="0"><tr><td bgcolor="#CCCCCC">Show Title<br>Directed by Someone<br>Reviewed by Critic Name based on press performance.</td></tr></table>
</td></tr></table></body></html>`;

test('extracts the review between the photo table and the credit table', () => {
  const t = extractCurtainUpBody(PAGE);
  assert.ok(t.includes('Synthetic review paragraph 1') && t.includes('paragraph 4'));
  assert.ok(!/HOME PAGE|Caption text|Directed by|Reviewed by/.test(t), t);
});

test('extractArticleText dispatches curtainup.com URLs to it', () => {
  const t = extractArticleText(PAGE, 'http://www.curtainup.com/showname15.html');
  assert.ok(t && t.includes('paragraph 2') && !/HOME PAGE/.test(t));
});

test('no credit table or a stub body fails loud (null)', () => {
  assert.equal(extractCurtainUpBody('<html><body><table></table>short</body></html>'), null);
  assert.equal(extractCurtainUpBody(PAGE.replace(/Synthetic review paragraph [1-4][^\n]*/g, 'x')), null);
});

test('credit table with several class tokens still anchors', () => {
  const t = extractCurtainUpBody(PAGE.replace('class = credit', 'class="box credit"'));
  assert.ok(t && t.includes('paragraph 3'));
});
