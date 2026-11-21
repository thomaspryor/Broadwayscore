'use strict';

const https = require('https');

// Socket inactivity timeouts do not bound DNS, redirects, or trickling bodies.
// Keep one wall-clock deadline across the entire request and destroy its socket.
function cronHttpRequest(url, method = 'GET', options = {}) {
  const { timeout = 15000, maxBytes = 0, maxRedirects = 0,
    headers = { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
    request = https.request } = options;
  return new Promise((resolve, reject) => {
    let req;
    let res;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); res?.destroy(); req?.destroy(); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('HTTP wall-clock timeout')), timeout);
    const visit = (target, redirects) => {
      try {
        req = request(target, { method, headers, timeout }, response => {
          res = response;
          if (settled) { response.destroy(); return; }
          if (maxRedirects && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.destroy();
            if (redirects >= maxRedirects) { finish(new Error('HTTP redirect limit exceeded')); return; }
            try { visit(new URL(response.headers.location, target), redirects + 1); }
            catch (error) { finish(error); }
            return;
          }
          const result = { statusCode: response.statusCode, headers: response.headers, body: '' };
          if (method === 'HEAD') {
            finish(null, result);
            response.destroy();
            return;
          }
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            result.body += chunk;
            if (maxBytes > 0 && bytes >= maxBytes) {
              finish(null, result);
              response.destroy();
            }
          });
          response.on('end', () => finish(null, result));
          response.on('error', error => finish(error));
          response.on('aborted', () => finish(new Error('HTTP response aborted')));
        });
        req.on('error', error => finish(error));
        req.on('timeout', () => finish(new Error('HTTP socket timeout')));
        req.end();
      } catch (error) { finish(error); }
    };
    visit(url, 0);
  });
}

module.exports = { cronHttpRequest };
