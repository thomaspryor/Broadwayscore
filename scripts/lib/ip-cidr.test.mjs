import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ipToInt, parseCidr, cidrContains, isCoveredByAny, classifyBlacklistEntries } = require('./ip-cidr.js');

test('ipToInt: valid and invalid addresses', () => {
  assert.equal(ipToInt('0.0.0.0'), 0);
  assert.equal(ipToInt('255.255.255.255'), 0xffffffff);
  assert.equal(ipToInt('158.23.190.0'), (158 * 256 ** 3 + 23 * 256 ** 2 + 190 * 256) >>> 0);
  assert.equal(ipToInt('256.1.1.1'), null);
  assert.equal(ipToInt('1.2.3'), null);
  assert.equal(ipToInt('a.b.c.d'), null);
  assert.equal(ipToInt('2603:1030::5'), null); // IPv6 fails safe
});

test('parseCidr: bare IP means /32, junk means null', () => {
  assert.deepEqual(parseCidr('10.0.0.1'), { base: ipToInt('10.0.0.1'), bits: 32 });
  assert.equal(parseCidr('10.0.0.0/33'), null);
  assert.equal(parseCidr('10.0.0.0/8/8'), null);
  assert.equal(parseCidr(''), null);
});

// The real incident shape (2026-07-27): Bright Data blacklisted the GitHub
// Actions runner range 158.23.190.0/24, which sits inside GitHub's published
// 158.23.0.0/16.
test('cidrContains: GH-meta range covers the BD-blacklisted /24 and single IPs', () => {
  assert.equal(cidrContains('158.23.0.0/16', '158.23.190.0/24'), true);
  assert.equal(cidrContains('158.23.0.0/16', '158.23.190.7'), true);
  assert.equal(cidrContains('158.23.0.0/16', '158.24.0.1'), false);
  assert.equal(cidrContains('158.23.190.0/24', '158.23.0.0/16'), false); // wider than outer
  assert.equal(cidrContains('0.0.0.0/0', '203.0.113.7'), true);
  assert.equal(cidrContains('158.23.0.0/16', '2603:1030::5'), false); // IPv6 never contained
});

test('isCoveredByAny: any-range containment, fails safe on junk', () => {
  const ranges = ['4.148.0.0/16', '158.23.0.0/16'];
  assert.equal(isCoveredByAny('158.23.190.0/24', ranges), true);
  assert.equal(isCoveredByAny('4.148.12.9', ranges), true);
  assert.equal(isCoveredByAny('203.0.113.7', ranges), false);
  assert.equal(isCoveredByAny('not-an-ip', ranges), false);
});

// check-bd-blacklist.js's 3-way partition, extracted so it's testable
// without mocking the BD/GitHub APIs (CLAUDE.md rule 15).
test('classifyBlacklistEntries: partitions GitHub-runner / unknown / unclassified', () => {
  const ghRanges = ['4.148.0.0/16', '158.23.0.0/16'];
  const entries = ['158.23.190.0/24', '203.0.113.7', '2603:1030::5', 'not-an-ip'];
  assert.deepEqual(classifyBlacklistEntries(entries, ghRanges), {
    ours: ['158.23.190.0/24'],
    unknown: ['203.0.113.7'],
    unclassified: ['2603:1030::5', 'not-an-ip'],
  });
});

test('classifyBlacklistEntries: empty entries → empty buckets', () => {
  assert.deepEqual(classifyBlacklistEntries([], ['158.23.0.0/16']), {
    ours: [],
    unknown: [],
    unclassified: [],
  });
});
