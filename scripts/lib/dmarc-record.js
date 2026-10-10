#!/usr/bin/env node
// scripts/lib/dmarc-record.js — parse and evaluate the live _dmarc TXT
// record's enforcement policy (RFC 7489), independent of the aggregate-report
// evidence scripts/lib/dmarc-analysis.js reasons about.
//
// WHY A SEPARATE MODULE: dmarc-analysis.js infers "policy" from what
// reporters have OBSERVED (lags days behind a DNS edit, since it only
// updates when the next aggregate report arrives). This module answers
// "what does DNS say right now" — the direct check BRO-2600's acceptance
// criteria asks for after tightening the record to p=reject.
//
// Pure functions only — no fs, no network. The I/O (dns.resolveTxt) lives in
// fetchDmarcPolicy() at the bottom, kept thin on purpose so the decision
// logic above it stays testable without a live resolver.
//
// Tested by tests/unit/dmarc-deliverability.test.mjs (CLAUDE.md rule 15 —
// the test require()s these functions, it does not restate them).

'use strict';

/**
 * Parse one DMARC TXT record string into its tag=value pairs, or null if the
 * string isn't a DMARC record at all (the ignore case for any other TXT
 * record that happens to live at the same name — none expected here, but
 * _dmarc is not reserved to DMARC by the DNS itself).
 */
function parseDmarcRecord(txt) {
  if (typeof txt !== 'string' || !/^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(txt)) return null;
  const tags = {};
  for (const part of txt.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    tags[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }
  return tags;
}

/**
 * Evaluate the raw TXT records found at _dmarc.<domain> and report whether
 * the domain enforces p=reject.
 *
 * @param {string[]} records  One entry per TXT record at the name. Each
 *   dns.resolveTxt() array-of-arrays record is already joined into a single
 *   string by the caller (Node splits one record into chunks; a record is
 *   one logical string regardless of how many chunks it arrived in).
 */
function evaluateDmarcTxtRecords(records) {
  const list = Array.isArray(records) ? records : [];
  const dmarcRecords = list.filter((txt) => parseDmarcRecord(txt) !== null);

  if (dmarcRecords.length === 0) {
    return { found: false, enforced: false, policy: null, reason: 'no-dmarc-record' };
  }
  // RFC 7489 §6.6.3: a name with more than one DMARC-formatted TXT record is
  // invalid and receivers MUST ignore the whole thing — worse than p=none,
  // since it silently discards whatever policy was intended.
  if (dmarcRecords.length > 1) {
    return { found: true, enforced: false, policy: null, reason: 'multiple-dmarc-records', records: dmarcRecords };
  }

  const raw = dmarcRecords[0];
  const tags = parseDmarcRecord(raw);
  const policy = tags.p || null;
  const pct = tags.pct !== undefined ? Number(tags.pct) : 100;
  // pct<100 means the strict policy only applies to a sample of mail — the
  // rest falls back to the next-weaker policy, so it isn't fully enforced
  // even when p=reject.
  const enforced = policy === 'reject' && (Number.isFinite(pct) ? pct >= 100 : true);

  return {
    found: true,
    enforced,
    policy,
    pct,
    raw,
    reason: enforced ? null : (policy === 'reject' ? 'pct-below-100' : 'policy-not-reject'),
  };
}

/** Live lookup: resolve _dmarc.<domain> and evaluate its policy. */
async function fetchDmarcPolicy(domain) {
  const dns = require('node:dns').promises;
  const records = await dns.resolveTxt(`_dmarc.${domain}`);
  const joined = records.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  return evaluateDmarcTxtRecords(joined);
}

module.exports = {
  parseDmarcRecord,
  evaluateDmarcTxtRecords,
  fetchDmarcPolicy,
};
