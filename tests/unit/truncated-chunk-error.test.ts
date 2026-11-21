/**
 * Sentry BROADWAY-SCORECARD-37 (BRO-7809): SyntaxErrors thrown inside a built
 * /_next/static chunk are cut-off downloads, not bugs, and must not reach
 * Sentry. Real errors must still get through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTruncatedChunkError } from '../../src/lib/analytics/truncated-chunk-error';

const CHUNK = 'https://broadwayscorecard.com/_next/static/chunks/b468fba8.47bfaad1005addc2.js?dpl=5d91bef15ce0cbe37fdc9182bf8014aa';

const PARSE_MESSAGES = ['Unexpected end of input', 'Invalid or unexpected token', 'missing ) after argument list'];

function ev(type: string, ...filenames: Array<string | undefined>) {
  return evMsg(type, 'Unexpected end of input', ...filenames);
}

function evMsg(type: string, value: string, ...filenames: Array<string | undefined>) {
  return { exception: { values: [{ type, value, stacktrace: { frames: filenames.map(filename => ({ filename })) } }] } };
}

test('the three SyntaxError messages seen on the issue, at varied columns, are dropped', () => {
  // Same shape for each message: only the type and the chunk URL matter.
  for (const file of [CHUNK, '/_next/static/chunks/b468fba8.47bfaad1005addc2.js', 'https://demo.broadwayscorecard.com/_next/static/chunks/app/layout-f27cae964f06d305.js']) {
    assert.equal(isTruncatedChunkError(ev('SyntaxError', file)), true, file);
  }
});

test('each of the three real messages is dropped', () => {
  for (const m of PARSE_MESSAGES) assert.equal(isTruncatedChunkError(evMsg('SyntaxError', m, CHUNK)), true, m);
});

test('runtime SyntaxErrors from our own code in a chunk still report (JSON.parse, RegExp)', () => {
  for (const m of [
    `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    'Unexpected end of JSON input',
    'Invalid regular expression: /(/: Unterminated group',
    'JSON.parse: unexpected character at line 1 column 1 of the JSON data',
    '',
  ]) assert.equal(isTruncatedChunkError(evMsg('SyntaxError', m, CHUNK)), false, m);
  assert.equal(isTruncatedChunkError({ exception: { values: [{ type: 'SyntaxError', stacktrace: { frames: [{ filename: CHUNK }] } }] } }), false, 'no message');
});

test('anything else still reports', () => {
  assert.equal(isTruncatedChunkError(ev('TypeError', CHUNK)), false, 'a runtime bug in a chunk');
  assert.equal(isTruncatedChunkError(ev('SyntaxError', 'https://broadwayscorecard.com/some-inline-page')), false, 'a SyntaxError outside /_next/static');
  assert.equal(isTruncatedChunkError(ev('SyntaxError', CHUNK, 'https://broadwayscorecard.com/app.js')), false, 'a mixed stack');
  assert.equal(isTruncatedChunkError(ev('SyntaxError', undefined)), false, 'frame without a filename');
  assert.equal(isTruncatedChunkError(ev('SyntaxError')), false, 'no frames');
  assert.equal(isTruncatedChunkError({ exception: { values: [] } }), false);
  assert.equal(isTruncatedChunkError({}), false);
  assert.equal(isTruncatedChunkError(null), false);
  assert.equal(isTruncatedChunkError(undefined), false);
  // The asset path must sit at the site root, not under another prefix.
  assert.equal(isTruncatedChunkError(ev('SyntaxError', 'https://broadwayscorecard.com/x/_next/static/chunks/a.js')), false, 'prefixed look-alike path');
});

test('wiring: the Sentry beforeSend in AnalyticsWrapper calls the filter', () => {
  const wrapper = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'AnalyticsWrapper.tsx'), 'utf-8');
  assert.match(wrapper, /import \{ isTruncatedChunkError \} from '@\/lib\/analytics\/truncated-chunk-error'/);
  assert.match(wrapper, /if \(isTruncatedChunkError\(event\)\) return null;/, 'beforeSend drops truncated-chunk errors');
});
