'use strict';
// BRO-6199: --require preload for scripts/autonomous-email.test.mjs. Makes the
// real scripts/autonomous-email.js hermetic: no Notion, no ledger on disk, no
// network, and the --dry-run preview is redirected out of the repo.
const path = require('path');
const fs = require('fs');
const https = require('https');
const cp = require('child_process');
const { EventEmitter } = require('events');

const REPO = path.resolve(__dirname, '../..');

// Ledger evidence for one card (an item without a branch is skipped).
const ledger = require(path.join(REPO, 'scripts/lib/autonomous-ledger.js'));
ledger.readEntries = () => ({
  entries: [{ event: 'card-pass', cardId: 'card-1', evidence: { branch: 'auto/card-1', summary: 's', checks: [] }, totalUSD: 0 }],
});

// notion-brain.js is spawned with execFileSync: answer list/get in-process.
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, ...rest) {
  // overnight-digest runs a real `git fetch origin main`; keep the test off the network and .git.
  if (file === 'git' && Array.isArray(args) && args[0] === 'fetch') return '';
  if (Array.isArray(args) && /notion-brain\.js$/.test(String(args[0]))) {
    const verb = args[1];
    if (verb === 'list') return JSON.stringify([{ id: 'card-1', name: 'Fix the thing' }]);
    if (verb === 'get') return JSON.stringify({ notes: '' });
  }
  return realExec.call(this, file, args, ...rest);
};

// The only HTTPS call allowed is the plain-language Anthropic one; its reply
// carries em dashes the guard must strip. Anything else fails fast.
https.request = function (opts, cb) {
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    if (opts.hostname !== 'api.anthropic.com' || opts.path !== '/v1/messages') {
      setImmediate(() => req.emit('error', new Error(`stub: blocked ${opts.hostname}${opts.path}`)));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = 200;
    setImmediate(() => {
      cb(res);
      res.emit('data', JSON.stringify({ content: [{ type: 'text', text: 'Fixes a broken page — safe to approve' }] }));
      res.emit('end');
    });
  };
  return req;
};

// Keep the dry-run preview out of the repo.
const realWrite = fs.writeFileSync;
fs.writeFileSync = function (p, ...rest) {
  if (/autonomous-email-preview\.html$/.test(String(p)) && process.env.STUB_PREVIEW_OUT) p = process.env.STUB_PREVIEW_OUT;
  return realWrite.call(this, p, ...rest);
};
