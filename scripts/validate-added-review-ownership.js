#!/usr/bin/env node
/**
 * validate-added-review-ownership.js — post-rebase cross-show ownership gate
 * for the push-review-texts action (Notion 39b637c5-416f-8134).
 *
 * Closes the stale-checkout race that Guard I (review-file-writer.js) and the
 * gather-reviews cross-production check cannot see: a CI writer checks out
 * review-texts BEFORE a manual cross-show move lands, its in-process guards
 * validate against that stale snapshot, and it re-creates a URL that the
 * post-move corpus assigns to a sibling show. Observed 2026-07-10 13:36 UTC —
 * the opening-night poller re-created tender-off-west-end-2026/
 * thestage--dave-fargnoli.json 6 minutes after the tender disambiguation push
 * (creation commit 65159277b5b in broadway-review-texts).
 *
 * PLACEMENT (load-bearing): runs inside the push action's retry loop, AFTER a
 * successful `git pull --rebase origin main` and BEFORE `git push` — the only
 * point where the tree reflects current remote ownership. The action's
 * initial pre-stage pull is `|| true` and silently no-ops whenever tracked
 * files are dirty (the common case), so a gate there would validate a stale
 * tree. The rebase conflict resolver is a second re-creation path this
 * placement covers: on a delete/modify conflict (remote moved the file away,
 * our run wrote to it) it keeps "ours" whenever our fullText is longer than
 * the deleted side's 0 — resurrecting the moved file.
 *
 * Mode --base=<ref>: files ADDED between <ref> and HEAD (git diff
 * --diff-filter=A) are checked against the working-tree ownership index; each
 * violator is `git rm`'d and the drops are committed. Modified-in-place files
 * are the URL-change invariant's territory, not creation ownership.
 *
 * Without --base: validates UNTRACKED/staged-new files and deletes violators
 * from the working tree (pre-commit usage, e.g. local runs).
 *
 * Fail-open by design: a validator crash must never block a data push (the
 * action invokes it with a non-blocking `|| echo ::warning::`). Per-file
 * parse errors skip the file.
 *
 * Residual window: a cross-show move landing between this check and the
 * `git push` (seconds) can still race; guards + wrongShow tombstones make
 * that damage self-healing, and the next push's gate removes re-creations.
 *
 * Usage (cwd = review-texts repo):
 *   node ../../scripts/validate-added-review-ownership.js --base=origin/main [--dry-run]
 *   node ../../scripts/validate-added-review-ownership.js [--dry-run]
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { normalizeCritic, canonicalArticleKey } = require('./lib/review-normalization');
const { SUBSTANTIVE_BODY_CHARS, NEAR_EMPTY_BODY_CHARS } = require('./lib/review-write-guard');

const USAGE = `validate-added-review-ownership.js — post-rebase cross-show ownership gate.

Usage:
  node scripts/validate-added-review-ownership.js [options]
  node scripts/validate-added-review-ownership.js --help, -h    print this usage and exit
`;
const { multiShowSplitGroup } = require('./lib/multi-show-split-group');
const {
  findCrossShowOwners,
  shouldBlockCrossShowCreate,
  _resetUrlOwnershipIndex,
  _isLiveSameShowCopy,
  _isOwnableUrl,
} = require('./lib/url-ownership');

// Shared with the API push fallback's review-texts disqualifier (BRO-5589),
// which leaves every ADDED review file to this gate.
const { isReviewFilePath } = require('./lib/review-texts-api-fallback');

/**
 * Files ADDED between base and HEAD (committed — the retry-loop mode).
 * --no-renames is load-bearing: with rename detection (default-on), a commit
 * that deletes any structurally similar JSON (dedup cleanup, byline-rename
 * source) alongside the violator gets the pair reported as R, not A — the
 * gate would never see the violator in exactly the incident class it exists
 * for. A same-show rename destination surfacing as A is harmless (same-show
 * owners are excluded from cross-show lookup). maxBuffer raised: bulk imports
 * add thousands of files and the 1MB default would throw → fail-open → the
 * largest pushes get the least protection.
 */
function listAddedReviewFiles(cwd, base) {
  const out = execSync(`git diff --no-renames --diff-filter=A --name-only ${base} HEAD`, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((l) => l.trim()).filter(isReviewFilePath);
}

/**
 * Urls of review files with text DELETED between base and HEAD, read from base. A file
 * added under one of these urls in the same diff is a move (review-file-op
 * move, rename, re-home), never a stale re-creation: dropping it while the
 * delete goes through loses the review (BRO-5373, broadwayworld--kat-mokrynski
 * moved to the Apollo 2025 show, 2026-10-14).
 */
function listDeletedReviewUrls(cwd, base) {
  const out = execSync(`git diff --no-renames --diff-filter=D --name-only ${base} HEAD`, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const keys = new Set();
  for (const rel of out.split('\n').map((l) => l.trim()).filter(isReviewFilePath)) {
    try {
      const data = JSON.parse(execSync(`git show "${base}:${rel}"`, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      // Only a deleted file that carried a review is a move source. A text-less
      // stub deleted beside a re-creation is the --no-renames violator case.
      if (!data || String(data.fullText || '').trim().length < NEAR_EMPTY_BODY_CHARS) continue;
      const key = data.url ? canonicalArticleKey(data.url) : null;
      if (key) keys.add(key);
    } catch { /* unreadable at base: nothing to protect */ }
  }
  return keys;
}

/**
 * NEW review files (untracked or staged-added) relative to HEAD — pre-commit
 * mode. `-uall` is required: a brand-new show directory otherwise reports as
 * one `?? show-dir/` entry and every file inside it would be missed.
 */
function listNewReviewFiles(cwd) {
  const out = execSync('git status --porcelain -uall', {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2);
    if (status !== '??' && status[0] !== 'A') continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (isReviewFilePath(rel)) files.push(rel);
  }
  return files;
}

/**
 * Pure decision: which of the given new files violate cross-show URL
 * ownership and must be dropped. Mirrors Guard I:
 *   - drop when another show holds the URL live (unflagged, non-roundup)
 *   - keep when every cross-show copy is flagged (legitimate re-home)
 *   - keep on the file's own allowCrossShowUrl:true escape hatch
 *   - never drop human-vouched work (humanReviewScore / _locked)
 *
 * @param {string[]} newFiles  repo-relative paths like 'show-id/outlet--critic.json'
 * @param {string} reviewTextsDir  absolute path to the review-texts checkout
 * @returns {Array<{file:string, showId:string, url:string, owner:{showId:string,file:string}}>}
 */
/**
 * Share of `a`'s 8-word phrases that also appear in `b` (0..1), diacritics
 * folded. A multi-show print column (one url, a section per show) gives each
 * show's file a different text; a stale re-creation of the same review gives
 * the same text (BRO-5373: the gate dropped 19 such sections, e.g. Letts's
 * Jack Absolute / Much Ado Times column).
 */
const { foldDiacritics } = require('./lib/title-match');
function sharedPhraseRatio(a, b) {
  const words = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const shingles = (w) => { const out = new Set(); for (let i = 0; i + 8 <= w.length; i++) out.add(w.slice(i, i + 8).join(' ')); return out; };
  const sa = shingles(words(a));
  if (sa.size === 0) return 1;
  const sb = shingles(words(b));
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit / sa.size;
}
const DISTINCT_SECTION_MAX_SHARE = 0.5;

function decideOwnershipDrops(newFiles, reviewTextsDir) {
  const drops = [];
  const showIndexCache = new Map();
  for (const rel of newFiles) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, rel), 'utf8'));
    } catch {
      continue; // deleted or unparseable — not this gate's problem
    }
    if (!data || typeof data !== 'object') continue;
    if (data.humanReviewScore != null || data._locked === true) continue;
    const showId = rel.split('/')[0];
    // allowCrossShowUrl waives only the cross-show check; a same-show re-creation
    // below is still a duplicate (BRO-4834 review).
    const owners = data.allowCrossShowUrl === true ? [] : findCrossShowOwners(data.url, showId, reviewTextsDir);
    // BRO-4431: sibling sections of one split multi-show article share its URL.
    const verdict = shouldBlockCrossShowCreate(owners, multiShowSplitGroup(data, showId), showId);
    if (verdict.block) {
      // A different text under the same url is another show's section of a
      // multi-show article, not a re-creation of the owner's review (BRO-5373).
      let ownerText = '';
      try { ownerText = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, verdict.owner.showId, verdict.owner.file), 'utf8')).fullText || ''; } catch { /* unreadable owner: keep the drop decision */ }
      const mine = String(data.fullText || '');
      if (mine.trim().length >= NEAR_EMPTY_BODY_CHARS && String(ownerText).trim().length >= NEAR_EMPTY_BODY_CHARS
          && sharedPhraseRatio(mine, ownerText) < DISTINCT_SECTION_MAX_SHARE) {
        console.log(`::warning::[ownership-gate] keeping ${rel}: same url as ${verdict.owner.showId}/${verdict.owner.file} but a different text (multi-show article section)`);
        continue;
      }
      drops.push({ file: rel, showId, url: data.url, owner: verdict.owner, kind: 'cross-show' });
      continue;
    }

    // SAME-SHOW sibling (BRO-3092). findCrossShowOwners is cross-show BY
    // CONSTRUCTION — url-ownership.js filters `e.showId !== currentShowId`, and
    // that filter is load-bearing for Guard I, so it must not be relaxed. The
    // consequence is that this gate was blind to the identical race within one
    // show, which is the one that actually reddened Data Validation:
    //
    //   2026-09-08. the-addams-family-2010/wsj--unknown.json was deleted as
    //   worthless (its 6.6KB "fullText" is a WSJ registration interstitial) and
    //   pushed at 14:50Z. enrich-reviews had already stamped that file's
    //   classifiedAt at 14:46Z, so its runner held the file DIRTY; the push
    //   action's `git pull --rebase --autostash` restored it and `git add -A`
    //   staged it as an ADD, re-creating a same-URL duplicate of
    //   wsj--terry-teachout.json 29 minutes after the delete. Deleting a
    //   worthless review file simply did not stay deleted.
    //
    // Same race, same remedy: this gate already holds exactly the ADDED-file
    // set at push time and already git-rm's violators. The incumbent sibling is
    // by definition not in `newFiles`, so the survivor is the file that was
    // already on origin — never the re-creation.
    // SAME-SHOW sibling (BRO-3092), a second question asked only after the
    // cross-show verdict came back clean.
    //
    // Ownable-url gate FIRST, mirroring the cross-show branch. url-ownership.js
    // warns that indexing junk urls "would make Guard I skip entire reviews
    // over junk"; here the penalty is DELETION, so a critic-profile href or an
    // outlet homepage shared by two records must never read as a collision.
    if (!_isOwnableUrl(data.url)) continue;

    const selfFile = rel.split('/').slice(1).join('/');
    const siblings = sameShowUrlSiblings(reviewTextsDir, showId, data.url, selfFile, showIndexCache);
    if (siblings.length === 0) continue;

    // DELIBERATELY NARROW: only the UNKNOWN-BYLINE loser is dropped, and only
    // when a LIVE, NAMED sibling holds the same url.
    //
    // This gate deletes files, so three separate conditions all have to hold:
    //
    //  1. The added file's byline is unnamed. Two NAMED critics at one url is
    //     the ambiguous class dedupe-same-url-bylines.js refuses to collapse
    //     ("collapsing would DROP a real review") — left for adjudication.
    //  2. Some sibling is NAMED. Scanning ALL siblings matters: the first
    //     readdir hit may itself be unknown-byline, and accepting only that one
    //     made a three-file cluster silently drop nothing (readdir order also
    //     is not guaranteed, so the gate was nondeterministic).
    //  3. That named sibling is LIVE — _isLiveSameShowCopy: the cross-show
    //     branch's predicate, plus a combined/split-parent copy that is
    //     includable in this show (BRO-5198: the Addams split parent read as
    //     dead and the duplicate came back). Without it, deleting the added file when the
    //     only other copy is wrongProduction-flagged leaves the show with no
    //     includable record for that url, and every later re-collection is
    //     deleted again: a self-perpetuating black hole. wrongProduction runs
    //     ~15% false-positive (memory/feedback_llm_wrongprod_false_positives),
    //     so that is not hypothetical.
    if (normalizeCritic(data.criticName) !== 'unknown') continue;
    const liveNamed = siblings.find(
      (sib) => normalizeCritic(sib.data.criticName) !== 'unknown'
        && _isLiveSameShowCopy(sib.data, showId, path.join(reviewTextsDir, showId, sib.file)),
    );
    if (!liveNamed) continue;

    // CONTENT-RICHNESS GUARD (BRO-3249 hardening, adversarial review finding).
    // Widening this branch to normalizeUrl-equivalent siblings (above) pulls in
    // real corpus files this branch could never previously reach — e.g.
    // charlie-and-the-chocolate-factory-2017/wsj--unknown.json, which carries a
    // substantive 4.4KB fullText while its named sibling wsj--edward-rothstein
    // .json has none. review-write-guard.js's own write-time duplicate call
    // (shouldMarkUrlCollisionDuplicate) never marks a collision when the new
    // file clears SUBSTANTIVE_BODY_CHARS and the collider is under
    // NEAR_EMPTY_BODY_CHARS — this mirrors that same threshold so the push-time
    // gate can never delete a record the write-time guard would have kept
    // primary. Deliberately NOT gated on data.duplicateOf being present/absent:
    // the original BRO-3092 incident (enrich-reviews stale-checkout replay)
    // never carries that field, so requiring it would blind this branch to the
    // very case it was built for.
    const addedLen = String(data.fullText || '').trim().length;
    const siblingLen = String(liveNamed.data.fullText || '').trim().length;
    if (addedLen >= SUBSTANTIVE_BODY_CHARS && siblingLen < NEAR_EMPTY_BODY_CHARS) continue;

    drops.push({
      file: rel,
      showId,
      url: data.url,
      owner: { showId, file: liveNamed.file },
      kind: 'same-show',
    });
  }
  return drops;
}

/**
 * Every OTHER file in `showId` whose url matches `url`, via a per-show index
 * built once per decideOwnershipDrops call.
 *
 * The cross-show branch gets a corpus-wide cached index (buildUrlOwnershipIndex);
 * this had been a fresh readdir + JSON.parse of the whole show dir per candidate,
 * which on the bulk-import case listAddedReviewFiles' own comment calls out
 * ("thousands of files") is N x M parses inside the push retry loop.
 */
function sameShowUrlSiblings(reviewTextsDir, showId, url, selfFile, cache) {
  // canonicalArticleKey (BRO-5321; normalizeUrl before it, BRO-3249), NOT sameUrlKey: this branch's own writer-side
  // counterpart — review-write-guard.js's checkUrlCollision, which is what
  // stamps duplicateOf on exactly the files this gate is supposed to catch —
  // identifies "same URL" via that same key (strips scheme + www, not just
  // lowercase + fragment + trailing slash). The cross-show branch above
  // (findCrossShowOwners -> url-ownership.js) already uses normalizeUrl too;
  // this branch used the weaker validate-data.js key instead, so it silently
  // agreed with neither. That mismatch is why the 3rd resurrection of
  // the-addams-family-2010/wsj--unknown.json (2026-09-13, via
  // scrape-dtli-show-score.yml, not the historically-blamed enrich-reviews)
  // sailed through: the DTLI extractor wrote http://online.wsj.com/... via
  // the shared write-guard path, which correctly matched it to the incumbent
  // https://online.wsj.com/... wsj--terry-teachout.json and marked it
  // duplicateOf — but this lookup, keyed on the un-normalized scheme, saw
  // zero same-show siblings and returned before the criticName check ever
  // ran. Not a byline-detection gap (criticName here was null, which
  // normalizeCritic already treats as 'unknown') — a URL-identity mismatch
  // between the writer and this gate.
  const key = canonicalArticleKey(url);
  if (!key) return [];
  let byUrl = cache.get(showId);
  if (!byUrl) {
    byUrl = new Map();
    const showDir = path.join(reviewTextsDir, showId);
    let files = [];
    try {
      files = fs.readdirSync(showDir).filter((f) => isReviewTextFile(f));
    } catch { /* no dir — nothing to collide with */ }
    for (const f of files) {
      let d;
      try {
        d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      } catch { continue; }
      const k = canonicalArticleKey(d && d.url);
      if (!k) continue;
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push({ file: f, data: d });
    }
    cache.set(showId, byUrl);
  }
  return (byUrl.get(key) || []).filter((e) => e.file !== selfFile);
}

// Mirrors scripts/lib/detect-stale-merge-head.sh's STALE_MERGE_HEAD_WARN_SEC
// default (BRO-142). Not sourced from there — this is JS, that's bash — but
// the intent must stay in sync: past this age, a MERGE_HEAD is no longer
// "a normal in-progress op", it's the #916/#1279/#1445 leftover-marker class.
const STALE_MERGE_HEAD_WARN_SEC = 1800;

/**
 * True when a rebase/merge/cherry-pick is in progress. The action's
 * post-conflict call site can reach the gate after `git rebase --continue ||
 * true` left the rebase UNFINISHED (second conflict); committing drops onto
 * that detached HEAD is pointless (the loop aborts the rebase on push
 * failure) and mid-rebase diffs are unreliable — skip and let the next
 * attempt's fully-rebased tree re-run the gate.
 *
 * Also flags whether the marker found is a STALE MERGE_HEAD (BRO-142): before
 * this, a leftover MERGE_HEAD from a dead session made this gate skip and
 * exit 0 forever, identically to a genuine few-seconds-old in-progress merge
 * — CI stayed green while ownership validation silently never ran, with no
 * signal distinguishing "normal, retry next attempt" from "stuck for days".
 * Still never fails the build or touches git state — detection only, same as
 * every other BRO-142 call site.
 */
function gitOpInProgress(cwd) {
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    try {
      const p = execSync(`git rev-parse --git-path ${marker}`, { cwd, encoding: 'utf8' }).trim();
      const resolved = path.resolve(cwd, p);
      if (!fs.existsSync(resolved)) continue;
      let stale = false;
      if (marker === 'MERGE_HEAD') {
        try {
          const ageSec = (Date.now() - fs.statSync(resolved).mtimeMs) / 1000;
          stale = ageSec >= STALE_MERGE_HEAD_WARN_SEC;
        } catch { /* stat failure → treat as not stale, still in-progress */ }
      }
      return { inProgress: true, marker, stale };
    } catch { /* rev-parse failure → treat as not in progress */ }
  }
  return { inProgress: false, marker: null, stale: false };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  const baseArg = process.argv.find((a) => a.startsWith('--base='));
  const base = baseArg ? baseArg.split('=')[1] : null;
  const cwd = process.cwd();

  const gitOp = base ? gitOpInProgress(cwd) : { inProgress: false };
  if (gitOp.inProgress) {
    if (gitOp.stale) {
      console.log(`::warning::[ownership-gate] STALE ${gitOp.marker} (>=${STALE_MERGE_HEAD_WARN_SEC}s old, BRO-142 class) — skipping, but this looks like a leftover from a dead session, not a normal in-progress merge. Ownership validation will not run until it's resolved: git -C ${cwd} status`);
    } else {
      console.log(`::warning::[ownership-gate] ${gitOp.marker} in progress — skipping (next attempt re-runs the gate on the completed tree)`);
    }
    return;
  }

  const candidates = base ? listAddedReviewFiles(cwd, base) : listNewReviewFiles(cwd);
  if (candidates.length === 0) {
    console.log('[ownership-gate] no new review files — nothing to validate');
    return;
  }
  // Force a fresh index: the whole point is validating against the
  // just-rebased tree, never a cached snapshot.
  _resetUrlOwnershipIndex();
  let drops = decideOwnershipDrops(candidates, cwd);
  if (base && drops.length) {
    const moved = listDeletedReviewUrls(cwd, base);
    const kept = drops.filter((d) => moved.has(canonicalArticleKey(d.url)));
    for (const d of kept) console.log(`::warning::[ownership-gate] keeping ${d.file}: its url was deleted elsewhere in this push, so it is a move, not a re-creation`);
    drops = drops.filter((d) => !kept.includes(d));
  }
  if (drops.length === 0) {
    console.log(`[ownership-gate] ${candidates.length} new file(s) — all pass cross-show + same-show URL ownership`);
    return;
  }
  for (const d of drops) {
    const where = d.kind === 'same-show'
      ? `a sibling in the same show (${d.owner.file})`
      : `${d.owner.showId}/${d.owner.file}`;
    // ::error:: so a drop is never silent (BRO-5373); the step still exits 0.
    console.log(`::error::[ownership-gate] dropping ${d.file} — URL is live at ${where} (stale-checkout race): ${d.url}`);
    if (process.env.GITHUB_STEP_SUMMARY && !dryRun) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ownership-gate dropped \`${d.file}\` (url live at ${where})\n`); } catch { /* summary is best-effort */ }
    }
    if (dryRun) continue;
    if (base) {
      execSync(`git rm -f -q -- "${d.file}"`, { cwd });
    } else {
      try { fs.unlinkSync(path.join(cwd, d.file)); } catch (e) {
        console.log(`::warning::[ownership-gate] could not delete ${d.file}: ${e.message}`);
      }
    }
  }
  if (base && !dryRun) {
    const _ss = drops.filter(d => d.kind === 'same-show').length;
    const _msg = _ss === 0
      ? `ownership-gate: drop ${drops.length} cross-show re-creation(s) (stale-checkout race)`
      : `ownership-gate: drop ${drops.length} URL re-creation(s) (${drops.length - _ss} cross-show + ${_ss} same-show, stale-checkout race)`;
    execSync(`git commit -q -m "${_msg}"`, { cwd });
  }
  console.log(`[ownership-gate] dropped ${drops.length}/${candidates.length} new file(s)${dryRun ? ' (dry-run — not deleted)' : ''}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Fail open: log loudly, exit 0 — a validator bug must not block data pushes.
    // --strict (push-rescue.js replay, BRO-6615): exit 2 instead, so restores
    // are never pushed unchecked.
    console.log(`::warning::[ownership-gate] validator error (non-blocking): ${e.message}`);
    if (process.argv.includes('--strict')) process.exitCode = 2;
  }
}

module.exports = { decideOwnershipDrops, listNewReviewFiles, listAddedReviewFiles, listDeletedReviewUrls, sharedPhraseRatio };
