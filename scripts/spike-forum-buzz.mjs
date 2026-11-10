#!/usr/bin/env node
// BRO-7329 forum feasibility spike: can fetchPage() read the BroadwayWorld message board and
// Talkin' Broadway "All That Chat" well enough to count threads/posts about an upcoming show?
// Read-only, prints a verdict per (forum, show). No data is written.
// Usage: node scripts/spike-forum-buzz.mjs [--shows=downstate,much ado about nothing]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchPage } = require('./lib/scraper.js');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const SHOWS = arg('shows', 'Downstate,Much Ado About Nothing').split(',');
const T = (u) => u;
const FORUMS = [
  { name: 'BroadwayWorld board', urls: (q) => [T(`https://www.broadwayworld.com/board/search.php?q=${encodeURIComponent(q)}`), T('https://www.broadwayworld.com/board/')] },
  { name: "Talkin' Broadway All That Chat", urls: (q) => [T(`https://www.talkinbroadway.com/allthatchat/search.php?keywords=${encodeURIComponent(q)}`), T('https://www.talkinbroadway.com/allthatchat/')] },
];
const strip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

for (const f of FORUMS) {
  for (const show of SHOWS) {
    for (const url of f.urls(show)) {
      const row = { forum: f.name, show, url };
      try {
        const r = await fetchPage(url, { skipVerify: true });
        const text = strip(r.content);
        const mentions = (text.match(new RegExp(show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
        console.log(JSON.stringify({ ...row, ok: true, via: r.source, bytes: r.content.length, mentions, loginWall: /log in|sign in to view|register to view/i.test(text) && mentions === 0 }));
      } catch (e) {
        console.log(JSON.stringify({ ...row, ok: false, error: String(e.message).slice(0, 160) }));
      }
    }
  }
}
