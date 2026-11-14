'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

const GENRE_FILE = 'src/config/genre-tags.json';

// Replay only this run's additions/updates. Fresh main wins if another writer
// changed or deleted the same show's tags since the lost commit's parent.
function mergeGenreTags(base, lost, current) {
  const merged = { ...current };
  for (const [id, tags] of Object.entries(lost)) {
    if (isDeepStrictEqual(tags, base[id])) continue;
    if (Object.hasOwn(current, id) === Object.hasOwn(base, id)
        && isDeepStrictEqual(current[id], base[id])) merged[id] = tags;
  }
  return merged;
}

// Called before the redo regenerates the mobile index. Reuse the paid results
// from the lost commit, rather than asking the genre tagger's LLM again.
function replayGenreTags(lostCommit, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const readAt = rev => git(['ls-tree', rev, '--', GENRE_FILE]).trim()
    ? JSON.parse(git(['show', `${rev}:${GENRE_FILE}`])) : {};
  const base = readAt(`${lostCommit}^`);
  const lost = readAt(lostCommit);
  const current = readAt('HEAD');
  const merged = mergeGenreTags(base, lost, current);
  const changed = Object.keys(merged).filter(id => !isDeepStrictEqual(merged[id], current[id]));
  if (changed.length) {
    const file = path.join(cwd, GENRE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged) + '\n');
  }
  console.log(`[rebuild-fast-replay-genres] restored ${changed.length} genre records; no LLM calls`);
  return changed;
}

module.exports = { mergeGenreTags, replayGenreTags };
