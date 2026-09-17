// tests/unit/dmarc-deliverability.test.mjs — BRO-2600: the domain's DMARC
// aggregate reports showed zero authentication failures across 12,633
// messages over 170 days, which is the evidence threshold
// scripts/lib/dmarc-analysis.js uses to recommend tightening the policy from
// p=quarantine to p=reject. The record was updated at the registrar; this
// file is the regression gate that catches it drifting back.
//
// Pure logic (parseDmarcRecord / evaluateDmarcTxtRecords) is required from
// scripts/lib/dmarc-record.js per CLAUDE.md rule 15 — this file does not
// restate the parsing. The last test resolves the live record: a DNS TXT
// lookup, not a scrape, so it's reliable enough for the main CI batch, and
// it is the only thing that actually proves the DNS record was changed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDmarcRecord, evaluateDmarcTxtRecords, fetchDmarcPolicy } = require('../../scripts/lib/dmarc-record.js');

const DOMAIN = 'broadwayscorecard.com';

describe('parseDmarcRecord', () => {
  it('parses tag=value pairs from a DMARC1 record', () => {
    const tags = parseDmarcRecord('v=DMARC1; p=reject; rua=mailto:thomas.pryor@gmail.com');
    assert.deepEqual(tags, { v: 'DMARC1', p: 'reject', rua: 'mailto:thomas.pryor@gmail.com' });
  });

  it('returns null for a non-DMARC TXT record', () => {
    assert.equal(parseDmarcRecord('v=spf1 include:spf.improvmx.com ~all'), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(parseDmarcRecord(null), null);
    assert.equal(parseDmarcRecord(undefined), null);
  });
});

describe('evaluateDmarcTxtRecords', () => {
  it('reports not-found when no DMARC record exists at the name', () => {
    const r = evaluateDmarcTxtRecords([]);
    assert.equal(r.found, false);
    assert.equal(r.enforced, false);
    assert.equal(r.reason, 'no-dmarc-record');
  });

  it('ignores unrelated TXT records at the same name and finds the DMARC one', () => {
    const r = evaluateDmarcTxtRecords(['google-site-verification=abc123', 'v=DMARC1; p=reject']);
    assert.equal(r.found, true);
    assert.equal(r.enforced, true);
  });

  it('flags p=quarantine as not enforced — the pre-fix state', () => {
    const r = evaluateDmarcTxtRecords(['v=DMARC1; p=quarantine; rua=mailto:thomas.pryor@gmail.com']);
    assert.equal(r.found, true);
    assert.equal(r.enforced, false);
    assert.equal(r.policy, 'quarantine');
    assert.equal(r.reason, 'policy-not-reject');
  });

  it('flags p=none as not enforced', () => {
    const r = evaluateDmarcTxtRecords(['v=DMARC1; p=none']);
    assert.equal(r.enforced, false);
    assert.equal(r.policy, 'none');
  });

  it('confirms p=reject at pct=100 as enforced — the post-fix state', () => {
    const r = evaluateDmarcTxtRecords(['v=DMARC1; p=reject; rua=mailto:thomas.pryor@gmail.com']);
    assert.equal(r.found, true);
    assert.equal(r.enforced, true);
    assert.equal(r.policy, 'reject');
    assert.equal(r.reason, null);
  });

  it('flags p=reject with pct<100 as not fully enforced', () => {
    const r = evaluateDmarcTxtRecords(['v=DMARC1; p=reject; pct=50']);
    assert.equal(r.policy, 'reject');
    assert.equal(r.enforced, false);
    assert.equal(r.reason, 'pct-below-100');
  });

  it('flags multiple DMARC records as invalid per RFC 7489 — worse than p=none', () => {
    const r = evaluateDmarcTxtRecords(['v=DMARC1; p=reject', 'v=DMARC1; p=none']);
    assert.equal(r.found, true);
    assert.equal(r.enforced, false);
    assert.equal(r.reason, 'multiple-dmarc-records');
  });

  it('joins multi-chunk TXT records the way dns.resolveTxt callers must', () => {
    // dns.resolveTxt returns one array of string chunks per record; callers
    // join each record's chunks before handing strings to this function.
    const chunks = ['v=DMARC1; p=', 'reject; rua=mailto:thomas.pryor@gmail.com'];
    const r = evaluateDmarcTxtRecords([chunks.join('')]);
    assert.equal(r.enforced, true);
  });
});

describe('live DMARC policy — broadwayscorecard.com', () => {
  it(`_dmarc.${DOMAIN} enforces p=reject`, { timeout: 10000 }, async () => {
    const result = await fetchDmarcPolicy(DOMAIN);
    assert.equal(result.found, true, `expected a DMARC record at _dmarc.${DOMAIN}`);
    assert.equal(
      result.reason,
      null,
      `_dmarc.${DOMAIN} is not fully enforced: ${result.reason} (raw: ${result.raw || '(none)'})`
    );
    assert.equal(result.policy, 'reject');
    assert.equal(result.enforced, true);
  });
});
