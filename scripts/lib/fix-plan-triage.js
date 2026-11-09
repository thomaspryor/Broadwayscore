'use strict';
// BRO-7092: settle old data-fix plans. For each op a plan did not apply, say
// whether current data already matches what the op intended (resolved), the
// op no longer makes sense (obsolete), or the work is still needed.
//
// Pure functions: every data read goes through the `ctx` the caller builds
// (see scripts/triage-fix-plans.js). Nothing here returns review text: a
// verdict carries a short reason built from ids, file names, urls and
// booleans only.
const { EXCERPT_FIELDS } = require('./excerpt-fields.js');
const { runScriptArgs } = require('./run-script-args.js');

const RESOLVED = 'resolved';
const OBSOLETE = 'obsolete';
const STILL_NEEDED = 'still-needed';
const UNKNOWN = 'unknown'; // review texts were not available to decide

// A truthy value on one of these takes the review out of the counted set
// (reviews.json); a falsy value puts it back. What matters is whether the
// review is counted now, not the exact flag value.
const EXCLUSION_FLAGS = new Set([
  'wrongProduction', 'wrongShow', 'isNonReview', 'isRoundupArticle',
  'duplicateOf', 'isSyndicatedDuplicate', 'wrongAttribution',
]);

// Fields whose value may hold review prose; never echoed back. On review
// records no string is echoed unless it looks like an id, date or url
// (safeReviewValue): note fields like *Reason can quote the article.
const TEXT_FIELDS = new Set(['fullText', 'text', 'excerpt', 'body', 'pullQuote', 'llmPullQuote', ...EXCERPT_FIELDS]);
const ID_LIKE = /^[\w.\-:/@?=&%+#]{1,60}$/;

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true; // undefined and null both mean "unset"
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A short, safe rendering of a current value for a reason line. */
function show(value, field, { review = false } = {}) {
  if (field && TEXT_FIELDS.has(field)) return '(text)';
  if (review && typeof value === 'string' && !ID_LIKE.test(value)) return '(text)';
  if (review && value && typeof value === 'object') return '(object)';
  if (value === undefined) return 'unset';
  const s = JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

const verdict = (v, reason) => ({ verdict: v, reason });

/** Compare-and-set ops: new value in place, old value in place, or something else. */
function compareValues(current, a, label) {
  if (deepEqual(current, a.newValue)) return verdict(RESOLVED, `${label} already ${show(a.newValue, a.field)}`);
  if (deepEqual(current, a.oldValue)) return verdict(STILL_NEEDED, `${label} still ${show(current, a.field)}, plan wants ${show(a.newValue, a.field)}`);
  return verdict(OBSOLETE, `${label} changed since by a later write (now ${show(current, a.field)})`);
}

function classifyDataEdit(a, ctx) {
  if (a.file === 'commercial.json') {
    const entry = ctx.commercial(a.showSlug || a.showId);
    if (!entry) return verdict(OBSOLETE, `commercial entry ${a.showSlug || a.showId} no longer exists`);
    return compareValues(entry[a.field], a, `${a.showSlug || a.showId}.${a.field}`);
  }
  if (a.file && a.file !== 'shows.json') return verdict(STILL_NEEDED, `data-edit on ${a.file} has no rule; check by hand`);
  const s = ctx.show(a.showId);
  if (!s) return verdict(OBSOLETE, ctx.isRetired(a.showId) ? `show ${a.showId} was retired` : `show ${a.showId} no longer exists`);
  return compareValues(s[a.field], a, `${a.showId}.${a.field}`);
}

/** The review's show id from its review-texts path ("<show>/<file>.json"). */
const showOfPath = (p) => String(p || '').split('/')[0];

/**
 * A review file the op names is gone. If a file in the same show looks like a
 * rename of it (same stem plus a suffix), the edit may still be owed there.
 */
function missingFile(rel, ctx) {
  const show = showOfPath(rel);
  const stem = String(rel).split('/').pop().replace(/\.json$/, '');
  const renamed = (ctx.showFiles ? ctx.showFiles(show) : []).filter((f) => f !== `${stem}.json` && f.startsWith(stem));
  if (renamed.length) return verdict(STILL_NEEDED, `${rel} is gone but ${show}/${renamed[0]} looks like a rename; check by hand`);
  return verdict(OBSOLETE, `review file ${rel} no longer exists and nothing in ${show} looks like a rename`);
}

function classifyReviewFieldEdit(a, ctx) {
  if (!ctx.hasReviewTexts) return verdict(UNKNOWN, 'needs review texts');
  const rec = ctx.reviewFile(a.file);
  if (!rec) return missingFile(a.file, ctx);
  const label = `${a.file} ${a.field}`;
  const current = rec[a.field];
  const sv = (v) => show(v, a.field, { review: true });
  if (deepEqual(current, a.newValue)) return verdict(RESOLVED, `${label} already ${sv(a.newValue)}`);

  if (EXCLUSION_FLAGS.has(a.field)) {
    const counted = ctx.isCounted(showOfPath(a.file), rec);
    const wantsExcluded = Boolean(a.newValue);
    if (wantsExcluded && !counted) return verdict(RESOLVED, `${a.file} is already out of the score (not in reviews.json)`);
    if (!wantsExcluded && counted) return verdict(RESOLVED, `${a.file} is already counted (in reviews.json)`);
    if (wantsExcluded && a.field === 'duplicateOf' && typeof a.newValue === 'string') {
      const targetPath = a.newValue.includes('/') ? a.newValue : `${showOfPath(a.file)}/${a.newValue}`;
      const target = ctx.reviewFile(targetPath);
      if (!target) return verdict(OBSOLETE, `duplicate target ${targetPath} no longer exists, so ${a.file} is the only copy`);
      if (!ctx.isCounted(showOfPath(targetPath), target)) return verdict(OBSOLETE, `duplicate target ${targetPath} is not counted, so ${a.file} is not double-counted`);
      // Two files with the same url share one reviews.json key: both look
      // counted though the rebuild kept only one row.
      if (ctx.sameReview(showOfPath(a.file), rec, target) && ctx.countedEntries(showOfPath(a.file), rec) < 2) {
        return verdict(RESOLVED, `${a.file} and ${targetPath} share one counted row, so nothing is double-counted`);
      }
      return verdict(STILL_NEEDED, `${a.file} and ${targetPath} are both counted (double-counted)`);
    }
    return verdict(STILL_NEEDED, wantsExcluded
      ? `${a.file} is still counted; plan wanted ${a.field}=${sv(a.newValue)}`
      : `${a.file} is still out of the score; plan wanted ${a.field} cleared`);
  }

  // Old value still in place: the write never happened. This covers the
  // behaviour-changing pins too (nonReviewManualClear, wrongProductionManualClear).
  if (deepEqual(current, a.oldValue)) return verdict(STILL_NEEDED, `${label} still ${sv(current)}, plan wants ${sv(a.newValue)}`);
  return verdict(OBSOLETE, `${label} changed since by a later write (now ${sv(current)})`);
}

function classifyReviewFileOp(a, ctx) {
  if (!ctx.hasReviewTexts) return verdict(UNKNOWN, 'needs review texts');
  const src = a.sourcePath ? ctx.reviewFile(a.sourcePath) : null;
  const srcCounted = Boolean(src) && ctx.isCounted(showOfPath(a.sourcePath), src);
  if (a.operation === 'delete') {
    if (!src) return verdict(RESOLVED, `${a.sourcePath} is already gone`);
    if (!srcCounted) return verdict(OBSOLETE, `${a.sourcePath} exists but is not counted, so it does no harm`);
    return verdict(STILL_NEEDED, `${a.sourcePath} still exists and is counted`);
  }
  if (a.operation === 'restore') {
    const restored = ctx.reviewFile(a.destPath || a.sourcePath);
    if (restored) return verdict(RESOLVED, `${a.destPath || a.sourcePath} exists`);
    return verdict(STILL_NEEDED, `${a.destPath || a.sourcePath} is still missing`);
  }
  // move / rename
  const dest = a.destPath ? ctx.reviewFile(a.destPath) : null;
  if (!src && dest) return verdict(RESOLVED, `${a.sourcePath} is gone and ${a.destPath} exists`);
  if (!src && !dest) return missingFile(a.sourcePath, ctx);
  if (!a.destPath) {
    return srcCounted ? verdict(STILL_NEEDED, `${a.sourcePath} is still counted and the plan had no destPath`)
      : verdict(OBSOLETE, `${a.sourcePath} is not counted and the plan had no destPath`);
  }
  // A misfiled review is usually flagged (so not counted) under the wrong
  // show; the move is what files it under the right one. Dest missing means
  // the right show still lacks it, counted or not.
  if (!dest) return verdict(STILL_NEEDED, `${a.sourcePath} still in place, ${a.destPath} missing`);
  if (!srcCounted) return verdict(OBSOLETE, `${a.destPath} exists and ${a.sourcePath} is not counted, so nothing is double-counted`);
  const sameShow = showOfPath(a.sourcePath) === showOfPath(a.destPath);
  return verdict(STILL_NEEDED, sameShow
    ? `${a.sourcePath} and ${a.destPath} both exist and the source is counted`
    : `${a.sourcePath} is still counted under ${showOfPath(a.sourcePath)}; ${a.destPath} already exists`);
}

/** --show=X --url=Y out of a run-script args string. */
function parseArgs(args) {
  const out = {};
  const re = /--([a-z-]+)(?:=("[^"]*"|'[^']*'|\S+))?/gi;
  let m;
  while ((m = re.exec(String(args || '')))) out[m[1]] = m[2] === undefined ? true : m[2].replace(/^["']|["']$/g, '');
  return out;
}

function classifyIngest(showId, url, ctx) {
  if (!showId || !url) return verdict(STILL_NEEDED, 'ingest op has no show or url; check by hand');
  if (!ctx.show(showId)) return verdict(OBSOLETE, ctx.isRetired(showId) ? `show ${showId} was retired` : `show ${showId} no longer exists`);
  if (ctx.isUrlCounted(showId, url)) return verdict(RESOLVED, `${url} is counted for ${showId}`);
  if (!ctx.hasReviewTexts) return verdict(UNKNOWN, 'needs review texts');
  const file = ctx.reviewFileForUrl(showId, url);
  if (file) {
    const rec = ctx.reviewFile(file);
    // A failed ingest files a retry stub carrying the url (BRO-4431): not the review.
    if (!rec || rec.contentTier === 'stub' || rec.contentTier === 'invalid' || rec.submissionRetry || !rec.fullText) {
      return verdict(STILL_NEEDED, `${url} has only a stub on file for ${showId} (${file}); re-ingest`);
    }
    return verdict(RESOLVED, `${url} is on file for ${showId} (${file}) with text, out of the score by its flags`);
  }
  return verdict(STILL_NEEDED, `${url} is not on file for ${showId}; re-ingest`);
}

function classifyRunScript(a, ctx) {
  const script = String(a.script || '').replace(/^(\.\/)?scripts\//, '');
  const given = runScriptArgs(a);
  if (script === 'ingest-review-from-url.js' && given.ok) {
    const args = parseArgs(Array.isArray(a.args || a.arguments) ? (a.args || a.arguments).join(' ') : given.args);
    return classifyIngest(args.show, args.url, ctx);
  }
  if (given.ok && (script === 'restore-released-quarantined-body.js' || script === 'copy-multishow-section.js')) {
    if (!ctx.hasReviewTexts) return verdict(UNKNOWN, 'needs review texts');
    const args = parseArgs(given.args);
    const hasText = (rec) => Boolean(rec && rec.fullText && rec.contentTier !== 'stub' && rec.contentTier !== 'invalid');
    if (script === 'restore-released-quarantined-body.js') {
      const rec = ctx.reviewFile(args.file);
      if (!rec) return missingFile(String(args.file), ctx);
      return hasText(rec) ? verdict(RESOLVED, `${args.file} has its body back`) : verdict(STILL_NEEDED, `${args.file} still has no body`);
    }
    // copy-multishow-section: the --to-show copy is filed under the source's file name.
    const target = `${args['to-show']}/${String(args.from || '').split('/').pop()}`;
    if (!ctx.show(args['to-show'])) return verdict(OBSOLETE, `show ${args['to-show']} no longer exists`);
    return hasText(ctx.reviewFile(target)) ? verdict(RESOLVED, `${target} exists with text`) : verdict(STILL_NEEDED, `${target} is missing or has no text`);
  }
  return verdict(STILL_NEEDED, `run-script ${script} failed; check by hand`);
}

function classifyAddShow(a, ctx) {
  const id = a.show && a.show.id || a.id || a.showId;
  if (id && ctx.show(id)) return verdict(RESOLVED, `show ${id} exists`);
  if (id && ctx.isRetired(id)) return verdict(OBSOLETE, `show ${id} was retired`);
  return verdict(STILL_NEEDED, `show ${id || '(no id)'} does not exist`);
}

function classifyAddCommercial(a, ctx) {
  const slug = a.showSlug || a.showId || a.slug;
  const entry = slug && ctx.commercial(slug);
  if (!entry) return verdict(STILL_NEEDED, `commercial entry ${slug} does not exist`);
  const fields = a.entry || a.data || {};
  const differs = Object.keys(fields).filter((k) => !deepEqual(entry[k], fields[k]));
  if (!differs.length) return verdict(RESOLVED, `commercial entry ${slug} exists with the planned values`);
  return verdict(OBSOLETE, `commercial entry ${slug} exists (made another way; differs on ${differs.slice(0, 4).join(', ')})`);
}

function classifyRetireShow(a, ctx) {
  const id = a.showId || a.id;
  if (ctx.isRetired(id) || !ctx.show(id)) return verdict(RESOLVED, `show ${id} is retired or gone`);
  return verdict(STILL_NEEDED, `show ${id} is still live`);
}

/** One op of a plan. */
function classifyOp(a, ctx) {
  if (!a || typeof a !== 'object') return verdict(OBSOLETE, 'malformed op');
  switch (a.type) {
    case 'data-edit': return classifyDataEdit(a, ctx);
    case 'review-field-edit': return classifyReviewFieldEdit(a, ctx);
    case 'review-file-op': return classifyReviewFileOp(a, ctx);
    case 'run-script': return classifyRunScript(a, ctx);
    case 'ingest-html-handoff': return classifyIngest(a.showId, a.url, ctx);
    case 'add-show': return classifyAddShow(a, ctx);
    case 'add-commercial-entry': return classifyAddCommercial(a, ctx);
    case 'retire-show': return classifyRetireShow(a, ctx);
    default: return verdict(STILL_NEEDED, `op type ${a.type} has no rule; check by hand`);
  }
}

/**
 * Every op a plan left undone: for a partial / validation-failed plan the ops
 * whose result is not ok, for a pending plan every op. A result that is not ok
 * but reports "applied, but the write guard also changed ..." is still judged
 * on current data like the rest.
 */
function undoneOps(plan) {
  const actions = (plan && plan.plan && Array.isArray(plan.plan.actions)) ? plan.plan.actions : [];
  const results = Array.isArray(plan && plan.results) ? plan.results : [];
  return actions
    .map((a, i) => ({ i, a, r: results[i] }))
    // validation-failed: the executor rolled every edit back but kept the
    // per-op results, ok:true included (execute-approved-fix.js), so all are undone.
    .filter(({ r }) => plan.status === 'pending' || plan.status === 'validation-failed' || !r || r.ok !== true);
}

/** Verdict for a whole plan: still-needed wins, then unknown, then obsolete, else resolved. */
function classifyPlan(plan, ctx) {
  const ops = undoneOps(plan).map(({ i, a }) => ({ i, ...classifyOp(a, ctx) }));
  const has = (v) => ops.some((o) => o.verdict === v);
  const overall = has(STILL_NEEDED) ? STILL_NEEDED : has(UNKNOWN) ? UNKNOWN : has(OBSOLETE) ? OBSOLETE : RESOLVED;
  const counts = {};
  for (const o of ops) counts[o.verdict] = (counts[o.verdict] || 0) + 1;
  return { verdict: overall, counts, ops };
}

module.exports = {
  RESOLVED, OBSOLETE, STILL_NEEDED, UNKNOWN, EXCLUSION_FLAGS,
  deepEqual, parseArgs, classifyOp, classifyPlan, undoneOps,
};
