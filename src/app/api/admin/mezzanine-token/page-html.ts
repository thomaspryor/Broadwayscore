// Pages for the Mezzanine session-token renewal (BRO-5235). Same inline shell
// as gmail-reauth/page-html.ts. Referrer-Policy is same-origin, not
// no-referrer: under no-referrer Safari sends `Origin: null` on the form POST,
// and the route's same-origin check needs the real Origin.
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `body{margin:0;padding:32px 16px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
main{max-width:520px;margin:0 auto;}h1{font-size:24px;margin:0 0 16px;text-align:center;}h2{font-size:18px;margin:28px 0 10px;}
p{color:rgba(255,255,255,0.75);font-size:16px;line-height:1.6;margin:0 0 16px;}
ol{margin:0 0 8px;padding-left:24px;color:rgba(255,255,255,0.88);font-size:16px;line-height:1.55;}li{margin-bottom:10px;}
a{color:#a996ff;}b{color:#fff;}
textarea{box-sizing:border-box;width:100%;min-height:120px;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.25);background:#1a1a22;color:#fff;font-size:16px;font-family:ui-monospace,Menlo,monospace;}
.btn{display:block;width:100%;margin-top:12px;padding:14px 20px;border-radius:10px;background:#7c5cff;color:#fff;font-weight:600;font-size:17px;border:0;}
.err{padding:12px;border-radius:10px;background:rgba(255,80,80,0.15);color:#ffb4b4;margin-bottom:16px;}
.note{font-size:14px;color:rgba(255,255,255,0.6);}`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="robots" content="noindex"><title>${esc(title)} - Broadway Scorecard</title>
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

// Step lists are trusted HTML snippets from scripts/lib/mezzanine-token-renewal.js.
function list(steps: string[], start = 1): string {
  return `<ol start="${start}">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
}

export function tokenPage(title: string, message: string, status = 200): Response {
  return new Response(shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`), { status, headers: HEADERS });
}

export function tokenFormPage({ action, e, s, appUrl, setup, capture, cleanup, error }: {
  action: string;
  e: string;
  s: string;
  appUrl: string;
  setup: string[];
  capture: string[];
  cleanup: string[];
  error?: string;
}, status = 200): Response {
  // The page reloads at the top after a refused paste, so the reason shows there too.
  const banner = error ? `<div class="err" role="alert">${esc(error)} The box is near the bottom of this page.</div>` : '';
  const body = `<h1>Reconnect Mezzanine</h1>
${banner}
<p>Mezzanine audience ratings stopped because the app's sign-in code expired. It lasts about a year. This page takes about 10 minutes on your iPhone and needs no computer.</p>
<p class="note">Keep this page open in Safari. You switch between apps a few times, then come back here to paste.</p>
<h2>Part 1: set up Proxyman (one time)</h2>
<p class="note">Proxyman is a free app that shows what other apps on your phone send. <a href="${esc(appUrl)}" target="_blank" rel="noopener noreferrer">Open it in the App Store</a>.</p>
${list(setup)}
<h2>Part 2: copy the code</h2>
${list(capture, setup.length + 1)}
<form method="post" action="${esc(action)}" autocomplete="off">
${error ? `<div class="err">${esc(error)}</div>` : ''}
<input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="s" value="${esc(s)}">
<label for="token" class="note">Paste here</label>
<textarea id="token" name="token" required autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="r:..."></textarea>
<button class="btn" type="submit">Save</button>
</form>
<h2>Part 3: switch Proxyman off afterwards</h2>
${list(cleanup, setup.length + capture.length + 1)}
<p class="note">The code only lets the site read public Mezzanine ratings. It is stored as a locked secret and never shown again.</p>`;
  return new Response(shell('Reconnect Mezzanine', body), { status, headers: HEADERS });
}

export function tokenSavedPage(cleanup: string[]): Response {
  const body = `<h1>Thank You</h1>
<p>The code was received. The site checks it, saves it and refreshes the Mezzanine ratings by itself in the next few minutes.</p>
<p><b>Leave Proxyman set up until tomorrow.</b> If the code did not work, tomorrow morning's email has a new link, and you can copy the code again without setting anything up. No Mezzanine email tomorrow means it worked.</p>
<h2>Then switch Proxyman off</h2>
${list(cleanup)}`;
  return new Response(shell('Thank You', body), { status: 200, headers: HEADERS });
}
