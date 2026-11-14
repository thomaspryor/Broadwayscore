/**
 * Pure formatting for scripts/sentry-issue-report.js: turns a Sentry event into
 * printable text with share tokens, URL queries, JWTs and emails masked.
 */
/** Path only: no query/hash (OAuth tokens live there), share tokens masked. */
function safePath(url) {
  if (!url) return '';
  let p = String(url);
  try { p = new URL(p).pathname; } catch { p = p.split(/[?#]/)[0]; }
  return p.replace(/\/(plans|seen)\/[^/]+/g, '/$1/:token');
}

function safeText(s, max = 160) {
  return String(s ?? '')
    .replace(/\/(plans|seen)\/[^/?#\s"'<>]+/g, '/$1/:token')
    .replace(/\b(access_token|refresh_token|provider_token|provider_refresh_token|id_token|code|token|state)=[^&#\s"']+/gi, '$1=:redacted')
    .replace(/(https?:\/\/[^\s?#"']+)[?#]\S*/g, '$1')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, ':jwt')
    .replace(/\bBearer\s+\S+/gi, 'Bearer :redacted')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ':email')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function frameLine(f) {
  const file = safePath(f.filename || f.absPath || '?').replace(/^\/_next\/static\//, '');
  const where = `${file}:${f.lineNo ?? f.lineno ?? '?'}:${f.colNo ?? f.colno ?? '?'}`;
  return `${f.inApp ? '*' : ' '} ${safeText(f.function || '?', 60)}  ${where}`;
}

function summarizeEvent(ev) {
  const out = [];
  const exc = ev.entries?.find(e => e.type === 'exception')?.data?.values || [];
  // values are cause-first; the exception actually thrown is last.
  for (const v of exc.slice(-2).reverse()) {
    out.push(`  exception: ${v.type}: ${safeText(v.value)}`);
    const frames = v.stacktrace?.frames || [];
    // Sentry orders oldest-first; the crash site is the end.
    const top = frames.slice(-10).reverse();
    out.push(`  frames (${frames.length} total, newest first, * = in-app):`);
    for (const f of top) out.push(`    ${frameLine(f)}`);
    // Recursion: show the repeating pair rather than 10 identical frames.
    if (/call stack|too much recursion/i.test(v.value || '') && frames.length) {
      const counts = {};
      for (const f of frames) {
        const k = `${f.function || '?'} @ ${safePath(f.filename || f.absPath)}:${f.lineNo ?? f.lineno ?? '?'}`;
        counts[k] = (counts[k] || 0) + 1;
      }
      const rep = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
      out.push('  most repeated frames:');
      for (const [k, n] of rep) out.push(`    x${n}  ${k}`);
    }
  }
  const tag = k => ev.tags?.find(t => t.key === k)?.value;
  const req = ev.entries?.find(e => e.type === 'request')?.data;
  out.push(`  page: ${safePath(req?.url || ev.tags?.find(t => t.key === 'url')?.value)}`);
  out.push(`  browser: ${tag('browser') || '?'} | os: ${tag('os') || '?'} | device: ${tag('device') || tag('device.family') || '?'} | release: ${tag('release') || '?'}`);
  const crumbs = ev.entries?.find(e => e.type === 'breadcrumbs')?.data?.values || [];
  if (crumbs.length) {
    out.push('  last breadcrumbs:');
    for (const b of crumbs.slice(-6)) {
      const msg = b.message || safePath(b.data?.url) || safePath(b.data?.to) || '';
      out.push(`    ${b.category || b.type}: ${safeText(msg, 100)}`);
    }
  }
  const ctx = ev.contexts || {};
  if (ev.tags?.length) {
    const ugc = ev.tags.filter(t => t.key.startsWith('ugc_')).map(t => `${t.key}=${t.value}`);
    if (ugc.length) out.push(`  ugc tags: ${safeText(ugc.join(' '))}`);
  }
  if (ctx.browser?.name === undefined && !tag('browser')) out.push('  (no browser context)');
  return out.join('\n');
}

module.exports = { safePath, safeText, frameLine, summarizeEvent };
