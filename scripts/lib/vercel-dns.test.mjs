// Planning logic of scripts/lib/vercel-dns.mjs (BRO-4894). Requires the real module.
// Run: node --test scripts/lib/vercel-dns.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDns, recordsToDelete, normalizeValue } from './vercel-dns.mjs';

const CNAME = { name: 'auth', type: 'CNAME', value: 'abc.supabase.co' };
const ACME = { name: '_acme-challenge.auth', type: 'TXT', value: 'ca3-token' };

test('creates what is missing and skips what exists, ignoring trailing dots and case', () => {
  const existing = [{ id: '1', name: 'auth', type: 'CNAME', value: 'ABC.supabase.co.' }];
  const plan = planDns(existing, [CNAME, ACME]);
  assert.deepEqual(plan.skip, [CNAME]);
  assert.deepEqual(plan.create, [ACME]);
  assert.deepEqual(plan.conflicts, []);
});

test('an A record, a different CNAME or a TXT on the CNAME name is a conflict', () => {
  for (const other of [
    { id: 'a', name: 'auth', type: 'A', value: '216.150.1.1' },
    { id: 'b', name: 'auth', type: 'CNAME', value: 'elsewhere.example' },
    { id: 'c', name: 'auth', type: 'TXT', value: 'v=spf1' },
  ]) {
    const plan = planDns([other], [CNAME]);
    assert.equal(plan.create.length, 0, `${other.type} should block the CNAME`);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].existing[0].id, other.id);
  }
});

test('another TXT on the ACME name is fine; a CNAME there is not', () => {
  const sibling = [{ id: 't', name: '_acme-challenge.auth', type: 'TXT', value: 'older-token' }];
  assert.deepEqual(planDns(sibling, [ACME]).create, [ACME]);
  const cname = [{ id: 'c', name: '_acme-challenge.auth', type: 'CNAME', value: 'x.example' }];
  assert.equal(planDns(cname, [ACME]).conflicts.length, 1);
});

test('wildcard records never conflict', () => {
  const wild = [{ id: 'w', name: '*', type: 'A', value: '216.150.1.1' }, { id: 'w2', name: '*', type: 'CNAME', value: 'cname.vercel-dns.com' }];
  assert.deepEqual(planDns(wild, [CNAME, ACME]).create, [CNAME, ACME]);
});

test('recordsToDelete matches on name, type and value only', () => {
  const existing = [
    { id: '1', name: 'auth', type: 'CNAME', value: 'abc.supabase.co.' },
    { id: '2', name: 'auth', type: 'A', value: '1.2.3.4' },
    { id: '3', name: '_acme-challenge.auth', type: 'TXT', value: 'ca3-token' },
  ];
  assert.deepEqual(recordsToDelete(existing, [CNAME, ACME]).map((r) => r.id), ['1', '3']);
  assert.equal(normalizeValue('ABC.Supabase.co.'), 'abc.supabase.co');
});
