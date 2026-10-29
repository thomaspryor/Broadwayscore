#!/usr/bin/env node
// BRO-6516 step 1: build the UK regional production list from the census snapshot.
const fs = require('fs');
const path = require('path');
const { buildList } = require('./lib/uk-regional-list');
const dir = path.join(__dirname, '..', 'data', 'audit', 'uk-regional');
const items = JSON.parse(fs.readFileSync(path.join(dir, 'census-input-2024plus.json'), 'utf8'));
const list = buildList(items);
fs.writeFileSync(path.join(dir, 'production-list.json'), JSON.stringify(list, null, 1));
const byHub = {};
for (const p of list) byHub[p.hub] = (byHub[p.hub] || 0) + 1;
console.log(`productions: ${list.length}`, byHub);
console.log(`with >=2 reviews: ${list.filter((p) => p.reviews.length >= 2).length}`);
