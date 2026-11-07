// Pages for the Gmail renewal routes (BRO-3712). Same inline shell as
// approve-fix/route.ts. reauthSetupPage is the one-time setup step shown when
// Google does not yet accept our callback URL.
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

const STYLE = `body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell(title: string, body: string, extraStyle = ''): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="robots" content="noindex"><title>${esc(title)} - Broadway Scorecard</title>
<style>${STYLE}${extraStyle}</style></head><body>${body}</body></html>`;
}

export function reauthPage(title: string, message: string, status = 200): Response {
  return new Response(shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`), { status, headers: HEADERS });
}

export function reauthSetupPage({ consoleUrl, redirectUri, continueUrl }: {
  consoleUrl: string;
  redirectUri: string;
  continueUrl: string;
}): Response {
  const style = `ol{max-width:480px;margin:0 auto 24px;padding-left:22px;text-align:left;color:rgba(255,255,255,0.85);font-size:16px;line-height:1.6;}
li{margin-bottom:14px;}.btn{display:inline-block;padding:12px 20px;border-radius:10px;background:#7c5cff;color:#fff;font-weight:600;text-decoration:none;font-size:16px;border:0;cursor:pointer;}
.btn.alt{background:rgba(255,255,255,0.12);}.copy{display:flex;gap:8px;margin-top:8px;}
.copy input{flex:1;min-width:0;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:#1a1a22;color:#fff;font-size:14px;}`;
  const body = `<h1>One-Time Setup</h1>
<p>Google needs to know this site may reconnect Gmail. This takes about a minute and is only needed once.</p>
<ol>
<li>Tap <b>Open Google settings</b>. Sign in with your Google account if asked.<br><br><a class="btn alt" href="${esc(consoleUrl)}" target="_blank" rel="noopener noreferrer">Open Google settings</a></li>
<li>Scroll down to <b>Authorized redirect URIs</b>, tap <b>Add URI</b>, and paste this address into the new empty box. Leave the address already listed there as it is.<br>Tap <b>Copy</b> to copy it:
<div class="copy"><input id="uri" readonly value="${esc(redirectUri)}" onclick="this.select()"><button class="btn alt" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('uri').value).then(()=>{this.textContent='Copied'})">Copy</button></div></li>
<li>Tap <b>Save</b>, then come back here.</li>
</ol>
<p><a class="btn" href="${esc(continueUrl)}">Continue</a></p>
<p>Google can take a few minutes to accept the new address. If Continue brings you back here, wait a minute and tap it again.</p>
<p>If Google then says the app is not verified, tap <b>Advanced</b> and continue: it is this site's own Google project.</p>`;
  return new Response(shell('One-Time Setup', body, style), { status: 200, headers: HEADERS });
}
