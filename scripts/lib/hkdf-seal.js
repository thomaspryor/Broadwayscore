'use strict';

/**
 * AES-256-GCM sealing keyed by HKDF-SHA256 over a shared secret (in practice
 * APPROVAL_HMAC_SECRET, which Vercel and GitHub Actions both hold). Lets a
 * Vercel route hand a value to a workflow through a PUBLIC channel (an issue
 * body, a workflow_dispatch input) that only a key holder can read back.
 *
 * Each caller passes its own HKDF `info` string, so every use gets an
 * independent key, and its own token prefix, which leaves room to version the
 * format. Callers: submitter-contact.js (BRO-4454), gmail-reauth.js (BRO-3712).
 */

const crypto = require('crypto');

const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(secret, info) {
  if (!secret) throw new Error('hkdf-seal: no secret');
  if (!info) throw new Error('hkdf-seal: no info');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), Buffer.alloc(0), info, 32));
}

/** `${prefix}${base64url(iv | tag | ciphertext)}`. Throws without a secret. */
function seal(plaintext, secret, { info, prefix }) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, info), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** The plaintext, or null for a wrong secret or info, a tampered or foreign token. */
function open(token, secret, { info, prefix }) {
  try {
    const t = String(token || '').trim();
    if (!secret || !t.startsWith(prefix)) return null;
    const raw = Buffer.from(t.slice(prefix.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, info), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { seal, open };
