// Owner-only box for the [DRAFT] preview email (BRO-7168, option A): the
// subject the system picked plus its runners-up, so the owner can swap one in
// by hand in Resend. send-test.mjs adds it to the PREVIEW only; the Resend
// broadcast draft never gets it.
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function subjectAlternatesBox(meta) {
  const alts = (meta && Array.isArray(meta.subjectAlternates)) ? meta.subjectAlternates.filter(a => a && a.subject) : [];
  if (!alts.length || !meta.subjectWriter || meta.subjectWriter.writer !== 'ai') return '';
  const row = (label, a) => `<tr><td style="padding:6px 0;font:13px/1.45 -apple-system,Segoe UI,Arial,sans-serif;color:#111;">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${esc(label)}</div>
    <div style="font-weight:700;">${esc(a.subject)}</div>
    ${a.preheader ? `<div style="color:#4b5563;">${esc(a.preheader)}</div>` : ''}</td></tr>`;
  return `<!--subject-alternates--><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fff7d6;border-bottom:2px solid #f5c542;"><tr><td style="padding:14px 18px;">
  <div style="font:700 13px -apple-system,Segoe UI,Arial,sans-serif;color:#111;">Only in your preview: subject line options</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
  ${row(`In the draft${meta.subjectWriter.angle ? ` (${meta.subjectWriter.angle})` : ''}`, { subject: meta.subject, preheader: '' })}
  ${alts.map((a, i) => row(`Option ${i + 2}${a.angle ? ` (${a.angle})` : ''}`, a)).join('')}
  </table>
  <div style="font:12px -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;margin-top:6px;">Prefer another? Paste it into the subject field in Resend before sending. Subscribers never see this box.</div>
</td></tr></table><!--/subject-alternates-->`;
}

// Insert after the real <body id="body"> and its hidden preheader div. The
// comment above <body> contains a literal "<body>", so a bare /<body>/ match
// would land inside that comment (review, 2026-11-08). Unchanged if not found.
export function injectSubjectBox(html, box) {
  const m = String(html).match(/<body id="body"[^>]*>\s*(?:<div style="display:none[\s\S]*?<\/span><\/div>)?/);
  if (!m || !box) return html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + box + html.slice(at);
}
