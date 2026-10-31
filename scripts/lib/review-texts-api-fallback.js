#!/usr/bin/env node
'use strict';
/**
 * Review-texts support for the Git Data API push fallback (BRO-5589).
 *
 * push-via-git-api.sh builds a commit on the live remote tip by plumbing. For
 * most paths it overlays our blob outright. That was why push-with-retry.sh
 * excluded the broadway-review-texts repo entirely: the local flow runs
 * restore_protected_fields() (restore-protected-fields.js) after every
 * rebase, and the overlay had no equivalent, so a protected field
 * (MANUAL_FIELDS, e.g. humanReviewScore) set by a concurrent writer on a
 * review file we also touched would be silently dropped.
 *
 * This module gives the fallback that step, plus the other review-texts-only
 * behaviors of the local flow it can reproduce without a working tree:
 *
 *   mergeReviewTextsJson()  top-level three-way key merge (base = our merge
 *     base, ours wins only keys it actually changed; CONTENT_FIELDS and the
 *     scoring group move as units) followed by reconcileProtectedFields()
 *     (staleCheckoutGuard off: the real merge base replaces it, see below). THROWS
 *     on any unparsable or non-object side: the caller fails the whole
 *     attempt closed, it never falls back to the overlay.
 *
 *   reviewTextsDisqualifyingPath()  paths the fallback must leave to the
 *     local flow: failed-fetches.json (a multi-writer ARRAY, nothing to key a
 *     merge on) and review files our diff ADDS (the cross-show ownership gate,
 *     validate-added-review-ownership.js, needs the working tree and a
 *     full-corpus URL index; it cannot run in plumbing).
 *
 * Modify/delete is decided in push-via-git-api.sh itself from blob shas: we
 * deleted + remote modified -> keep remote (push-with-retry.sh's
 * is_modify_delete arm); we modified + remote deleted -> FAIL CLOSED, because
 * the deletion is usually a rename and only the local flow follows renames.
 *
 * Known limit (review LOW 3): the merge is top-level only. A nested object
 * both sides changed (e.g. contentVerification outside its three protected
 * sub-keys, llmMetadata outside the scoring group) resolves to ours whole, the
 * same outcome a conflicting hunk gets under the local flow's -X theirs.
 *
 * CLI (used by push-via-git-api.sh and api-fallback-disqualifier.js):
 *   merge <path> <ours-file> <remote-file> <base-file> <base-present 0|1>
 *       prints the merged content on stdout, notes on stderr; exit 1 on error
 *   disqualify <base-ref> <head-ref>
 *       exit 0 clean, 1 disqualified (path on stderr), >1 check failed
 */

const fs = require('fs');
const path = require('path');
const { reconcileProtectedFields, CONTENT_FIELDS } = require(path.join(__dirname, 'restore-protected-fields.js'));
const { SCORING_GROUP } = require(path.join(__dirname, 'scoring-recency.js'));

const REVIEW_TEXTS_REMOTE_MARK = 'broadway-review-texts';
const REVIEW_TEXTS_NEVER_FALLBACK = ['failed-fetches.json'];

function isReviewTextsRemote(url) {
  return typeof url === 'string' && url.includes(REVIEW_TEXTS_REMOTE_MARK);
}

/** Review files are exactly <show>/<file>.json, show dir not _- or .-prefixed. */
function isReviewFilePath(rel) {
  if (!rel || !rel.endsWith('.json') || rel.endsWith('failed-fetches.json')) return false;
  const parts = rel.split('/');
  if (parts.length !== 2) return false;
  if (parts[0].startsWith('_') || parts[0].startsWith('.')) return false;
  return true;
}

/**
 * @param {Array<{status: string, path: string}>} entries name-status rows
 *   (--no-renames, so a rename arrives as D + A)
 * @returns {string|null} a human-readable reason naming the first offending path
 */
function reviewTextsDisqualifyingPath(entries) {
  for (const { status, path: p } of entries || []) {
    const base = p.split('/').pop();
    if (REVIEW_TEXTS_NEVER_FALLBACK.includes(base)) {
      return `${p} (review-texts: multi-writer array, no API-fallback merge)`;
    }
    if (status === 'A' && isReviewFilePath(p)) {
      return `${p} (review-texts: added review file needs the local cross-show ownership gate)`;
    }
  }
  return null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const ABSENT = Symbol('absent');
const get = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : ABSENT);
const same = (a, b) => (a === ABSENT || b === ABSENT ? a === b : stable(a) === stable(b));

/**
 * Three-way merge of two review records. A key (or a whole group) ours left
 * unchanged from base takes remote's state, including remote's deletion; a
 * key ours changed keeps ours (conflicts resolve to ours, like the local
 * flow's `-X theirs` replay). The content and scoring groups are stricter:
 * if both sides changed one differently, this THROWS (fail closed) instead
 * of letting ours win. No base (new file on our side) = base {}.
 */
function threeWayMerge(ours, remote, base) {
  const grouped = new Set([...CONTENT_FIELDS, ...SCORING_GROUP]);
  const decided = new Map();
  let takenFromRemote = 0;
  for (const k of new Set([...Object.keys(ours), ...Object.keys(remote)])) {
    if (grouped.has(k)) continue;
    const o = get(ours, k);
    const pickRemote = same(o, get(base, k));
    if (pickRemote && !same(o, get(remote, k))) takenFromRemote++;
    decided.set(k, pickRemote ? get(remote, k) : o);
  }
  for (const [name, group] of [['content', CONTENT_FIELDS], ['scoring', SCORING_GROUP]]) {
    const oursChanged = group.some((f) => !same(get(ours, f), get(base, f)));
    const remoteChanged = group.some((f) => !same(get(remote, f), get(base, f)));
    // Both sides rewrote the same body/score group since base and they differ:
    // there is no safe winner without the local flow's whole-file context
    // (content-length tie-break, scoring stamps, URL-change breadcrumbs), so
    // fail closed and let push-with-retry.sh's local flow handle the file.
    if (oursChanged && remoteChanged && group.some((f) => !same(get(ours, f), get(remote, f)))) {
      throw new Error(`both sides changed the ${name} group since the merge base; refusing to pick a winner`);
    }
    const src = oursChanged ? ours : remote;
    if (!oursChanged && group.some((f) => !same(get(ours, f), get(remote, f)))) takenFromRemote++;
    for (const f of group) decided.set(f, get(src, f));
  }
  // defineProperty, not `merged[k] = v`: a JSON key named "__proto__" is an
  // own data key after JSON.parse, but plain assignment would set the
  // prototype instead and silently drop it.
  const merged = {};
  for (const k of [...Object.keys(ours), ...Object.keys(remote), ...decided.keys()]) {
    if (Object.prototype.hasOwnProperty.call(merged, k) || !decided.has(k)) continue;
    const v = decided.get(k);
    if (v !== ABSENT) Object.defineProperty(merged, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return { merged, takenFromRemote };
}

function parseObject(text, label) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${String(e.message).slice(0, 120)})`);
  }
  if (!isPlainObject(v)) throw new Error(`${label} is not a JSON object; refusing to merge it`);
  return v;
}

/**
 * @param {string} oursText our blob
 * @param {string} remoteText the live remote tip's blob (caller handles absence)
 * @param {string|null} baseText merge-base blob, null when absent there
 * @returns {{content: string, notes: string[], changed: boolean}}
 */
function mergeReviewTextsJson(oursText, remoteText, baseText) {
  const ours = parseObject(oursText, 'our version');
  const remote = parseObject(remoteText, 'remote version');
  const base = baseText === null ? {} : parseObject(baseText, 'merge-base version');
  const { merged: shallow, takenFromRemote } = threeWayMerge(ours, remote, base);
  // Deep copy: reconcileProtectedFields mutates nested objects of its first
  // argument (contentVerification), which would otherwise alias into `ours`
  // and make the "unchanged from ours" check below compare a mutated ours.
  const merged = JSON.parse(JSON.stringify(shallow));
  // reconcileProtectedFields restores a LONGER fullText from `ours` (it is
  // built for a freshly collected body). When ours left the body as it was at
  // base, ours's body is just the stale copy, and restoring it would undo a
  // concurrent writer's legitimate shorter replacement. Hide it in that case.
  const oursView = same(get(ours, 'fullText'), get(base, 'fullText'))
    ? Object.fromEntries(Object.entries(ours).filter(([k]) => k !== 'fullText'))
    : ours;
  // staleCheckoutGuard OFF (review LOW): its remote-richer fullText/score
  // restore and newer-scoring carry approximate a merge base the local flow
  // does not have. Here the three-way merge above already decides the content
  // and scoring groups against the real base (and throws when both sides
  // changed one), so the guard could only undo a deliberate change of ours,
  // e.g. restore a remote fullText or score that is just the unchanged base
  // copy after our commit shortened the body or cleared the score.
  const { notes } = reconcileProtectedFields(merged, remote, oursView, { staleCheckoutGuard: false });
  if (takenFromRemote) notes.unshift(`kept ${takenFromRemote} concurrent remote change(s) ours did not touch`);
  if (same(merged, ours)) return { content: oursText, notes, changed: false };
  const content = JSON.stringify(merged, null, 2) + (oursText.endsWith('\n') ? '\n' : '');
  return { content, notes, changed: true };
}

module.exports = {
  REVIEW_TEXTS_NEVER_FALLBACK,
  isReviewTextsRemote,
  isReviewFilePath,
  reviewTextsDisqualifyingPath,
  mergeReviewTextsJson,
};

function cliMerge([file, oursFile, remoteFile, baseFile, basePresent]) {
  if (!file || !oursFile || !remoteFile || !baseFile || !['0', '1'].includes(basePresent)) {
    console.error('review-texts-api-fallback: usage: merge <path> <ours> <remote> <base> <base-present 0|1>');
    process.exit(2);
  }
  let r;
  try {
    r = mergeReviewTextsJson(
      fs.readFileSync(oursFile, 'utf8'),
      fs.readFileSync(remoteFile, 'utf8'),
      basePresent === '1' ? fs.readFileSync(baseFile, 'utf8') : null,
    );
  } catch (e) {
    console.error(`review-texts-api-fallback: '${file}' cannot be reconciled: ${String(e && e.message || e).slice(0, 300)}`);
    process.exit(1);
  }
  process.stdout.write(r.content);
  console.error(`  review-texts-api-fallback: reconciled ${file}${r.notes.length ? ` (${r.notes.join('; ')})` : ' (no change to ours)'}`);
}

function cliDisqualify([base, head]) {
  if (!base || !head) {
    console.error('review-texts-api-fallback: usage: disqualify <base-ref> <head-ref>');
    process.exit(2);
  }
  const out = require('child_process').execFileSync(
    'git', ['diff', '--name-status', '-z', '--no-renames', base, head],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]) entries.push({ status: parts[i][0], path: parts[i + 1] });
  }
  const hit = reviewTextsDisqualifyingPath(entries);
  if (hit) {
    console.error(`api-fallback-disqualifier: ${hit}`);
    process.exit(1);
  }
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'merge') cliMerge(rest);
  else if (cmd === 'disqualify') cliDisqualify(rest);
  else {
    console.error('review-texts-api-fallback: usage: merge ... | disqualify <base> <head>');
    process.exit(2);
  }
}
