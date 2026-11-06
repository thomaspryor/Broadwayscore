// BRO-7038: AP's Mark Kennedy was registered as news-tribune's defaultCritic, so
// every newspaper's syndicated copy of his AP story read as cross-outlet drift.
// Wire-service critics must not be some newspaper's defaultCritic.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { outlets } = JSON.parse(readFileSync(path.join(root, 'data', 'outlet-registry.json'), 'utf8'));
const WIRE_CRITICS = ['Mark Kennedy'];

test('wire-service critics are not any outlet defaultCritic', () => {
  const bad = Object.entries(outlets)
    .filter(([, o]) => WIRE_CRITICS.includes(o.defaultCritic))
    .map(([id]) => id);
  assert.deepStrictEqual(bad, []);
});
