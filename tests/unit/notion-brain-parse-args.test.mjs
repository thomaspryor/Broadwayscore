// BRO-344: parseArgs used a truthy check on the next argv token, so an
// explicit empty-string flag value passed space-separated (`--outcome ''`)
// was treated as "no value" — the flag became boolean `true` and the empty
// string leaked into `_positional` instead of being consumed. Repro incident:
// BRO-343 loop session, 2026-08-14 — Outcome field got written as literal
// "true".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../scripts/lib/notion-brain-parse-args.js';

test('--flag=value (equals form) parses the value', () => {
  assert.deepEqual(parseArgs(['--outcome=hello']), {
    _positional: [],
    outcome: 'hello',
  });
});

test('--flag= (empty via equals) already worked — regression guard', () => {
  assert.deepEqual(parseArgs(['--outcome=']), {
    _positional: [],
    outcome: '',
  });
});

test('--flag "" (empty via space-separated) is consumed as the value, not lost to _positional', () => {
  assert.deepEqual(parseArgs(['--outcome', '', '--overwrite-outcome']), {
    _positional: [],
    outcome: '',
    'overwrite-outcome': true,
  });
});

test('--flag value (space-separated) parses the value', () => {
  assert.deepEqual(parseArgs(['--status', 'Done']), {
    _positional: [],
    status: 'Done',
  });
});

test('--flag at end of argv with no next token stays boolean true', () => {
  assert.deepEqual(parseArgs(['--force']), {
    _positional: [],
    force: true,
  });
});

test('--flag --other (next token is another flag) stays boolean true', () => {
  assert.deepEqual(parseArgs(['--force', '--overwrite-outcome']), {
    _positional: [],
    force: true,
    'overwrite-outcome': true,
  });
});

test('positional args are preserved alongside flags', () => {
  assert.deepEqual(parseArgs(['update', 'page-123', '--status', 'Done']), {
    _positional: ['update', 'page-123'],
    status: 'Done',
  });
});
