'use strict';

/**
 * sealed-output.js — encrypt a script's output to a one-time public key (BRO-5008).
 *
 * run-script.yml runs scripts with production API keys in this PUBLIC repo, whose
 * Actions logs anyone can read. Script output can carry private core data, review
 * text (copyrighted) or reader PII, so it must never reach the log in clear. The
 * caller (scripts/cloud-run-script.js) makes a fresh RSA key pair per run, sends
 * only the public half as a workflow input, and is the only holder of the key that
 * opens the result.
 *
 * Format: RSA-OAEP(SHA-256) wraps a random AES-256-GCM key; the sealed object is
 * JSON {v, key, iv, tag, data} with base64 fields.
 */

const crypto = require('crypto');

function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function seal(plaintext, publicKeyPem) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const key = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  return {
    v: 1,
    key: key.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function open(sealed, privateKeyPem) {
  if (!sealed || sealed.v !== 1) throw new Error('unknown sealed-output format');
  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(sealed.key, 'base64'),
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { generateKeyPair, seal, open };
