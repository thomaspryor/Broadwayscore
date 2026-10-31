'use strict';

/**
 * text-fetched-at-backfill (BRO-4490): give a textFetchedAt to review files
 * scored on a truncated fullText that never had one, so
 * isTruncatedScoreNowComplete (rescore-flagging.js) can compare it with
 * llmMetadata.scoredAt and notice when a complete text landed after scoring.
 *
 * The value must be the time the CURRENT fullText arrived:
 *  1. the commit time of the newest review-texts commit that changed fullText
 *     to its current value (git history; truthful), else
 *  2. the record's own earliest-known timestamp (firstSeenAt, addedAt,
 *     collectedAt). It can only be at or before the real fetch, so it never
 *     makes a score look stale that is not: it just gives later collects a
 *     baseline. Recorded in textFetchedAtBackfill so the guess is visible.
 */

const FALLBACK_FIELDS = ['firstSeenAt', 'addedAt', 'collectedAt'];

/** Scored on a fullText the scorer called truncated, with no textFetchedAt. */
function needsTextFetchedAtBackfill(data) {
  if (!data || typeof data !== 'object' || data.textFetchedAt) return false;
  const src = data.llmMetadata && data.llmMetadata.textSource;
  return !!(src && src.type === 'fullText' && src.status === 'truncated' && typeof data.fullText === 'string' && data.fullText);
}

function validIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * @param {object} data review-text record
 * @param {{ fullTextChangedAt?: string|null }} [history] from git
 * @returns {{ value: string, source: string } | null}
 */
function chooseTextFetchedAt(data, history = {}) {
  if (!needsTextFetchedAtBackfill(data)) return null;
  const fromGit = validIso(history.fullTextChangedAt);
  if (fromGit) return { value: fromGit, source: 'git-fulltext-change' };
  for (const k of FALLBACK_FIELDS) {
    const v = validIso(data[k]);
    if (v) return { value: v, source: k };
  }
  return null;
}

/**
 * When did fullText become its current value? Walks the file's commits newest
 * first (`versions`: [{ at, fullText }] with fullText undefined when the file
 * did not parse / did not exist). Returns the time of the oldest consecutive
 * commit still holding the current text, but only when an older commit with a
 * different text (or the file's creation) proves that is where it changed;
 * a history that runs out first (shallow clone) gives null.
 * @param {string} currentText
 * @param {Array<{ at: string, fullText: string|undefined }>} versions newest first
 * @param {{ reachedCreation?: boolean }} [opts] the last entry is the commit that added the file
 */
function fullTextChangedAtFromVersions(currentText, versions, opts = {}) {
  let changedAt = null;
  for (const v of versions || []) {
    if (v.fullText === currentText) { changedAt = v.at; continue; }
    return changedAt; // an older, different text: the change is the commit after it
  }
  return opts.reachedCreation ? changedAt : null;
}

/**
 * Did the file walk really reach the commit that created the file? Only when
 * the walk saw fewer commits than it asked for, read every one of them, and
 * git found an adding commit. In a shallow clone that "adding" commit is the
 * graft at the clone boundary (a depth-1 CI checkout makes every file look
 * created at the clone commit), so a shallow repo never counts (BRO-5652).
 */
function creationReached({ commitCount, depth, versionsRead, addedCommitFound, shallow }) {
  if (shallow) return false;
  return commitCount < depth && versionsRead === commitCount && !!addedCommitFound;
}

/** Fields to write for a chosen value. */
function backfillFields(choice) {
  return { textFetchedAt: choice.value, textFetchedAtBackfill: choice.source };
}

module.exports = { needsTextFetchedAtBackfill, chooseTextFetchedAt, fullTextChangedAtFromVersions, creationReached, backfillFields, FALLBACK_FIELDS };
