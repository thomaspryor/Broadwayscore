// BRO-7077 (BRO-5305): a London Theatre Reviews article misfiled under london-theatre
// ends with LTR's "Review: <name> Photos ..." credit. Naming the critic there would
// score an LTR review under London Theatre. Requires the real extractor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractBylineFromText, tailCreditBelongsToSibling } = require('../../scripts/lib/byline-from-text.js');

const body = 'The play is tender and long. '.repeat(20);
const ltrCredit = body + 'Review: Jack Shaw Photos: Harry Elletson';

test('LTR tail credit under london-theatre stays Unknown', () => {
  assert.equal(extractBylineFromText('london-theatre', ltrCredit, { showTitle: 'The Heart Wall' }), null);
  assert.equal(tailCreditBelongsToSibling('london-theatre', ltrCredit), true);
});

test('LTR itself and other credit formats still fill', () => {
  assert.deepEqual(extractBylineFromText('london-theatre-reviews', ltrCredit, { showTitle: 'The Heart Wall' }), { name: 'Jack Shaw', known: true });
  assert.deepEqual(extractBylineFromText('london-theatre', body + 'Reviewed by Jack Shaw', { showTitle: 'X' }), { name: 'Jack Shaw', known: true });
  assert.deepEqual(extractBylineFromText('british-theatre', body + 'Reviewer: Vera Liber', { showTitle: 'X' }), { name: 'Vera Liber', known: true });
  assert.equal(tailCreditBelongsToSibling('the-stage', ltrCredit), false, 'only the name-alike sibling is guarded');
});
