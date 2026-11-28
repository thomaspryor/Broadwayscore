// BRO-7061: stored Arts Desk texts lose the support banner and trailing Image label.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stripArtsDeskChrome } = require('../../scripts/lib/artsdesk-chrome.js');
const { ALLOWED_SCRIPTS } = require('../../scripts/lib/run-script-allowlist.js');

const BANNER = 'Help keep arts journalism alive.\n\nWe’re rebuilding theartsdesk to secure it as a bastion of real culture writing. Your participation is absolutely vital to this - subscribe today and be part of this movement.\n\nSUBSCRIBE TODAY';
const SENT = 'The company stages the second act with a clarity the first lacked, and the lead holds the room for an hour.';
const BODY = [SENT, SENT, SENT, SENT].join(' ');

describe('stripArtsDeskChrome', () => {
  test('cuts the banner at the start', () => {
    assert.equal(stripArtsDeskChrome(`${BANNER}\n\n${BODY}`), BODY);
  });
  test('cuts a banner flattened onto one line', () => {
    assert.equal(stripArtsDeskChrome(`${BANNER.replace(/\n+/g, ' ')} ${BODY}`), BODY);
  });
  test('cuts a trailing Image label', () => {
    assert.equal(stripArtsDeskChrome(`${BODY}\n\nImage`), BODY);
  });
  test('cuts both together', () => {
    assert.equal(stripArtsDeskChrome(`${BANNER}\n\n${BODY}\n\nImage`), BODY);
  });
  test('leaves clean text and prose that mentions subscribing untouched', () => {
    assert.equal(stripArtsDeskChrome(BODY), BODY);
    const t = 'Readers should subscribe today to see it, and the Image of the play stays with you.';
    assert.equal(stripArtsDeskChrome(t), t);
  });
  test('the repair script is allowlisted for pending-fix plans', () => {
    assert.ok(ALLOWED_SCRIPTS.includes('strip-artsdesk-banner.js'));
  });
});

test('banner strip keeps a leading quote mark or paren of the article', async () => {
  const { createRequire } = await import('node:module');
  const { stripArtsDeskChrome } = createRequire(import.meta.url)('../../scripts/lib/artsdesk-chrome.js');
  const banner = 'Help keep arts journalism alive. We are rebuilding after a hard year and need readers to help fund independent criticism. SUBSCRIBE TODAY ';
  const body = '“Hamlet” opens at the theatre with a cast of strong players and a clear sense of purpose across the evening. '.repeat(6);
  assert.ok(stripArtsDeskChrome(banner + body).startsWith('“Hamlet'));
  assert.ok(stripArtsDeskChrome(banner + '(Photo credit) ' + body).startsWith('(Photo'));
  assert.equal(stripArtsDeskChrome(body + 'end.Image').endsWith('end.'), true);
});
