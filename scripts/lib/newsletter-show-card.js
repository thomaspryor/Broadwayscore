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
 */

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
      <td colspan="3" style="padding:0 16px 14px 16px;">
        <div style="font-size:13px;color:#c7cbd4;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);line-height:1.45;">${takeHtml}</div>
      </td>
    </tr>`
    : '';
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1a1a24" style="${CARD_STYLE}">
    <tr>
      <td valign="top" width="96" style="padding:12px 0 12px 16px;">${posterHtml}</td>
      <td valign="top" style="padding:12px 8px 12px 12px;">${infoHtml}
      </td>
      ${scoreColHtml}
    </tr>${takeRow}
  </table>`;
}

module.exports = { showCardHtml, criticsTakeHtml };
