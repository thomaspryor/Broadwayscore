import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const m = require('./advisory-durability.js');
const KEY = { LINEAR_API_KEY: 'x' };

test('durable record is written when the channel is available', () => {
  const calls = [];
  const r = m.recordAdvisory({ kind: 'OPENCLAIM', session: 'sess_1', cards: ['BRO-12', 'BRO-13'] },
    { env: KEY, post: (card, comment) => calls.push({ card, comment }) });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].card, m.COLLECTOR_CARD);
  assert.match(calls[0].comment, /^OPENCLAIM-ADVISORY: \{/);
  const rec = m.parseComment(calls[0].comment);
  assert.deepEqual([rec.kind, rec.pattern, rec.session, rec.cards], ['OPENCLAIM', 'open-claim', 'sess_1', ['BRO-12', 'BRO-13']]);
});

test('fail-open: a throwing channel never throws, and no key means no network call', () => {
  const r = m.recordAdvisory({ kind: 'WAKEPROMISE', session: 's' }, { env: KEY, post: () => { throw new Error('boom'); } });
  assert.deepEqual(r, { ok: false, reason: 'post-failed' });
  let called = false;
  const r2 = m.recordAdvisory({ kind: 'WAKEPROMISE', session: 's' }, { env: {}, post: () => { called = true; } });
  assert.equal(r2.reason, 'no-key');
  assert.equal(called, false);
  assert.equal(m.recordAdvisory({ kind: 'NOPE' }, { env: KEY, post: () => { called = true; } }).reason, 'bad-kind');
  assert.equal(called, false);
});

test('no text leak: only whitelisted fields, hostile input is stripped', () => {
  const secret = "I'll check back with jane@example.com about the show";
  let comment;
  m.recordAdvisory({ kind: 'WAKEPROMISE', session: secret, cards: [secret, 'BRO-5'], pattern: secret, phrase: secret, text: secret },
    { env: KEY, post: (_c, body) => { comment = body; } });
  assert.ok(!/jane|check back|example|show/i.test(comment), comment);
  const rec = m.parseComment(comment);
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'cards', 'kind', 'pattern', 'session']);
  assert.deepEqual(rec.cards, ['BRO-5']);
});

test('query counts records by kind and distinct sessions, ignoring noise and duplicates', () => {
  const mk = (kind, session, now) => m.formatComment(m.buildRecord({ kind, session, now }));
  const bodies = [
    mk('WAKEPROMISE', 'a', 1000), mk('WAKEPROMISE', 'a', 1000), mk('WAKEPROMISE', 'a', 2000), mk('WAKEPROMISE', 'b', 3000),
    { body: mk('OPENCLAIM', 'c', 4000) }, 'unrelated comment', 'WAKEPROMISE-ADVISORY: {not json',
  ];
  const c = m.countHits(bodies);
  assert.equal(c.total, 4);
  assert.deepEqual(c.byKind, { WAKEPROMISE: 3, OPENCLAIM: 1 });
  assert.deepEqual(c.sessions, { WAKEPROMISE: 2, OPENCLAIM: 1 });
  assert.equal(c.firstAt, new Date(1000).toISOString());
  assert.equal(c.lastAt, new Date(4000).toISOString());
});

test('hook wiring: verify-edits.sh calls the module and writes no message text to the local ledger', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(src, /advisory-durability\.js/);
  assert.doesNotMatch(src, /'phrase': _PROMISE_RE/);
  assert.doesNotMatch(src, /_stall_advisory_post\('WAKEPROMISE', _PROMISE_RE/);
});
