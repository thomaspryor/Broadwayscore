/**
 * newsletter-show-card — the table shell for a newsletter show card.
 *
 * Layout: row 1 is [poster] [title/pills/meta] [score]; the Critics' Take
 * teaser, when present, gets its OWN full-width row underneath (colspan=3).
 *
 * Why (owner, 2026-11-02, iPhone screenshot of the Oct 26 weekly): the take
 * used to sit inside the middle column, which on a phone is ~170px wide once
 * the 96px poster and 92px score columns are taken. A 70-char teaser wrapped
 * to 7-8 lines of 2-3 words each and made every card roughly twice as tall as
 * its poster. Spanning all three columns gives the take the full card width
 * in every client (no media query needed, so Gmail iOS behaves the same as
 * Apple Mail).
 *
 * Second report (owner, 2026-11-15, small iPhone, West End weekly): the fixed
 * 96px poster column and 92px score column still left the info column ~90px
 * wide at 320-375px. "OFF WEST END" wrapped to three lines, titles to four and
 * the date/venue to four more, so cards ran 250-346px tall. The side columns
 * are now POSTER_COL_W / SCORE_COL_W (64px poster, 74px score content) and every pill
 * is nowrap. The multi-width gate (scripts/newsletter/mobile-layout-check.mjs)
 * renders the real email at 320/360/375/390/430px and fails on a squished
 * info column or a tall card, so this cannot regress silently.
 */

// Shared with generate.mjs (showRow) so the poster image and the columns that
// frame it cannot drift apart. Poster is 2:3.
const POSTER_W = 64;
const POSTER_H = 96;
// Column widths are CONTENT widths: a td's width attribute excludes its padding,
// so the poster column renders POSTER_W + 12 (left padding) and the score column
// SCORE_COL_W + 10 (right padding). (Sized as 76 + 76 first, they rendered 88 and
// 86 and squeezed the info column: ship-check, 2026-11-15.)
const POSTER_COL_W = POSTER_W;
const SCORE_COL_W = 74;  // fits the 9px "Audience: A+" chip (~73px) so the cell never grows past it
const SCORE_BADGE = 56;

const CARD_STYLE = 'background:#1a1a24;border-radius:16px;border:1px solid rgba(255,255,255,0.05);box-shadow:0 2px 8px -2px rgba(0,0,0,0.5);margin-bottom:10px;';

/**
 * Inner HTML of the Critics' Take line (label + teaser + optional link).
 * Returns '' when there is no take.
 */
function criticsTakeHtml(take, href) {
  if (!take) return '';
  const readMore = href
    ? ` <a href="${href}" style="color:#d4a574;font-weight:600;text-decoration:none;white-space:nowrap;">Read more&nbsp;&rarr;</a>`
    : '';
  return `<span style="color:#d4a574;font-weight:700;">Critics&#8217; Take&nbsp;&nbsp;</span>${take}${readMore}`;
}

/**
 * Font size (px) for a show card's title. A 77-character regional title
 * ("Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity
 * West") wrapped to seven 16px lines in the ~117px info column at 320px, made
 * its card 334px tall and failed the mobile gate, so the 2026-11-22 New York
 * preview never reached the owner. Very long titles step down in size instead
 * of being cut: pre-send-check and the subject writer look for the FULL title
 * in the rendered email (newsletter-render-invariants.js, buildSubjectFacts),
 * so a truncated card title would fail those or drop the show from the subject.
 * @param {string} title
 * @returns {number}
 */
function cardTitleFontSize(title) {
  const n = String(title || '').trim().length;
  if (n > 90) return 12;
  if (n > 55) return 13;
  return 16;
}

/**
 * @param {object} p
 * @param {string} p.posterHtml  poster/thumbnail markup
 * @param {string} p.infoHtml    title, pills, date and venue lines
 * @param {string} p.scoreColHtml complete `<td>` for the score column
 * @param {string} [p.takeHtml]  output of criticsTakeHtml(); '' for none
 */
function showCardHtml({ posterHtml, infoHtml, scoreColHtml, takeHtml = '' }) {
  const takeRow = takeHtml
    ? `
    <tr>
      <td colspan="3" style="padding:0 12px 12px 12px;">
        <div style="font-size:13px;color:#c7cbd4;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);line-height:1.45;">${takeHtml}</div>
      </td>
    </tr>`
    : '';
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" data-show-card="1" style="${CARD_STYLE}">
    <tr>
      <td valign="top" width="${POSTER_COL_W}" style="padding:12px 0 12px 12px;">${posterHtml}</td>
      <td valign="top" style="padding:12px 6px 12px 10px;overflow-wrap:anywhere;word-break:break-word;">${infoHtml}
      </td>
      ${scoreColHtml}
    </tr>${takeRow}
  </table>`;
}

module.exports = { showCardHtml, cardTitleFontSize, criticsTakeHtml, POSTER_W, POSTER_H, POSTER_COL_W, SCORE_COL_W, SCORE_BADGE };
