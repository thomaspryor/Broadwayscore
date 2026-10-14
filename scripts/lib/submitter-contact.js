#!/usr/bin/env node
'use strict';

/**
 * BRO-4454. Keeps a /submit-review submitter's email out of the PUBLIC
 * thomaspryor/Broadwayscore issue tracker while still letting
 * process-review-submission.yml email them the approve/reject outcome.
 *
 * The Vercel route (src/app/api/submit-review/route.ts) can only write a
 * GitHub issue: it cannot reach the private core-data repo that BRO-4453's
 * feedback-submitter-store.js uses, and no API route has a Supabase service
 * client. So the address rides in the issue, sealed with AES-256-GCM, and only
 * a holder of the key can read it back.
 *
 * Key: HKDF-SHA256 over APPROVAL_HMAC_SECRET, which Vercel and GitHub Actions
 * both already hold. The distinct HKDF info string keeps this key independent
 * of the secret's HMAC use. Coupling to know about: rotating that secret makes
 * submissions still pending at the time undecryptable, so those submitters get
 * no notify email (extractSubmitterEmail returns null; nothing breaks). The
 * "v1." token prefix leaves room to move to a dedicated secret later.
 *
 * Never log a decrypted address: the Actions logs of this repo are public.
 */

const { seal, open } = require('./hkdf-seal');

const CONTACT_HEADING = '### Submitter Contact (encrypted)';
const LEGACY_EMAIL_HEADING = '### Submitter Email';
const NO_RESPONSE = '_No response_';
const NOT_STORED = '_Not stored_';
const TOKEN_PREFIX = 'v1.';
const HKDF_INFO = 'bsc/submit-review/submitter-contact/v1';
const MAX_EMAIL_LENGTH = 254;

// Strict on purpose: the workflow puts the result into a JSON payload and a
// mail "to" field, so quotes, spaces, commas and angle brackets are refused.
const STRICT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function isDeliverableEmail(value) {
  const s = String(value || '');
  return s.length <= MAX_EMAIL_LENGTH && STRICT_EMAIL_RE.test(s);
}

const SEAL_OPTS = { info: HKDF_INFO, prefix: TOKEN_PREFIX };

function encryptContact(email, secret) {
  if (!secret) throw new Error('submitter-contact: no secret');
  return seal(email, secret, SEAL_OPTS);
}

/** Returns the plaintext, or null for a wrong secret, a tampered or foreign token. */
function decryptContact(token, secret) {
  return open(token, secret, SEAL_OPTS);
}

/**
 * The issue-body lines for the submitter's contact. Fails closed: with no
 * secret configured the address is dropped, never written in plaintext.
 */
function formatContactSection(email, secret) {
  const e = String(email || '').trim();
  let value = NO_RESPONSE;
  if (e) value = secret ? encryptContact(e, secret) : NOT_STORED;
  return [CONTACT_HEADING, value];
}

/**
 * First non-empty line under the LAST `heading`, or null. Last, because the
 * contact section comes after the free-text notes, so a heading pasted into
 * the notes cannot stand in for the real one.
 */
function readSectionLine(issueBody, heading) {
  const lines = String(issueBody || '').split(/\r?\n/);
  const i = lines.map((l) => l.trim()).lastIndexOf(heading);
  if (i === -1) return null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.startsWith('### ')) return null;
    if (l) return l;
  }
  return null;
}

/**
 * The submitter's address from an issue body, or null. Reads the encrypted
 * section, falling back to the plaintext section of issues filed before
 * BRO-4454 so their outcome emails still go out.
 */
function extractSubmitterEmail(issueBody, secret) {
  const token = readSectionLine(issueBody, CONTACT_HEADING);
  const candidate = token !== null
    ? decryptContact(token, secret)
    : readSectionLine(issueBody, LEGACY_EMAIL_HEADING);
  return candidate && isDeliverableEmail(candidate.trim()) ? candidate.trim() : null;
}

/**
 * True when the body carries a sealed token that does not decrypt with
 * `secret` (missing or rotated secret, or a tampered body).
 */
function sealedContactUndecryptable(issueBody, secret) {
  const token = readSectionLine(issueBody, CONTACT_HEADING);
  return token !== null && token.startsWith(TOKEN_PREFIX) && decryptContact(token, secret) === null;
}

module.exports = {
  CONTACT_HEADING,
  LEGACY_EMAIL_HEADING,
  NO_RESPONSE,
  NOT_STORED,
  isDeliverableEmail,
  encryptContact,
  decryptContact,
  formatContactSection,
  extractSubmitterEmail,
  sealedContactUndecryptable,
};
