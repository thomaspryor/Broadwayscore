#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const reviewDir = path.join(__dirname, "../data/review-texts");
const shows = fs.readdirSync(reviewDir).filter(f =>
  fs.statSync(path.join(reviewDir, f)).isDirectory()
);

const freeOutlets = ["theatrely", "cititour", "stageandcinema", "newyorktheater", "new-york-theater", "culture-sauce", "ny-stage-review", "stage-and-cinema"];

let needsScraping = [];

for (const show of shows) {
  const showPath = path.join(reviewDir, show);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith(".json"));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showPath, file), "utf8"));
      const outletLower = (data.outletId || "").toLowerCase();
      const url = data.url || "";

      const isFreeOutlet = freeOutlets.some(o => outletLower.includes(o)) ||
        url.includes("theatrely.com") ||
        url.includes("cititour.com") ||
        url.includes("stageandcinema.com") ||
        url.includes("newyorktheater.me") ||
        url.includes("culturesauce.co");

      if (isFreeOutlet && data.isFullReview !== true && url) {
        needsScraping.push({
          show: show,
          file: file,
          outlet: data.outlet,
          url: url
        });
      }
    } catch (e) {}
  }
}

console.log("=== FREE OUTLETS NEEDING SCRAPING ===");
console.log("Count:", needsScraping.length);
console.log("");
needsScraping.forEach(r => {
  console.log(r.show + "/" + r.file);
  console.log("  " + r.url);
});
