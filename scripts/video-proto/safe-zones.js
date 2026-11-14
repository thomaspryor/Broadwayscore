// Per-channel safe zones (owner, 2026-11-01: "the TikTok videos look horrible, you did not account for the chrome
// around it"). Every app lays its own buttons and text over a vertical video: TikTok's search bar sat on our logo,
// its caption block sat on our burned-in captions, and its button column covered the right edge. So a video is
// rendered once per channel: the scene is scaled and placed inside that app's safe area, and the captions sit at the
// bottom of it, above the app's own caption text.
//
// Insets are in 1080x1920 output pixels. Neither TikTok nor Meta publishes organic safe zones; these take the
// cautious end of the 2026 creator guides (upload-post.com, adaptlypost.com, adkit.so) and were checked against the
// owner's TikTok screenshots (iPhone, 2026-11-01): search bar ends ~243px down, button column starts ~906px across,
// account name starts ~1680px down. Tall phones also crop ~40px off each side of a TikTok, hence the left margin.
const OUT_W = 1080, OUT_H = 1920, STAGE_W = 360, STAGE_H = 640, K = OUT_W / STAGE_W; // stage units are 1/3 output px

const ZONES = {
  // TikTok, measured on two owner screenshots (2026-11-01): search bar ends at 243px, button column starts at 906px
  // (and runs from 843px down to the bottom), account name starts at 1680px. Margins of ~45px top, ~36px right.
  tiktok: { top: 288, bottom: 450, left: 60, right: 210, label: 'TikTok' },
  instagram: { top: 220, bottom: 480, left: 60, right: 180, label: 'Instagram Reels' },
  facebook: { top: 220, bottom: 480, left: 60, right: 180, label: 'Facebook Reels' },
  youtube: { top: 200, bottom: 450, left: 60, right: 192, label: 'YouTube Shorts' },
};
const CHANNELS = Object.keys(ZONES);

// caption block: up to two lines of 25px type, bottom-anchored just above the safe line, and a gap above it
const CAP_H = 72, CAP_GAP = 8; // two 32px word lines plus a 4px lift off the safe line

/** A channel's safe area in stage units (360x640). */
function zone(channel) {
  const z = ZONES[channel];
  if (!z) throw new Error(`no safe zone for channel "${channel}" (have: ${CHANNELS.join(', ')})`);
  return { channel, label: z.label, top: z.top / K, bottom: STAGE_H - z.bottom / K, left: z.left / K, right: STAGE_W - z.right / K };
}

/**
 * Where the scene goes. bbox: union of everything the scene ever shows, in stage units ({left, top, right, bottom}).
 * Returns the transform that fits it, never enlarged, centred in the safe area above the caption block, plus the
 * caption box. withCaptions=false gives the scene the whole safe area (silent formats).
 */
function fit(bbox, channel, { withCaptions = true } = {}) {
  const z = zone(channel), capTop = withCaptions ? z.bottom - CAP_H : z.bottom;
  const availW = z.right - z.left, availH = (withCaptions ? capTop - CAP_GAP : z.bottom) - z.top;
  const bw = bbox.right - bbox.left, bh = bbox.bottom - bbox.top;
  if (!(bw > 0 && bh > 0)) throw new Error('scene has nothing visible to place');
  const s = Math.min(1, availW / bw, availH / bh);
  const x = z.left + (availW - bw * s) / 2 - bbox.left * s, y = z.top + (availH - bh * s) / 2 - bbox.top * s;
  return { s: +s.toFixed(4), x: +x.toFixed(2), y: +y.toFixed(2), zone: z, cap: withCaptions ? { left: z.left, right: z.right, top: capTop, bottom: z.bottom } : null };
}

/** The box a redesigned format lays itself out in: the safe area minus the caption block (stage units). */
function layout(channel, { withCaptions = true } = {}) {
  const z = zone(channel), bottom = withCaptions ? z.bottom - CAP_H - CAP_GAP : z.bottom;
  return { x: z.left, y: z.top, w: z.right - z.left, h: bottom - z.top };
}
// formats laid out straight into that box at full size (owner, 2026-11-01); the rest are shrunk to fit it
const NATIVE = new Set(['verdict', 'versus', 'compare']);

module.exports = { layout, NATIVE, ZONES, CHANNELS, CAP_H, CAP_GAP, STAGE_W, STAGE_H, OUT_W, OUT_H, zone, fit };
