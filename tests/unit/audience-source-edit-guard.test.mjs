import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('data edit plans cannot expose audience sources as editable fields', () => {
  const { dataEditAllowProblem } = require('../../scripts/lib/data-edit-action.js');
  const { pickEditableFields } = require('../../scripts/lib/feedback-pipeline-fields.js');
  assert.match(dataEditAllowProblem({ file: 'audience-buzz.json', field: 'sources' }), /not allowed/);
  assert.equal(pickEditableFields(['audience-buzz.json'])['audience-buzz.json'].includes('sources'), false);
});
