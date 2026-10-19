'use strict';
// BWW Review Roundup thumbs (BRO-5674).
//
// Each review on a roundup page is an icon <img> followed by
// "Critic, Outlet: excerpt". The old code collected every icon filename in the
// page and paired them with the JSON-LD BlogPosting list by index. That broke
// three ways:
//   - srcset lists each icon up to 5 times inside one <img>;
//   - the page ends with an extra "Average Rating" icon;
//   - on live-updating roundups the JSON-LD order differs from page order.
// Other Desert Cities 2026 got 13 wrong thumbs of 19 (Variety's rave as Meh,
// Time Out's pan as Up). So: one entry per <img>, and each review takes the
// icon whose following text names its critic. No thumb beats a wrong one.

const THUMB_FILE_RE = /(uptrans|middletrans|downtrans)\d*\.png|BigThumbs_(UP|MEH|DOWN)\.(?:gif|png)/i;

function thumbFromFile(m) {
  const key = (m[1] || m[2] || '').toLowerCase();
  if (key === 'uptrans' || key === 'up') return 'Up';
  if (key === 'middletrans' || key === 'meh') return 'Meh';
  if (key === 'downtrans' || key === 'down') return 'Down';
  return null;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Review icons in page order: { thumb, lead } where lead is the folded text right after the icon. */
function extractBwwThumbIcons(html, { leadChars = 160 } = {}) {
  const out = [];
  const src = html || '';
  const imgRe = /<img\b[^>]*>/gi;
  let tag;
  while ((tag = imgRe.exec(src)) !== null) {
    const m = tag[0].match(THUMB_FILE_RE);
    if (!m) continue;
    const thumb = thumbFromFile(m);
    if (!thumb) continue;
    const end = tag.index + tag[0].length;
    // Cut at the next tag-open after the window so a half tag never leaks in.
    let stop = end + leadChars * 4;
    const nextLt = src.indexOf('<', stop);
    if (nextLt !== -1 && nextLt - stop < 2000) stop = nextLt;
    const after = src.slice(end, stop).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
    out.push({ thumb, lead: fold(after).slice(0, leadChars) });
  }
  return out;
}

/**
 * Thumb per review, from the icon whose following text opens with the
 * review's critic name. Aligned with `reviews`; null = no confident match.
 * An icon is used once; a name matching two unused icons gets nothing.
 */
function pairBwwThumbsByCritic(icons, reviews) {
  const list = reviews || [];
  const used = new Set();
  const byName = list.map((r) => {
    const name = fold(r && r.criticName);
    if (!name || name === 'unknown' || !name.includes(' ')) return null;
    const hits = [];
    icons.forEach((ic, i) => { if (!used.has(i) && ic.lead.startsWith(name)) hits.push(i); });
    if (hits.length !== 1) return null;
    used.add(hits[0]);
    return icons[hits[0]].thumb;
  });
  if (byName.some(Boolean)) return byName;
  // No icon on the page is followed by a critic name (older/minimal markup):
  // fall back to order, but only on an exact count once the trailing
  // "Average Rating" icon is set aside.
  const reviewIcons = icons.filter(ic => !ic.lead.startsWith('average rating'));
  if (reviewIcons.length > 0 && reviewIcons.length === list.length) return reviewIcons.map(ic => ic.thumb);
  return byName;
}

module.exports = { extractBwwThumbIcons, pairBwwThumbsByCritic };
