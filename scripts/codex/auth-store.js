#!/usr/bin/env node
'use strict';
/**
 * auth-store.js — keep the Codex ChatGPT login alive across fresh cloud
 * sessions for the daily Codex runner (scripts/codex/daily-runner.js, BRO-4745).
 *
 * The login (~/.codex/auth.json, or $CODEX_HOME/auth.json) is stored
 * AES-256-GCM encrypted in ONE comment on the storage card (BRO-4799), keyed
 * from OPENAI_API_KEY (an environment secret every cloud session already has).
 * Refresh tokens rotate, so the copy with the newer last_refresh always wins:
 *
 *   node scripts/codex/auth-store.js restore   # stored -> local when stored is newer or local is missing
 *   node scripts/codex/auth-store.js save      # local -> stored when local is newer
 *   node scripts/codex/auth-store.js sync      # whichever direction is needed
 *   node scripts/codex/auth-store.js status    # print both stamps, change nothing
 *
 * Never prints token material. Exit 0 ok, 2 when no usable login exists
 * (nothing stored and nothing local, or the stored blob will not decrypt).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const linear = require('../lib/linear-client.js');
const {
  AUTH_MARKER, encryptAuth, decryptAuth, authLastRefresh, authCommentBody, parseAuthComment, syncDirection,
} = require('../lib/codex-runner.js');

const STORE_ISSUE = process.env.CODEX_AUTH_STORE_ISSUE || 'BRO-4799';

function authPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function readLocal() {
  try { return fs.readFileSync(authPath(), 'utf8'); } catch { return ''; }
}

async function readStored() {
  const data = await linear.graphql(
    `query($id: String!) { issue(id: $id) { id comments(first: 50) { nodes { id body } } } }`,
    { id: STORE_ISSUE },
  );
  if (!data.issue) throw new Error(`storage card ${STORE_ISSUE} not found`);
  const node = (data.issue.comments.nodes || []).find((c) => String(c.body || '').startsWith(AUTH_MARKER));
  const parsed = node ? parseAuthComment(node.body) : null;
  return { issueId: data.issue.id, commentId: node ? node.id : null, parsed };
}

async function writeStored(stored, plain) {
  const body = authCommentBody(encryptAuth(plain, keyMaterial()), authLastRefresh(plain), new Date().toISOString());
  if (stored.commentId) {
    const data = await linear.graphql(
      `mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }`,
      { id: stored.commentId, body },
    );
    if (!data.commentUpdate || !data.commentUpdate.success) throw new Error('commentUpdate failed');
  } else {
    await linear.createComment(stored.issueId, body);
  }
}

// The login is encrypted with the cloud env's OPENAI_API_KEY. GitHub's
// OPENAI_API_KEY secret is a different key, so codex-runner.yml passes the
// cloud value as the CODEX_AUTH_KEY secret (BRO-4745).
function keyMaterial() {
  const k = process.env.CODEX_AUTH_KEY || process.env.OPENAI_API_KEY;
  if (!k) throw new Error('neither CODEX_AUTH_KEY nor OPENAI_API_KEY is set, so the stored Codex login cannot be opened');
  return k;
}

function writeLocal(plain) {
  const p = authPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, plain, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

async function run(cmd) {
  const local = readLocal();
  const localStamp = authLastRefresh(local);
  const stored = await readStored();
  const storedStamp = stored.parsed ? stored.parsed.lastRefresh : '';
  const dir = syncDirection(localStamp, storedStamp);
  const say = (msg) => console.log(`[codex-auth] ${msg} (local ${localStamp || 'none'}, stored ${storedStamp || 'none'})`);

  if (cmd === 'status') { say(`direction needed: ${dir}`); return localStamp || storedStamp ? 0 : 2; }
  if (!localStamp && !stored.parsed) { say('no Codex login anywhere: run `codex login --device-auth` once, then `save`'); return 2; }

  if ((cmd === 'restore' || cmd === 'sync') && dir === 'restore') {
    let plain;
    try { plain = decryptAuth(stored.parsed.blob, keyMaterial()); } catch (e) {
      say(`stored login will not decrypt (${e.message}); log in again and run save`);
      return 2;
    }
    writeLocal(plain);
    say('restored stored login to local');
    return 0;
  }
  if ((cmd === 'save' || cmd === 'sync') && dir === 'save') {
    await writeStored(stored, local);
    say(`saved local login to ${STORE_ISSUE}`);
    return 0;
  }
  say(`nothing to ${cmd}`);
  return 0;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (!['restore', 'save', 'sync', 'status'].includes(cmd)) {
    console.error('Usage: node scripts/codex/auth-store.js restore|save|sync|status');
    process.exit(1);
  }
  run(cmd).then((code) => process.exit(code), (e) => { console.error(`[codex-auth] ${e.message}`); process.exit(2); });
}

module.exports = { run, authPath };
