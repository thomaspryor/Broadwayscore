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

const NAMED_ENTITIES = { amp: '&', apos: "'", quot: '"', nbsp: ' ', lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
const decodeEntities = (s) => String(s || '')
  // Range-checked: String.fromCodePoint throws above 0x10FFFF (BRO-5261 S12).
  .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : m; })
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const c = parseInt(h, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : m; })
  // accented letters (&eacute; -> e) fold the same as the letter itself
  .replace(/&([a-z])(?:acute|grave|circ|uml|tilde|cedil|ring|slash);/gi, '$1')
  .replace(/&([a-z]+);/gi, (m, k) => (k.toLowerCase() in NAMED_ENTITIES ? NAMED_ENTITIES[k.toLowerCase()] : m));

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
    const after = decodeEntities(src.slice(end, stop).replace(/<[^>]*>/g, ' '));
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
    const name = fold(decodeEntities(r && r.criticName));
    if (!name || name === 'unknown' || !name.includes(' ')) return null;
    const hits = [];
    icons.forEach((ic, i) => {
      if (!used.has(i) && (ic.lead === name || ic.lead.startsWith(name + ' '))) hits.push(i);
    });
    // Same critic twice on the page (two outlets, or a repeated entry): fine
    // when every icon agrees, otherwise we cannot tell which is this review.
    if (hits.length === 0 || hits.some(i => icons[i].thumb !== icons[hits[0]].thumb)) return null;
    used.add(hits[0]);
    return icons[hits[0]].thumb;
  });
  if (byName.some(Boolean)) return byName;
  // No icon on the page is followed by a critic name (older/minimal markup):
  // fall back to order, but only when every entry came from the page's own
  // JSON-LD list (Method 2/3 additions are appended out of page order) and the
  // count is exact once the trailing "Average Rating" icon is set aside.
  const reviewIcons = icons.filter(ic => !ic.lead.startsWith('average rating'));
  const allPageOrder = list.every(r => !r || !r.source || r.source === 'bww-roundup');
  if (allPageOrder && reviewIcons.length > 0 && reviewIcons.length === list.length) return reviewIcons.map(ic => ic.thumb);
  return byName;
}

module.exports = { extractBwwThumbIcons, pairBwwThumbsByCritic };
