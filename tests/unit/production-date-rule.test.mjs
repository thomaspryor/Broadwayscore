// BRO-4768: the video-review date rule ("posted before this production's first
// performance -> wrong production") dropped reviews of return engagements whose
// row covers only the return. It now starts at the earliest run of the SAME
// production, recorded as firstRunStart (priorRuns is NOT used: it also holds
// tryouts and other-city runs the rule must still catch). require()s the real helpers
// (CLAUDE.md §15). Show fixtures are real shows.json rows (trimmed); post dates
// are the real dropped videos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  videoPredatesProduction, productionStartMs, productionStartDate, isStaleDateFlag, describeProduction,
} = require('../../scripts/lib/video-production-context.js');

const mexodus = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', venue: 'Daryl Roth Theatre', category: 'off-broadway', previewsStartDate: '2026-03-06', openingDate: '2026-03-10', closingDate: '2026-06-14' };
const smotmc = { id: 'sexual-misconduct-of-the-middle-classes-off-broadway-2026', title: 'Sexual Misconduct of the Middle Classes', venue: 'Audible’s Minetta Lane Theatre', category: 'off-broadway', previewsStartDate: '2026-03-17', openingDate: '2026-03-17', closingDate: '2026-04-30' };
const porch = { id: 'the-porch-on-windy-hill-off-broadway-2026', title: 'The Porch on Windy Hill', venue: 'Urban Stages', category: 'off-broadway', previewsStartDate: null, openingDate: '2026-01-25', closingDate: '2026-03-08' };
const harryPotter = { id: 'harry-potter-2021', title: 'Harry Potter and the Cursed Child', venue: 'Lyric Theatre', category: 'broadway', previewsStartDate: '2018-03-16', openingDate: '2018-04-22', closingDate: null };

const dateFlag = (publishedAt) => ({ publishedAt, wrongProduction: true, productionCheck: { verdict: 'different', method: 'date' } });

test('a video posted before the first performance is still dropped', () => {
  assert.equal(videoPredatesProduction('20251001', mexodus), true);
  assert.equal(videoPredatesProduction('20180214', harryPotter), true);
});

test('firstRunStart earlier than the video keeps it', () => {
  assert.equal(videoPredatesProduction('20251001', { ...mexodus, firstRunStart: '2025-09-09' }), false);
  assert.equal(productionStartDate({ ...mexodus, firstRunStart: '2025-09-09' }), '2025-09-09');
});

test('firstRunStart later than the row start never moves the start forward', () => {
  assert.equal(productionStartDate({ ...mexodus, firstRunStart: '2026-05-01' }), '2026-03-06');
  assert.equal(videoPredatesProduction('20260101', { ...mexodus, firstRunStart: '2026-05-01' }), true);
});

test('mexodus: all three 2025 Minetta Lane videos kept once firstRunStart is recorded', () => {
  const show = { ...mexodus, firstRunStart: '2025-09-09' };
  for (const posted of ['20250911', '20250925', '20251001']) assert.equal(videoPredatesProduction(posted, show), false, posted);
  // still dropped without it
  for (const posted of ['20250911', '20250925', '20251001']) assert.equal(videoPredatesProduction(posted, mexodus), true, posted);
});

test('sexual misconduct: 2025 videos kept with firstRunStart ', () => {
  assert.equal(videoPredatesProduction('20250606', smotmc), true);
  assert.equal(videoPredatesProduction('20250606', { ...smotmc, firstRunStart: '2025-04-28' }), false);
  assert.equal(videoPredatesProduction('20250509', { ...smotmc, firstRunStart: '2025-04-28' }), false);
});

test('porch on windy hill: 2025 Urban Stages video kept (openingDate only, no previews)', () => {
  assert.equal(videoPredatesProduction('20250919', porch), true);
  assert.equal(videoPredatesProduction('20250919', { ...porch, firstRunStart: '2025-09-12' }), false);
});

test('harry potter: the 2018 London review stays dropped', () => {
  assert.equal(videoPredatesProduction('20180214', harryPotter), true);
  assert.equal(isStaleDateFlag(dateFlag('20180214'), harryPotter), false);
});

test('missing or invalid firstRunStart / priorRuns dates are ignored', () => {
  for (const bad of [undefined, null, '', 'TBD', '2025-13-45', '2025-02-30', 'Sept 2025', {}]) {
    assert.equal(videoPredatesProduction('20251001', { ...mexodus, firstRunStart: bad }), true, String(bad));
    assert.equal(productionStartDate({ ...mexodus, firstRunStart: bad }), '2026-03-06', String(bad));
  }
  assert.equal(videoPredatesProduction('20251001', { ...mexodus, priorRuns: [null, {}, { openingDate: 'soon' }] }), true);
  assert.equal(videoPredatesProduction('20251001', { ...mexodus, priorRuns: 'not-an-array' }), true);
  assert.equal(productionStartMs({ title: 'X' }), null);
  assert.equal(videoPredatesProduction('20251001', { title: 'X', firstRunStart: 'nope' }), false);
});

test('firstRunStart alone (no row dates) still drives the rule', () => {
  assert.equal(videoPredatesProduction('20250101', { title: 'X', firstRunStart: '2025-09-09' }), true);
  assert.equal(videoPredatesProduction('20250915', { title: 'X', firstRunStart: '2025-09-09' }), false);
});

test('isStaleDateFlag: only date-method flags the rule no longer supports', () => {
  const show = { ...mexodus, firstRunStart: '2025-09-09' };
  assert.equal(isStaleDateFlag(dateFlag('20251001'), show), true);
  assert.equal(isStaleDateFlag(dateFlag('20251001'), mexodus), false); // rule still holds
  assert.equal(isStaleDateFlag({ ...dateFlag('20251001'), productionCheck: { method: 'llm' } }, show), false);
  assert.equal(isStaleDateFlag({ publishedAt: '20251001', wrongProduction: true }, show), false); // flagged elsewhere
  assert.equal(isStaleDateFlag({ ...dateFlag('20251001'), wrongProduction: false }, show), false);
  assert.equal(isStaleDateFlag(null, show), false);
});

test('describeProduction tells the model about the earlier run of the same production', () => {
  assert.match(describeProduction({ ...mexodus, firstRunStart: '2025-09-09' }), /same production first played from 2025-09-09/);
  assert.doesNotMatch(describeProduction(mexodus), /same production/);
  assert.doesNotMatch(describeProduction({ ...mexodus, firstRunStart: '2026-05-01' }), /same production/);
});

test('firstRunStartValueProblem: the plan/validate-data guard for the field', () => {
  const { firstRunStartValueProblem, FEEDBACK_EDITABLE_FIELDS } = require('../../scripts/lib/feedback-pipeline-fields.js');
  assert.ok(FEEDBACK_EDITABLE_FIELDS['shows.json'].includes('firstRunStart'));
  const today = '2026-10-16';
  assert.equal(firstRunStartValueProblem('2025-09-09', mexodus, today), null);
  assert.equal(firstRunStartValueProblem('2025-09-12', porch, today), null); // openingDate only
  assert.equal(firstRunStartValueProblem(null, mexodus, today), null);
  assert.match(firstRunStartValueProblem('2026-03-06', mexodus, today), /must be before/); // not earlier than own start
  assert.match(firstRunStartValueProblem('2025-02-30', mexodus, today), /real YYYY-MM-DD/);
  assert.match(firstRunStartValueProblem('20250909', mexodus, today), /real YYYY-MM-DD/);
  assert.match(firstRunStartValueProblem('2025-09-09', { title: 'X' }, today), /no previewsStartDate/);
  assert.match(firstRunStartValueProblem('2027-01-01', { openingDate: '2028-01-01' }, today), /future/);
});

test('priorRuns never moves the start (tryouts and other-city runs stay caught)', () => {
  const withPrior = { ...mexodus, priorRuns: [{ openingDate: '2025-09-18', venue: 'Edinburgh Fringe' }, { id: 'x', openingDate: '2024-01-01' }] };
  assert.equal(productionStartDate(withPrior), '2026-03-06');
  assert.equal(videoPredatesProduction('20251001', withPrior), true);
});
