import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolePromptHeader } from '../../scripts/lib/visual-qa-prompt.mjs';

for (const [label, roles] of [
  ['default', undefined],
  ['null roles', null],
  ['empty roles', []],
  ['single goal', ['goal']],
  ['multiple goals', ['goal', 'goal']],
  ['goal then before', ['goal', 'before']],
  ['before then goal', ['before', 'goal']],
]) {
  test(`${label}: scope implementation crops to the matching reference region`, () => {
    const prompt = rolePromptHeader(roles);
    assert.match(prompt, /IMPLEMENTATION images may be tight crops of single components/);
    assert.match(prompt, /Compare each crop only to the matching region of the REFERENCE/);
    assert.match(prompt, /never report elements outside the crop as missing/);
  });
}
