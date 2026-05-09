#!/usr/bin/env node
/**
 * Re-verify contentVerificationPromoted reviews against their stored fullText.
 *
 * Problem: contentVerification may have been run on re-scraped URL content that
 * differs from the stored fullText. This script re-verifies using the STORED
 * fullText and updates the contentVerification + adds contentHash.
 *
 * Only processes files where:
 * - wrongShow === true (currently excluded from scoring)
 * - contentVerificationPromoted exists (set by rebuild)
 * - fullText exists and is >500 chars
 * - No contentHash (legacy verification)
 */

const fs = require("fs");
const path = require("path");
const { verifyContent, contentHash } = require("./lib/content-verifier");
const { isLondonMarket } = require("./lib/venue-classification");

const dir = path.join(__dirname, "..", "data", "review-texts");
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "shows.json"), "utf8"));
const showTitleMap = {};
const showTypeMap = {};
const showCategoryMap = {};
const showById = {}; // Full show entries — needed by verifyContent for named-entity bypass
for (const s of showsData.shows) {
  showTitleMap[s.id] = s.title;
  showTypeMap[s.id] = s.type;
  showCategoryMap[s.id] = s.category;
  showById[s.id] = s;
}

async function main() {
  const candidates = [];

  for (const show of fs.readdirSync(dir)) {
    const showPath = path.join(dir, show);
    if (!fs.statSync(showPath).isDirectory()) continue;

    for (const file of fs.readdirSync(showPath)) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(showPath, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (data.wrongShow === true &&
            data.contentVerificationPromoted &&
            data.fullText && data.fullText.length > 500 &&
            (!data.contentVerification || !data.contentVerification.contentHash)) {
          candidates.push({ showId: show, file, filePath, data });
        }
      } catch (e) {}
    }
  }

  console.log(`Found ${candidates.length} candidates for re-verification\n`);

  let fixed = 0;
  let confirmed = 0;
  let errors = 0;

  for (const c of candidates) {
    const showTitle = showTitleMap[c.showId] || c.showId;
    const outletCritic = c.file.replace(".json", "").split("--");
    const outletName = outletCritic[0] || "unknown";
    const criticName = outletCritic[1] || "unknown";

    // Determine market from show category. Opera shows (type='opera') get the
    // 'opera' market in marketConfig — Met is canonical venue. Without this,
    // Met opera reviews get false-positive wrongProduction flags.
    let market = "broadway";
    if (showTypeMap[c.showId] === 'opera') market = 'opera';
    else if (showCategoryMap[c.showId]) market = showCategoryMap[c.showId];
    else if (c.showId.includes("off-west-end")) market = "off-west-end";
    else if (c.showId.includes("west-end")) market = "west-end";
    else if (c.showId.includes("off-broadway")) market = "off-broadway";

    console.log(`Verifying: ${c.showId}/${c.file}`);
    console.log(`  Show: "${showTitle}" | Outlet: ${outletName} | Critic: ${criticName}`);
    console.log(`  fullText: ${c.data.fullText.length} chars`);
    console.log(`  Old CV issues: ${JSON.stringify(c.data.contentVerification?.issues || [])}`);

    try {
      const result = await verifyContent({
        scrapedText: c.data.fullText,  // KEY: verify the STORED fullText, not a re-scrape
        excerpt: c.data.bwwExcerpt || c.data.dtliExcerpt || "",
        showTitle,
        outletName,
        criticName,
        openingDate: c.data.publishDate,
        market,
        // Pass show metadata so applyTemporalOverrides can fire the named-entity bypass
        // (Hamlet 2026-05-08 FRC class). See review-guards.js:hasNamedDifferentDirectorSignal.
        show: showById[c.showId] || null,
      });

      console.log(`  New result: isValid=${result.isValid}, wrongArticle=${result.wrongArticle}, wrongProduction=${result.wrongProduction}`);
      console.log(`  New issues: ${JSON.stringify(result.issues)}`);

      // Update the contentVerification with new result (verified against stored fullText)
      c.data.contentVerification = {
        ...result,
        verifiedAt: new Date().toISOString(),
        reverifiedFrom: "stored-fullText",
        previousVerification: c.data.contentVerification ? {
          issues: c.data.contentVerification.issues,
          reasoning: c.data.contentVerification.reasoning,
          verifiedBy: c.data.contentVerification.verifiedBy,
          verifiedAt: c.data.contentVerification.verifiedAt
        } : null
      };

      // If the new verification says the content IS valid, clear wrongShow
      if (result.isValid && !result.wrongArticle && !result.wrongProduction && !result.isFilmTv) {
        console.log(`  >>> CLEARING wrongShow — fullText is valid!`);
        c.data.wrongShow = false;
        c.data.wrongShowAutoCleared = "reverify: stored fullText verified as valid by LLM";
        c.data.wrongShowAutoClearedAt = new Date().toISOString().split("T")[0];
        delete c.data.contentVerificationPromoted;
        fixed++;
      } else {
        // Verification still says wrong — update but keep wrongShow
        console.log(`  Confirmed wrongShow (verification correct)`);
        confirmed++;
      }

      fs.writeFileSync(c.filePath, JSON.stringify(c.data, null, 2) + "\n");
      console.log("");

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      console.log(`  ERROR: ${e.message}\n`);
      errors++;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total candidates: ${candidates.length}`);
  console.log(`Fixed (wrongShow cleared): ${fixed}`);
  console.log(`Confirmed (wrongShow correct): ${confirmed}`);
  console.log(`Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
