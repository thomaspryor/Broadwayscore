#!/usr/bin/env node
'use strict';
/**
 * html-handoff-keygen.js (BRO-5886): run by html-handoff-key.yml only. Makes
 * sure the committed public key and the HTML_HANDOFF_PRIVATE_KEY secret are a pair.
 *
 *   node scripts/html-handoff-keygen.js --private-out=FILE [--public-out=PEM] [--rotate]
 *
 * With the secret in env (and no --rotate): derive its public key. If the
 * committed pem already matches, do nothing; else rewrite the pem (no new secret).
 * Without the secret, or with --rotate: generate a pair, prove a round trip,
 * write the private key 0600 to --private-out for `gh secret set`, and the pem.
 * Writes action=none|commit|set-secret to $GITHUB_OUTPUT. Never prints a key.
 */
const crypto = require('crypto');
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const h = require('./lib/html-handoff');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function plan({ existingPrivatePem, committedPublicPem, rotate }) {
  if (existingPrivatePem && !rotate) {
    const pub = crypto.createPublicKey(crypto.createPrivateKey(existingPrivatePem)).export({ type: 'spki', format: 'pem' });
    if (committedPublicPem && h.keyId(committedPublicPem) === h.keyId(pub)) return { action: 'none', publicKeyPem: pub };
    return { action: 'commit', publicKeyPem: pub };
  }
  const { publicKey, privateKey } = h.generateKeyPair();
  const probeUrl = 'https://example.com/html-handoff-self-test';
  const probe = '<html>' + 'self-test '.repeat(80) + '</html>';
  if (h.decryptHtml(h.encryptHtml(probe, probeUrl, publicKey), probeUrl, privateKey) !== probe) throw new Error('round-trip self-test failed');
  return { action: 'set-secret', publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const privateOut = arg('private-out');
  const publicOut = arg('public-out') || h.PUBLIC_KEY_PATH;
  if (!privateOut) { console.error('--private-out=FILE is required'); return 2; }
  const res = plan({
    existingPrivatePem: process.env[h.PRIVATE_KEY_ENV] || null,
    committedPublicPem: fs.existsSync(publicOut) ? fs.readFileSync(publicOut, 'utf8') : null,
    rotate: process.argv.includes('--rotate'),
  });
  if (res.action !== 'none') fs.writeFileSync(publicOut, res.publicKeyPem);
  if (res.privateKeyPem) fs.writeFileSync(privateOut, res.privateKeyPem, { mode: 0o600 });
  console.log(`action=${res.action} kid=${h.keyId(res.publicKeyPem)}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `action=${res.action}\nkid=${h.keyId(res.publicKeyPem)}\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { plan };
