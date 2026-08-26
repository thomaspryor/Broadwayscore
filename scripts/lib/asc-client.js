// Shared App Store Connect API auth (ES256 JWT) + GET helper.
// Used by scripts/asc-review-status.js and scripts/lib/testflight-status.js.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const KEY_ID = '7MPPJ2254M';
const ISSUER_ID = '2d03cc88-e016-4fb7-8d89-a70a4a912875';

function keyPath() {
  return process.env.ASC_KEY_PATH || `${process.env.HOME}/.keys/AuthKey_${KEY_ID}.p8`;
}

function hasCredentials() {
  return fs.existsSync(keyPath());
}

function makeJWT() {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })).toString('base64url');
  const toSign = `${header}.${payload}`;
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath()));
  const sig = crypto.sign(null, Buffer.from(toSign), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${toSign}.${sig}`;
}

function ascGet(path) {
  return new Promise((resolve, reject) => {
    const token = makeJWT();
    https.get({ hostname: 'api.appstoreconnect.apple.com', path, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(`ASC API ${res.statusCode}: ${JSON.stringify(json.errors)}`));
          resolve(json);
        } catch (e) {
          reject(new Error(`ASC API parse error (${res.statusCode}): ${data}`));
        }
      });
    }).on('error', reject);
  });
}

module.exports = { KEY_ID, ISSUER_ID, keyPath, hasCredentials, makeJWT, ascGet };
