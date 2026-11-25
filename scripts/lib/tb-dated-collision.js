'use strict';
/**
 * tb-dated-collision.js (BRO-8209 follow-up) — resolve Talkin' Broadway dated-page collisions
 * from TB's own index.
 *
 * TB posts several Off Broadway reviews on one date at page/ob/MM_DD_YY.html, MM_DD_YYa.html,
 * b, c. When two shows' review files hold the SAME dated url, one of them points at the
 * other's page. TB's index (ob/past.html) lists "<title> - M/D/YY" -> url, so it says which
 * show owns which page. A repair is planned only when the index proves it:
 *   - the file's show is listed on the index at a DIFFERENT same-day page (a/b/c sibling),
 *   - the file's current page is listed on the index under ANOTHER colliding show's title,
 *   - that destination page is listed under exactly this show's title, and no other show in the
 *     group shares the title (two productions of one show, e.g. Going Bacharach, are left alone).
 * Anything else is reported as unresolved, never guessed.
 */
const { normalizeTitle, normalizeTbUrl } = require('./talkinbroadway-index');
const { tbDatedPage } = require('./review-slot-guards');

const pageKey = (p) => `${p.date}${p.suffix}`;

/**
 * @param {{url:string,title:string}[]} indexEntries  index rows (title -> url)
 * @param {{showId:string,file:string,url:string,flagged?:boolean}[]} files  talkinbroadway review files
 * @param {{id:string,title:string}[]} shows
 * @returns {{repairs:{showId:string,file:string,from:string,to:string,evidence:string}[], unresolved:{url:string,showIds:string[],why:string}[]}}
 */
function planTbDatedCollisionRepairs(indexEntries, files, shows) {
  const titleOf = new Map((shows || []).map((s) => [s.id, normalizeTitle(s.title)]));
  // index: normalized title -> Set of urls on that date, and url -> Set of normalized titles
  const urlsByTitle = new Map();
  const titlesByUrl = new Map();
  for (const e of indexEntries || []) {
    const url = normalizeTbUrl(e && e.url);
    const t = normalizeTitle(e && e.title);
    if (!url || !t || !tbDatedPage(url)) continue;
    if (!urlsByTitle.has(t)) urlsByTitle.set(t, new Set());
    urlsByTitle.get(t).add(url);
    if (!titlesByUrl.has(url)) titlesByUrl.set(url, new Set());
    titlesByUrl.get(url).add(t);
  }
  // group unflagged files by exact dated page
  const groups = new Map();
  for (const f of files || []) {
    if (!f || f.flagged) continue;
    const p = tbDatedPage(f.url);
    if (!p) continue;
    const k = pageKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...f, page: p });
  }
  const repairs = [];
  const unresolved = [];
  for (const group of groups.values()) {
    const showIds = [...new Set(group.map((f) => f.showId))];
    if (showIds.length < 2) continue;
    const url = normalizeTbUrl(group[0].url);
    const titles = showIds.map((id) => titleOf.get(id));
    if (titles.some((t) => !t) || new Set(titles).size < showIds.length) {
      unresolved.push({ url, showIds, why: 'shows share a title or lack one (two productions of one show?); not auto-resolved' });
      continue;
    }
    const ownerTitles = titlesByUrl.get(url);
    if (!ownerTitles || ownerTitles.size !== 1) {
      unresolved.push({ url, showIds, why: ownerTitles ? 'index lists this page under several titles' : 'index does not list this page' });
      continue;
    }
    const [ownerTitle] = [...ownerTitles];
    const owners = showIds.filter((id) => titleOf.get(id) === ownerTitle);
    if (owners.length !== 1) {
      unresolved.push({ url, showIds, why: 'index owner title matches none of the colliding shows' });
      continue;
    }
    for (const showId of showIds) {
      if (showId === owners[0]) continue;
      const dests = [...(urlsByTitle.get(titleOf.get(showId)) || [])]
        .filter((u) => { const p = tbDatedPage(u); return p && p.date === group[0].page.date && pageKey(p) !== pageKey(group[0].page); });
      if (dests.length !== 1) {
        unresolved.push({ url, showIds: [showId], why: dests.length ? 'index lists this show at several same-day pages' : 'index has no other same-day page for this show' });
        continue;
      }
      for (const f of group.filter((x) => x.showId === showId)) {
        repairs.push({ showId, file: f.file, from: f.url, to: dests[0], evidence: `index: "${ownerTitle}" -> ${url}; "${titleOf.get(showId)}" -> ${dests[0]}` });
      }
    }
  }
  return { repairs, unresolved };
}

/**
 * Apply planned repairs through the approved review-field-edit path (its guards, lock and
 * collision checks run per edit). Returns one result per repair.
 */
function applyTbDatedCollisionRepairs(reviewTextsDir, repairs, { fixId, executeIn } = {}) {
  const exec = executeIn || require('./review-field-edit').executeReviewFieldEditIn;
  return repairs.map((r) => {
    const res = exec(reviewTextsDir, {
      type: 'review-field-edit', file: `${r.showId}/${r.file}`, field: 'url',
      oldValue: r.from, newValue: r.to,
      description: `TB dated-page collision repair from TB's own index (${r.evidence})`,
    }, { fixId: fixId || 'tb-dated-collision', at: new Date().toISOString() });
    return { ...r, ok: !!(res && res.ok), msg: res && (res.msg || res.reason) };
  });
}

/** Every talkinbroadway-- review file in the corpus; `flagged` mirrors tbDatedPageHeldByOtherShow's exclusions. */
function loadTbReviewFiles(reviewTextsDir, fsImpl) {
  const fs = fsImpl || require('fs');
  const path = require('path');
  const { isReviewTextFile } = require('./review-text-sidecars');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(reviewTextsDir); } catch { return out; }
  for (const showId of dirs) {
    if (showId.startsWith('.')) continue;
    let names;
    try { names = fs.readdirSync(path.join(reviewTextsDir, showId)).filter((f) => f.startsWith('talkinbroadway--') && isReviewTextFile(f)); } catch { continue; }
    for (const file of names) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, showId, file), 'utf8')); } catch { continue; }
      if (!d || !d.url) continue;
      const flagged = !!(d.duplicateOf || d.wrongAttribution === true || d.wrongShow === true || d.isRoundupArticle === true
        || d.nonReview === true || d.isNonReview === true
        || (d.wrongProduction === true && !d.wrongProductionManualClear && !d.wrongProductionOverride));
      out.push({ showId, file, url: d.url, flagged });
    }
  }
  return out;
}

module.exports = { loadTbReviewFiles, planTbDatedCollisionRepairs, applyTbDatedCollisionRepairs };
