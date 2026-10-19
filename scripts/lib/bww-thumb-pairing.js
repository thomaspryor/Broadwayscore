'use strict';
// BWW Review Roundup thumbs are read from the page's icon <img>s and paired
// with the roundup's reviews by position (BRO-5674).
//
// The old flat filename scan counted every srcset repeat (5 hits per review
// on many pages) and paired whatever came out by position, so one count slip
// moved every later critic onto a neighbour's thumb. Other Desert Cities
// 2026: 20 hits for 19 reviews, 13 wrong thumbs (Variety's rave as Meh, Time
// Out's pan as Up). Over the 175 archived roundups with icons, 94 had a
// mismatch. Now: one entry per <img> tag (106 of 175 then match exactly), and
// pair only when the counts match. No thumb beats a wrong one.

const THUMB_FILE_RE = /(uptrans|middletrans|downtrans)\d*\.png|BigThumbs_(UP|MEH|DOWN)\.(?:gif|png)/i;

function thumbFromFile(m) {
  const key = (m[1] || m[2] || '').toLowerCase();
  if (key === 'uptrans' || key === 'up') return 'Up';
  if (key === 'middletrans' || key === 'meh') return 'Meh';
  if (key === 'downtrans' || key === 'down') return 'Down';
  return null;
}

/** Ordered review thumbs ('Up' | 'Meh' | 'Down'), one per review icon <img>. */
function extractBwwThumbIcons(html) {
  const out = [];
  const imgRe = /<img\b[^>]*>/gi;
  let tag;
  while ((tag = imgRe.exec(html || '')) !== null) {
    const m = tag[0].match(THUMB_FILE_RE);
    if (!m) continue;
    const t = thumbFromFile(m);
    if (t) out.push(t);
  }
  return out;
}

function shouldPairBwwThumbs(iconCount, reviewCount) {
  return iconCount > 0 && iconCount === reviewCount;
}

module.exports = { extractBwwThumbIcons, shouldPairBwwThumbs };
