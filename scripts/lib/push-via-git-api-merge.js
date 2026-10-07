#!/usr/bin/env node
'use strict';
// CLI used by push-via-git-api.sh (BRO-2413) to run a registered
// apiFallbackMerge function (core-data-merge-registry.js) against blob
// content read via `git show`, with no working tree involved. Prints ONLY
// the merged, re-serialized content to stdout (matching push-via-git-api.sh's
// own "clean stdout" convention — its header: "Prints the new commit sha to
// stdout on success") — a one-line stats summary goes to stderr instead.
//
// Exits non-zero (with a message on stderr, nothing meaningful on stdout) on
// ANY error: unregistered path, unparsable input, a thrown merge function.
// The caller treats a non-zero exit as a hard failure for that path and
// aborts the whole attempt — it must NEVER fall back to plain "ours wins"
// for an apiFallbackMerge path, since that would silently reintroduce the
// exact hazard (a genuinely multi-writer file's whole-file overwrite
// dropping another writer's entries) this mechanism exists to close.
//
// Usage: node push-via-git-api-merge.js <path> <ours-file> <remote-file> [<base-file>]
// <ours-file>/<remote-file> are paths to raw blob content on disk (the
// caller writes them via `git show <sha>:<path> > tmpfile`); either may be
// an EMPTY file (path absent on that side — e.g. remote never had it yet),
// never a missing argument — the caller always passes both, even if one
// side's `git show` came back empty. <base-file> is OPTIONAL (BRO-2413
// round-2, Codex adversarial ship-check P0 finding): the merge-base
// snapshot, used by the registered merge functions to distinguish "remote
// added this since our base" (restore it) from "WE deliberately deleted
// this since our base and remote just hasn't caught up" (do NOT restore
// it — see e.g. merge-alert-digest-queue.js's clearDigestQueue() note). If
// omitted, callers get the more conservative two-way behavior (every
// remote-only entry is restored).

const fs = require('fs');
const { apiFallbackMergerFor } = require('./reconcile-merged-json');

function parse(text, format) {
  if (!text.trim()) return format === 'jsonl' ? [] : null;
  if (format === 'jsonl') {
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  return JSON.parse(text);
}

function serialize(value, format, newline) {
  if (format === 'jsonl') {
    const arr = Array.isArray(value) ? value : [];
    return arr.map((e) => JSON.stringify(e)).join('\n') + (arr.length ? '\n' : '');
  }
  return JSON.stringify(value, null, 2) + (newline ? '\n' : '');
}

function main() {
  const [path, oursFile, remoteFile, baseFile] = process.argv.slice(2);
  if (!path || !oursFile || !remoteFile) {
    console.error('push-via-git-api-merge: usage: <path> <ours-file> <remote-file> [<base-file>]');
    process.exit(1);
  }
  const entry = apiFallbackMergerFor(path);
  if (!entry) {
    console.error(`push-via-git-api-merge: '${path}' has no apiFallbackMerge registry entry`);
    process.exit(1);
  }
  const format = entry.format === 'jsonl' ? 'jsonl' : 'json';

  let ours;
  let remote;
  let base;
  let result;
  try {
    ours = parse(fs.readFileSync(oursFile, 'utf8'), format);
    remote = parse(fs.readFileSync(remoteFile, 'utf8'), format);
    base = baseFile ? parse(fs.readFileSync(baseFile, 'utf8'), format) : undefined;
    result = entry.merge(ours, remote, base);
  } catch (e) {
    console.error(`push-via-git-api-merge: '${path}' failed to parse or merge (${String(e && e.message || e).slice(0, 200)})`);
    process.exit(1);
  }
  if (!result || typeof result !== 'object' || !('merged' in result)) {
    console.error(`push-via-git-api-merge: '${path}' merge function returned an invalid result (expected {merged, stats})`);
    process.exit(1);
  }

  let out;
  try {
    out = serialize(result.merged, format, entry.newline);
  } catch (e) {
    console.error(`push-via-git-api-merge: '${path}' failed to serialize merged output (${String(e && e.message || e).slice(0, 200)})`);
    process.exit(1);
  }
  if (!out || (format !== 'jsonl' && !out.trim())) {
    console.error(`push-via-git-api-merge: '${path}' merge produced empty output — refusing to hash an empty blob over an existing file`);
    process.exit(1);
  }

  process.stdout.write(out);
  console.error(`  push-via-git-api-merge: reconciled ${path} — ${JSON.stringify(result.stats || {})}`);
}

main();
